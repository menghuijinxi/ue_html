const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-texture-3d');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base = ['global-device-and-recording-mode', 'shader-reflects-single-sampled-3d',
  ...['array', 'mips', 'multisample', 'srgb', 'render-target-volume', 'uav-volume', 'zero-depth',
    'zero-width', 'negative-height', 'unsupported-format', 'missing-bulk', 'bulk-size'].map(name => `reject-${name}`),
  'invalid-bulk-not-discarded', 'compute-pipelines-reused', 'transitions-released', 'gpu-validation-clean',
  'host-rhi-restored'];
const required = [...base];
const snapshots = [];
const expected = Array.from({length: 72}, (_, index) => (Math.floor(index / 4) * 37 + index % 4 * 61 + 13) % 256);
const clamped = Array.from({length: 72}, (_, index) => expected[48 + index % 24]);
for (const format of ['rgba', 'bgra']) {
  for (const init of ['initializer', 'bulk']) {
    const prefix = `${format}-${init}`;
    required.push(`${prefix}-${init === 'bulk' ? 'snapshot-and-discard' : 'subresource-layout'}`,
      ...['view-layout', 'shader-view-compatible', 'reject-2d-shader', 'reject-2d-view', 'reject-wrong-access']
        .map(name => `${prefix}-${name}`));
    for (const name of ['direct-load', 'srv-load', 'point-sample', 'wrap-z', 'clamp-z', 'retained-view-load']) {
      required.push(`${prefix}-${name}`);
      snapshots.push({name: `${prefix}-${name}`, values: name === 'clamp-z' ? clamped : expected});
    }
  }
  required.push(`${format}-bulk-2d`, `${format}-reject-2d-texture-for-3d-shader`);
}
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shaders = read(path.join(results, 'ue-texture-shader-build-results.json'));
  const runtime = read(path.join(output, 'texture-3d-results.json'));
  assert(core.pass && global.pass && shaders.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  assert.equal(shaders.targetEngineCommit, core.targetEngineCommit);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  assert.equal(sha(shaders.probeSource), shaders.probeSourceSha256);
  assert.equal(sha(shaders.formatSource), shaders.formatSourceSha256);
  for (const shader of shaders.shaderPackets) {
    assert.equal(sha(shader.packet), shader.packetSha256);
    assert(shader.probeOnlySource);
    const packet = decode(fs.readFileSync(shader.packet), shaders.registration);
    const volume = packet.metadata.spirvBindings.find(binding => binding.name === 'Volume');
    assert.equal(volume.textureDimension, 2);
    assert.equal(volume.textureArrayed, false);
    assert.equal(volume.textureMultisampled, false);
    assert.equal(volume.textureSampleType, 'float');
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
  assert(runtime.pass && runtime.texture3DInitializationAndSamplingVerified &&
    runtime.bulkDataSnapshotAndDiscardVerified && runtime.probeOnlyShaders && runtime.hostRHI === 'Null');
  assert.equal(runtime.multiMipVolumeImplemented, false);
  assert.equal(runtime.browserEngineImplemented, false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass);
    assert.deepEqual(mode.errors, []);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.dispatches, 24);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.checkedValues, 1776);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 58 : 85);
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
  const log = fs.readFileSync(path.join(results, 'ue-rhi-texture-3d-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_TEXTURE_3D[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    shaderPackets: shaders.shaderPackets,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: runtime.modes.reduce((sum, mode) => sum + mode.checkedValues, 0),
    binaryCheckedValues: readbacks.reduce((sum, item) => sum + item.checkedValues, 0),
    boundary: 'Native recorded/bypass, sampled single-mip linear RGBA8/BGRA8 3D and BulkData snapshot/Discard. Actual UE Worker Load and point/clamp/wrap sampling across all 18 voxels. Integer volumes are verified separately. Arrays, cubes, mip chains, 3D updates/copies, full boot and browser engine remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-texture-3d-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
