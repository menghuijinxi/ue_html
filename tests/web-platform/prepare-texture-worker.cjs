const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const integer = process.argv.includes('--uint');
const source = path.join(__dirname, integer ? 'build/ue-texture-uint-shader' : 'build/ue-texture-shader');
const output = path.join(__dirname, integer ? 'build/ue-texture-uint-worker' : 'build/ue-texture-worker');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const host = read(path.join(source, integer ? 'texture-uint-shader-results.json' : 'texture-shader-results.json'));
const worker = read(path.join(source, 'worker/worker-results.json'));
const registration = read(path.join(source, 'platform-registration.json'));
const verification = read(path.join(__dirname, 'results/ue-shader-source-verification.json'));
const names = integer ? ['WebTextureUint_LoadCS', 'WebTextureUint_InspectCS'] :
  ['WebTexture3D_LoadCS', 'WebTexture3D_SampleCS'];
assert(host.pass && worker.pass && registration.pass);
assert(worker.officialFormatDiscovery && worker.officialPreprocessAndInputHash &&
  worker.officialWorkerFormatVersions && worker.badInputVersionRejected && worker.badFormatVersionRejected);
assert.deepEqual(host.cases.map(item => item.name).sort(), [...names].sort());
assert.deepEqual(worker.cases.map(item => item.name).sort(), [...names].sort());
fs.mkdirSync(output, {recursive: true});
const shaderPackets = names.map(name => {
  const item = host.cases.find(item => item.name === name);
  const compiled = worker.cases.find(item => item.name === name);
  assert(item.pass && item.nativeCompiled && item.probeOnlySource && item.elementFormat === 48 &&
    compiled.pass && compiled.compiled && compiled.parameterMapMatchesNative &&
    compiled.inputHashVerified && compiled.outputHashMatchesEditor);
  assert.equal(item.source, `/WebGPUProbe/Private/${integer ? 'WebTextureUintProbe' : 'WebTexture3DProbe'}.usf`);
  const file = path.join(source, 'worker', compiled.packet);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bytes, fs.readFileSync(path.join(source, 'worker', `${name}.editor.webshader`)));
  const packet = decode(bytes, registration);
  assert.equal(packet.metadata.frequency, 5);
  assert.equal(packet.metadata.formatVersion, worker.formatVersion);
  for (const binding of item.spirvBindings) {
    const actual = packet.metadata.spirvBindings.find(candidate => candidate.name === binding.name);
    assert(actual);
    for (const field of ['group', 'binding', 'descriptorType', 'size', 'paddedSize'])
      assert.equal(actual[field], binding[field]);
  }
  const volume = packet.metadata.spirvBindings.find(binding => binding.name === 'Volume');
  assert.equal(volume.descriptorType, 2);
  assert.equal(volume.textureDimension, 2);
  assert.equal(volume.textureArrayed, false);
  assert.equal(volume.textureMultisampled, false);
  assert.equal(volume.textureSampleType, integer ? 'uint' : 'float');
  const destination = packet.metadata.spirvBindings.find(binding => binding.name === 'Output');
  assert.equal(destination.descriptorType, 7);
  assert.equal(destination.storageElementFormat, 48);
  assert.equal(destination.storageElementStride, 16);
  assert.equal(destination.readOnlyStorage, false);
  assert(packet.wgsl.includes(integer ? 'texture_3d<u32>' : 'texture_3d<f32>'));
  const includes = item.includeFiles.map(virtual => {
    if (virtual.startsWith('/WebGPUProbe/')) {
      assert.equal(virtual, item.source);
      const file = path.join(root, 'tests/ue-shader-host/Shaders', virtual.slice('/WebGPUProbe/'.length));
      return {virtual, file, origin: 'probe-only', sha256: sha(file)};
    }
    const engine = virtual.replace(/^\/Engine\//, 'Engine/Shaders/');
    const verified = verification.verified.find(file => file.source === engine);
    assert(verified, `Unverified include ${virtual}`);
    const file = path.join(root, '.tools/ue58-verified-shaders', virtual.slice('/Engine/'.length));
    assert.equal(sha(file), verified.sha256);
    return {virtual, origin: 'target-engine', gitBlob: verified.gitBlob, sha256: verified.sha256};
  });
  const wgsl = path.join(source, `${name}.wgsl`);
  cp.execFileSync(path.join(root, '.tools/dawn-v20261009.190412/bin/tint.exe'),
    [path.join(source, `${name}.spv`), '--format', 'wgsl', '-o', wgsl]);
  assert.equal(packet.wgsl, fs.readFileSync(wgsl, 'utf8'));
  const outputFile = path.join(output, compiled.packet);
  fs.copyFileSync(file, outputFile);
  return {name, packet: outputFile, packetSha256: sha(outputFile), includes, probeOnlySource: true,
    nativeSpirvSha256: sha(path.join(source, `${name}.native.spv`)), wgslSha256: sha(wgsl)};
});
const probeSource = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebBufferShaderProbe.cpp');
const formatSource = path.join(root,
  'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp');
const report = {pass: true, date: '2026-10-15', targetEngineCommit: verification.revision,
  registration, worker, shaderPackets, probeSource, probeSourceSha256: sha(probeSource),
  formatSource, formatSourceSha256: sha(formatSource),
  boundary: `Two probe-only Texture3D ${integer ? 'uint4 Load/GetDimensions' : 'float4 Load/SampleLevel'} shaders using UE compile environment, native SPIR-V, real Worker IPC, and independent Tint. Full Renderer and browser engine are pending.`};
if (integer) {
  const float = read(path.join(__dirname, 'results/ue-texture-shader-build-results.json'));
  const packet = float.shaderPackets.find(shader => shader.name === 'WebTexture3D_LoadCS');
  assert(float.pass && packet && float.worker.formatVersion === worker.formatVersion);
  assert.equal(sha(packet.packet), packet.packetSha256);
  const destination = path.join(output, path.basename(packet.packet));
  fs.copyFileSync(packet.packet, destination);
  report.floatShaderPacket = {...packet, packet: destination};
}
fs.writeFileSync(path.join(__dirname, integer ? 'results/ue-texture-uint-shader-build-results.json' :
  'results/ue-texture-shader-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, shaders: shaderPackets.length,
  includesVerified: shaderPackets.map(shader => shader.includes.length)}));
