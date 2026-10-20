const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-texture-uint');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = ['global-device-and-recording-mode', 'shader-reflects-uint-texture', 'shader-reflects-float-texture',
  ...['cube-integer', 'srgb', 'render-target', 'uav', 'multi-mip', 'array', 'multisample', 'missing-bulk',
    'dimension-limit', 'short-bulk', 'oversized-bulk'].map(name => `reject-create-${name}`),
  'invalid-bulk-not-discarded', 'default-zero-initialization', 'one-voxel-bulk-and-dimensions',
  'one-voxel-bulk-discarded', 'reject-uint-shader-for-unorm-texture', 'reject-null-texture-binding',
  'compute-pipelines-reused', 'transitions-released', 'gpu-validation-clean', 'host-rhi-restored'];
for (const format of [28, 32, 60, 10, 71, 3, 40])
  required.push(...['creation-valid', 'view-valid', 'direct-type-compatible', 'srv-type-compatible',
    'reject-scalar-mismatch', 'reject-srgb', 'reject-array', 'volume-scope-retained']
    .map(name => `system-2d-${format}-${name}`));
const values = Array.from({length: 72}, (_, index) =>
  index < 6 ? [0, 1, 127, 128, 254, 255][index] : (index * 73 + 29) % 256);
const expected = Array(84).fill(0xdeadbeef);
const snapshots = [];
const snapshot = name => snapshots.push({name, values: [...expected]});
for (const prefix of ['initializer', 'bulk']) {
  required.push(`${prefix}-${prefix === 'bulk' ? 'snapshot-and-discard' : 'subresource-layout'}`,
    ...['view-layout', 'shader-type-compatible', 'reject-float-shader-direct', 'reject-float-shader-srv',
      'reject-binding-missing-type', 'reject-binding-signed-type', 'reject-binding-arrayed',
      'reject-binding-multisampled', 'reject-view-float-format', 'reject-view-2d', 'reject-view-mip',
      'reject-view-array-slice', 'reject-wrong-access', 'direct-load-and-guards', 'srv-load-and-guards',
      'reverse-load-and-dimensions', 'released-view-load'].map(name => `${prefix}-${name}`));
  values.forEach((value, index) => expected[4 + index] = value);
  snapshot(`${prefix}-direct-load-and-guards`);
  snapshot(`${prefix}-srv-load-and-guards`);
  for (let index = 0; index < 72; ++index)
    expected[4 + index] = values[(17 - Math.floor(index / 4)) * 4 + index % 4];
  [3, 2, 3, 1].forEach((value, index) => expected[76 + index] = value);
  snapshot(`${prefix}-reverse-load-and-dimensions`);
  values.forEach((value, index) => expected[4 + index] = value);
  snapshot(`${prefix}-released-view-load`);
}
expected.fill(0, 4, 76);
snapshot('default-zero-initialization');
[0, 127, 254, 255].forEach((value, index) => expected[4 + index] = value);
expected.fill(1, 76, 80);
snapshot('one-voxel-bulk-and-dimensions');
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shaders = read(path.join(results, 'ue-texture-uint-shader-build-results.json'));
  const runtime = read(path.join(output, 'texture-uint-results.json'));
  assert(core.pass && global.pass && shaders.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  assert.equal(shaders.targetEngineCommit, core.targetEngineCommit);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  assert.equal(sha(shaders.probeSource), shaders.probeSourceSha256);
  assert.equal(sha(shaders.formatSource), shaders.formatSourceSha256);
  assert.deepEqual(shaders.shaderPackets.map(shader => shader.name), ['WebTextureUint_LoadCS', 'WebTextureUint_InspectCS']);
  for (const shader of [...shaders.shaderPackets, shaders.floatShaderPacket]) {
    assert(shader && shader.probeOnlySource);
    assert.equal(sha(shader.packet), shader.packetSha256);
    const packet = decode(fs.readFileSync(shader.packet), shaders.registration);
    assert.equal(packet.metadata.formatVersion, shaders.worker.formatVersion);
    const volume = packet.metadata.spirvBindings.find(binding => binding.name === 'Volume');
    assert.equal(volume.textureDimension, 2);
    assert.equal(volume.textureArrayed, false);
    assert.equal(volume.textureMultisampled, false);
    assert.equal(volume.textureSampleType, shader.name.startsWith('WebTextureUint_') ? 'uint' : 'float');
    for (const include of shader.includes) {
      const file = include.origin === 'probe-only' ? include.file :
        path.join(root, '.tools/ue58-verified-shaders', include.virtual.slice(8));
      assert.equal(sha(file), include.sha256);
    }
  }
  assert.equal(sha(path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp')),
    global.commandletSha256);
  assert.equal(sha(path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll')),
    global.commandletDLLSha256);
  assert(runtime.pass && runtime.integerVolumeLoadVerified && runtime.textureSampleTypeValidated &&
    runtime.probeOnlyShaders && runtime.hostRHI === 'Null');
  assert.equal(runtime.integerTextureFilteringImplemented, false);
  assert.equal(runtime.browserEngineImplemented, false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass);
    assert.deepEqual(mode.errors, []);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.dispatches, 10);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.checkedValues, 840);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 24 : 35);
    return snapshots.map(({name, values}) => {
      const file = path.join(output, `${mode.mode}-${name}.bin`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, values.length * 4);
      values.forEach((expected, index) => assert.equal(bytes.readUInt32LE(index * 4), expected,
        `${mode.mode}/${name}[${index}]`));
      return {mode: mode.mode, name, file, sha256: sha(file), checkedValues: values.length};
    });
  });
  for (const {name} of snapshots)
    assert.equal(new Set(readbacks.filter(item => item.name === name).map(item => item.sha256)).size, 1);
  const log = fs.readFileSync(path.join(results, 'ue-rhi-texture-uint-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_TEXTURE_UINT[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    shaderPackets: shaders.shaderPackets, floatShaderPacket: shaders.floatShaderPacket,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, item) => sum + item.checkedValues, 0),
    boundary: 'Native recorded/bypass single-mip RGBA8_UINT volume initialization, Texture3D SRV and actual uint4 Load/GetDimensions via UE Worker. Scalar type mismatches rejected before GPU binding. Default lazy zero, all 18 voxels, integer edges, sentinels and caller-release lifetime verified. Integer filtering, arrays, cubes, mip chains, 3D updates/copies, full boot and browser engine remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-texture-uint-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
