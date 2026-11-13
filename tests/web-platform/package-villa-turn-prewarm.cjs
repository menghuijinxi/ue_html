'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {readPage, writePage, replaceFile, coreFiles} = require('./web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const base = __dirname, source = path.join(base, 'build/villa-tsr-tiles-20261112');
const donor = path.join(base, 'build/villa-git-pages-20261113');
const output = assertProjectOutputTree(path.join(base, 'build/villa-tsr-turn-prewarm-20261113'));
assert(!fs.existsSync(output), 'Preserve existing diagnostic packages');
const parse = file => JSON.parse(fs.readFileSync(file));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const labels = [
  'main_00001dc0_c525be22 / main_00003aa4_79c6efa3',
  'main_00001f00_a30a26d4 / main_000045b0_769410c6',
  'main_00001bd8_e02fd6df / main_000009f4_2d0d1a47',
  'main_000007c0_d889bb5b / main_000004e8_31236922',
  'main_0000548c_25787371 / main_000110a4_f094ac0f',
  'main_00001d84_18961c06 / main_00001ac0_643db501',
  'main_000055bc_931ef210 / main_00005e8c_312b1082',
  'main_00001ec4_56192608 / main_00001a7c_b30566da',
];
const pack = parse(path.join(source, 'pipeline-prewarm.json'));
const recorded = parse(path.join(donor, 'pipeline-prewarm.json'));
assert.deepEqual(pack.devices, recorded.devices);
const label = descriptor => [descriptor.vertex?.entryPoint, descriptor.fragment?.entryPoint].filter(Boolean).join(' / ');
const selected = labels.map(name => {
  assert(!pack.descriptors.some(item => label(item.descriptor) === name));
  const match = recorded.descriptors.filter(item => item.kind === 'render' && label(item.descriptor) === name);
  assert.equal(match.length, 1); return match[0];
});
const sourceResources = new Map([...recorded.modules, ...recorded.layouts].map(item => [item.id, item]));
const selectedModules = new Set(selected.flatMap(item => [item.descriptor.vertex.module.id, item.descriptor.fragment.module.id]));
// Verify shader bytes against the target Cook, not just labels from another runtime.
const manifest = parse(path.join(source, 'content-files.json'));
const wanted = new Map([...selectedModules].map(id => [hash(sourceResources.get(id).descriptor.code), id]));
const shaderProof = [];
const fd = fs.openSync(path.join(source, manifest.pack.url), 'r');
const read = (offset, size) => {
  const bytes = Buffer.alloc(size); assert.equal(fs.readSync(fd, bytes, 0, size, offset), size); return bytes;
};
try {
  for (const file of manifest.files.filter(item => item.path.endsWith('.ushaderbytecode'))) {
    assert.equal(read(file.offset, 4).readUInt32LE(), 3);
    let cursor = 4; const arrays = {};
    for (const [name, stride] of [['mapHashes', 8], ['shaderHashes', 8], ['maps', 16], ['shaders', 17], ['preload', 16], ['indices', 4]]) {
      const count = read(file.offset + cursor, 4).readUInt32LE();
      assert(count > 0 && cursor + 4 + count * stride <= file.size);
      cursor += 4; arrays[name] = {count, offset: cursor}; cursor += count * stride;
    }
    const rows = read(file.offset + arrays.shaders.offset, arrays.shaders.count * 17);
    for (let index = 0; index < arrays.shaders.count; ++index) {
      const row = index * 17, start = Number(rows.readBigUInt64LE(row)), size = rows.readUInt32LE(row + 8);
      assert.equal(size, rows.readUInt32LE(row + 12), 'Require uncompressed Web shaders');
      const offset = file.offset + cursor + start;
      assert(cursor + start + size <= file.size);
      const header = read(offset, 28); assert.equal(header.readUInt32LE(), 0x53475057);
      const metadata = header.readUInt32LE(20), length = header.readUInt32LE(24);
      assert(28 + metadata + length <= size);
      const digest = hash(read(offset + 28 + metadata, length));
      if (wanted.has(digest)) shaderProof.push({moduleId: wanted.get(digest), sha256: digest, archive: file.path, shaderIndex: index});
    }
  }
} finally {fs.closeSync(fd);}
assert.equal(new Set(shaderProof.map(item => item.moduleId)).size, selectedModules.size,
  'All added WGSL modules must be byte-identical to target Cook shaders');
let next = Math.max(...pack.modules.map(item => item.id), ...pack.layouts.map(item => item.id));
const remapped = new Map(), original = structuredClone(pack);
function transfer(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(transfer);
  if (value.$gpu) {
    if (remapped.has(value.id)) return remapped.get(value.id);
    const resource = sourceResources.get(value.id); assert(resource && resource.$gpu === value.$gpu);
    const reference = {$gpu: resource.$gpu, id: ++next}; remapped.set(value.id, reference);
    const descriptor = transfer(resource.descriptor);
    pack[resource.$gpu === 'module' ? 'modules' : 'layouts'].push({...reference, descriptor});
    return reference;
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transfer(child)]));
}
for (const item of selected) pack.descriptors.push({...item, id: pack.descriptors.length + 1,
  deviceId: pack.devices[0].id, descriptor: transfer(item.descriptor)});
assert.deepEqual(pack.descriptors.slice(0, original.descriptors.length), original.descriptors);
assert.deepEqual(pack.descriptors.filter(item => item.kind === 'compute'), original.descriptors.filter(item => item.kind === 'compute'));
fs.mkdirSync(output);
for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
  if (!entry.isFile() || ['index.html', 'asset-versions.json', 'pipeline-prewarm.json'].includes(entry.name)) continue;
  fs.linkSync(path.join(source, entry.name), assertProjectOutput(path.join(output, entry.name)));
}
fs.copyFileSync(path.join(source, 'index.html'), assertProjectOutput(path.join(output, 'index.html')));
replaceFile(path.join(output, 'pipeline-prewarm.json'), JSON.stringify(pack));
const page = readPage(output);
page.assets.diagnosticOnly = true;
page.assets.diagnosticPrewarm = {kind: 'manual-turn-coverage', addedRenderPipelines: labels.length,
  donorWasm: recorded.wasm, originalPrewarm: audit(path.join(source, 'pipeline-prewarm.json')).sha256,
  boundary: 'Supplemented recorded graphics descriptors with WGSL verified against the target Cook. Not a same-runtime capture or an approved ordinary release.'};
page.assets.pipelinePrewarm.sha256 = audit(path.join(output, 'pipeline-prewarm.json')).sha256;
writePage(output, page);
const core = coreFiles.map(name => {
  const expected = audit(path.join(source, name)), actual = audit(path.join(output, name));
  assert.equal(actual.sha256, expected.sha256); return actual;
});
const products = fs.readdirSync(output).map(name => audit(path.join(output, name)));
writeVersions(output, products);
const report = {date: new Date().toISOString(), pass: true, diagnosticOnly: true,
  source, donor, output, core, originalPipelines: original.descriptors.length,
  supplementedPipelines: pack.descriptors.length, added: labels, shaderProof,
  unchangedComputePipelines: true, unchangedSourcePack: audit(path.join(source, 'pipeline-prewarm.json')),
  pack: audit(path.join(output, 'pipeline-prewarm.json')),
  boundary: page.assets.diagnosticPrewarm.boundary};
fs.writeFileSync(assertProjectOutput(path.join(base, 'results/villa-tsr-turn-prewarm-package.json')), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, added: labels.length, verifiedShaders: selectedModules.size, pipelines: pack.descriptors.length}));
