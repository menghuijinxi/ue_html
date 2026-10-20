const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const source = path.join(__dirname, 'build/ue-buffer-shader');
const output = path.join(__dirname, 'build/ue-buffer-worker');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const host = read(path.join(source, 'buffer-shader-results.json'));
const worker = read(path.join(source, 'worker/worker-results.json'));
const registration = read(path.join(source, 'platform-registration.json'));
assert(host.pass && worker.pass && registration.pass);
assert(worker.officialFormatDiscovery && worker.officialPreprocessAndInputHash &&
  worker.officialWorkerFormatVersions && worker.badInputVersionRejected && worker.badFormatVersionRejected);
const names = ['WebR32Uint_MemcpyCS', 'WebR32Uint_MemsetBufferCS',
  'WebR32Uint4_MemcpyCS', 'WebR32Uint4_MemsetBufferCS', 'WebFloat4_TransformCS', 'WebFloat4_FillCS'];
assert.deepEqual(host.cases.map(item => item.name).sort(), [...names].sort());
assert.deepEqual(worker.cases.map(item => item.name).sort(), [...names].sort());
const sourceVerification = read(path.join(__dirname, 'results/ue-shader-source-verification.json'));
const tint = path.join(root, '.tools/dawn-v20261009.190412/bin/tint.exe');
fs.mkdirSync(output, {recursive: true});
const shaderPackets = names.map(name => {
  const item = host.cases.find(item => item.name === name);
  const compiled = worker.cases.find(item => item.name === name);
  const float4 = name.startsWith('WebFloat4_');
  assert.equal(item.source, float4 ? '/WebGPUProbe/Private/WebFloat4Probe.usf' : '/Engine/Private/ByteBuffer.usf');
  assert.equal(item.probeOnlySource, float4);
  assert(item.pass && item.nativeCompiled && compiled.pass && compiled.compiled &&
    compiled.parameterMapMatchesNative && compiled.inputHashVerified && compiled.outputHashMatchesEditor);
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
  const uint4 = name.startsWith('WebR32Uint4_');
  const elementFormat = float4 ? 1 : uint4 ? 48 : 28;
  const elementStride = uint4 || float4 ? 16 : 4;
  const suffix = uint4 ? '4x' : '1x';
  assert.equal(item.elementFormat, elementFormat);
  const destination = packet.metadata.spirvBindings.find(binding =>
    binding.name === (float4 ? 'DstFloat4' : `DstStructuredBuffer${suffix}`));
  assert.equal(destination.storageElementFormat, elementFormat);
  assert.equal(destination.readOnlyStorage, false);
  assert.equal(destination.descriptorType, 7);
  assert.equal(destination.storageElementStride, elementStride);
  if (name.endsWith('_MemcpyCS') || name.endsWith('_TransformCS')) {
    const input = packet.metadata.spirvBindings.find(binding =>
      binding.name === (float4 ? 'SrcFloat4' : `SrcStructuredBuffer${suffix}`));
    assert.equal(input.storageElementFormat, elementFormat);
    assert.equal(input.readOnlyStorage, true);
    assert.equal(input.descriptorType, 7);
    assert.equal(input.storageElementStride, elementStride);
  } else {
    assert.equal(packet.metadata.spirvBindings.length, 2);
    assert(packet.metadata.ueParameterMap.some(parameter => parameter.name === (float4 ? 'FillValue' : 'Value')));
  }
  const includes = item.includeFiles.map(virtual => {
    if (virtual.startsWith('/WebGPUProbe/')) {
      assert(float4 && virtual === '/WebGPUProbe/Private/WebFloat4Probe.usf');
      const file = path.join(root, 'tests/ue-shader-host/Shaders', virtual.slice('/WebGPUProbe/'.length));
      return {virtual, file, origin: 'probe-only', sha256: sha(file)};
    }
    const engineSource = virtual.replace(/^\/Engine\//, 'Engine/Shaders/');
    const verified = sourceVerification.verified.find(file => file.source === engineSource);
    assert(verified, `Target shader include was not verified: ${virtual}`);
    const file = path.join(root, '.tools/ue58-verified-shaders', virtual.slice('/Engine/'.length));
    assert.equal(sha(file), verified.sha256);
    return {virtual, origin: 'target-engine', gitBlob: verified.gitBlob, sha256: verified.sha256};
  });
  const wgsl = path.join(source, `${name}.wgsl`);
  cp.execFileSync(tint, [path.join(source, `${name}.spv`), '--format', 'wgsl', '-o', wgsl]);
  assert.equal(packet.wgsl, fs.readFileSync(wgsl, 'utf8'));
  fs.copyFileSync(file, path.join(output, compiled.packet));
  return {name, elementFormat, elementStride, probeOnlySource: float4,
    adaptation: item.adaptation, includes, packet: path.join(output, compiled.packet),
    packetSha256: sha(file), nativeSpirvSha256: sha(path.join(source, `${name}.native.spv`)),
    wgslSha256: sha(wgsl)};
});
const probeSource = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebBufferShaderProbe.cpp');
const formatSource = path.join(root,
  'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp');
const report = {pass: true, date: '2026-10-15', ...shaderPackets[0],
  targetEngineCommit: sourceVerification.revision, registration, shaderPackets,
  worker, probeSource, probeSourceSha256: sha(probeSource),
  formatSource, formatSourceSha256: sha(formatSource),
  originalTypedBufferShadersSupported: false,
  boundary: 'Four original engine ByteBuffer.usf uint32/uint4 structured storage shaders and two probe-only float4 storage shaders. Explicit Typed RHI storage representations; general Buffer<T> texel-buffer shader lowering is not implemented.'};
fs.writeFileSync(path.join(__dirname, 'results/ue-buffer-shader-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, shaders: shaderPackets.length,
  includesVerified: shaderPackets.map(shader => shader.includes.length),
  packetSha256: shaderPackets.map(shader => shader.packetSha256)}));
