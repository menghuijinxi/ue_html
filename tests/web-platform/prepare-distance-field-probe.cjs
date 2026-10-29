const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const cookFile = path.join(__dirname, 'results/web-engine-webgpu-sm5-default-cook-results.json');
const cook = read(cookFile);
assert(cook.pass && cook.distanceFields && cook.shaderFailures.length === 0);
const directories = (process.argv.find(value => value.startsWith('--conversion='))?.slice(13) ||
  path.join(cook.output, 'ShaderConversion')).split(';');
const output = path.join(__dirname, 'build/ue-rhi-distance-field/CookShaders');
const tint = path.join(root, '.tools/dawn-v20261009.190412/bin/tint_info.exe');
fs.mkdirSync(output, {recursive: true});
const names = new Set(['FScatterUploadDistanceFieldAtlasCS', 'FClearReplacementVS', 'FClearReplacementPS']);
const shaders = [];
for (const directory of directories) for (const name of fs.readdirSync(directory)) {
  const file = path.join(directory, name, 'input.json');
  if (!fs.existsSync(file)) continue;
  const input = read(file);
  if (!names.has(input.shaderName)) continue;
  const wgsl = path.join(path.dirname(file), 'output.wgsl');
  const metadata = input.metadata;
  metadata.reflection = JSON.parse(cp.execFileSync(tint, ['--json', wgsl], {encoding: 'utf8'}));
  const entry = metadata.reflection.entry_points[0];
  assert.equal(entry.name, metadata.webEntry);
  if (input.shaderName === 'FScatterUploadDistanceFieldAtlasCS')
    assert.deepEqual(entry.workgroup_size, [4, 4, 4]);
  assert.equal(entry.bindings.length, metadata.spirvBindings.length);
  for (const binding of metadata.spirvBindings) {
    const reflected = entry.bindings.find(item => item.group === binding.group && item.binding === binding.binding);
    assert(reflected, binding.name);
    assert.equal(reflected.resource_type, binding.descriptorType === 6 ? 'UniformBuffer' :
      binding.descriptorType === 7 ? 'ReadOnlyStorageBuffer' : 'WriteOnlyStorageTexture');
    if (binding.descriptorType === 3) {
      assert.equal(binding.storageImageFormat, 15);
      assert.equal(reflected.image_format, 'R8Unorm');
    }
  }
  if (input.shaderName === 'FScatterUploadDistanceFieldAtlasCS') {
    const packed = metadata.spirvBindings.find(item => item.name === 'BrickUploadData');
    assert.equal(packed.storagePacking, 'unorm8x4');
    assert.equal(packed.storageElementStride, 4);
  }
  metadata.bindingContractVerified = true;
  const json = Buffer.from(JSON.stringify(metadata));
  const code = fs.readFileSync(wgsl);
  const header = Buffer.alloc(28);
  [0x53475057, 1, 28, metadata.frequency, metadata.formatVersion, json.length, code.length]
    .forEach((value, index) => header.writeUInt32LE(value, index * 4));
  const packet = Buffer.concat([header, json, code]);
  assert.equal(decode(packet).wgsl, code.toString());
  const target = path.join(output, input.shaderName + '.webshader');
  fs.writeFileSync(target, packet);
  shaders.push({name: input.shaderName, input: audit(file), wgsl: audit(wgsl), packet: audit(target)});
  names.delete(input.shaderName);
}
assert.equal(names.size, 0, 'Cook must expose the actual distance-field upload shader');
const cookSnapshot = path.join(output, 'cook-report.json');
fs.copyFileSync(cookFile, cookSnapshot);
fs.writeFileSync(path.join(output, 'preparation.json'), JSON.stringify({
  pass: true, cook: audit(cookSnapshot), tint: audit(tint), shaders,
  boundary: 'Diagnostic packet reconstructed from real Cook metadata and unchanged WGSL; native GPU RHI execution is verified separately.',
}, null, 2));
console.log(JSON.stringify({pass: true, shaders: shaders.map(item => item.name)}));
