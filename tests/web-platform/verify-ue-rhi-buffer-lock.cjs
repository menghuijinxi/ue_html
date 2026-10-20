const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-buffer-lock');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'ue-buffered-lock-setting',
  'reject-null-lock', 'reject-unmatched-unlock', 'reject-empty-lock',
  'reject-offset-alignment', 'reject-size-alignment', 'reject-range', 'reject-overflow',
  'reject-no-overwrite', 'reject-invalid-mode', 'upload-obeys-ue-lock-mode',
  'copy-before-update-preserved', 'partial-write-and-sentinels', 'overlapping-update-in-order',
  'updated-vertex-buffer', 'read-lock-observes-gpu-write', 'read-lock-preserves-logical-state',
  'reject-access-during-read-lock', 'read-lock-cpu-changes-discarded',
  'reject-write-lock-during-split', 'reject-read-lock-during-split',
  'independent-buffers-lock-simultaneously', 'write-lock-preserves-logical-state',
  'reject-double-write-lock', 'reject-read-lock-during-write-lock', 'reject-readback-during-write-lock',
  'reject-gpu-access-during-write-lock', 'reject-transition-during-write-lock',
  'reject-lock-inside-render-pass', 'reject-unlock-inside-render-pass',
  'active-lock-retains-released-buffer', 'reject-double-unlock',
  'index16-lock-upload-and-guards', 'direct-lock-after-gpu-write',
  'ue-lock-setting-restored', 'all-locks-and-uploads-balanced', 'all-transitions-released',
  'gpu-validation-clean', 'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shaders = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'buffer-lock-results.json'));
  assert(core.pass && global.pass && shaders.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  assert.equal(shaders.targetEngineCommit, core.targetEngineCommit);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  for (const [file, hash] of [[shaders.probeSource, shaders.probeSourceSha256],
    [shaders.formatSource, shaders.formatSourceSha256]]) assert.equal(sha(file), hash);
  const shader = shaders.shaderPackets.find(item => item.name === 'WebR32Uint_MemsetBufferCS');
  assert(shader && !shader.probeOnlySource && shader.elementFormat === 28 && shader.includes.length === 45);
  assert.equal(sha(shader.packet), shader.packetSha256);
  const packet = decode(fs.readFileSync(shader.packet), shaders.registration);
  assert.equal(packet.metadata.frequency, 5);
  assert.equal(packet.metadata.formatVersion, shaders.worker.formatVersion);
  const destination = packet.metadata.spirvBindings.find(binding => binding.name === 'DstStructuredBuffer1x');
  assert(destination && !destination.readOnlyStorage && destination.storageElementFormat === 28 &&
    destination.storageElementStride === 4);
  const verification = read(path.join(results, 'ue-shader-source-verification.json'));
  for (const include of shader.includes) {
    assert.equal(include.origin, 'target-engine');
    const source = verification.verified.find(file =>
      file.source === include.virtual.replace(/^\/Engine\//, 'Engine/Shaders/'));
    assert(source && source.gitBlob === include.gitBlob && source.sha256 === include.sha256);
    assert.equal(sha(path.join(root, '.tools/ue58-verified-shaders', include.virtual.slice(8))), include.sha256);
  }
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert(runtime.pass && runtime.bufferLockUploadVerified && runtime.synchronousNativeReadLocksVerified &&
    runtime.hostRHI === 'Null');
  for (const field of ['unalignedLocksImplemented', 'noOverwriteLocksImplemented', 'browserEngineImplemented'])
    assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode),
    ['recorded-direct', 'recorded-buffered', 'bypass-direct', 'bypass-buffered']);
  const expected = Array.from({length: 256}, (_, index) => ((index * 37 + 11) ^ 0xa5a55a5a) >>> 0);
  const snapshots = [];
  const snapshot = (name, values) => snapshots.push({name, values: [...values]});
  snapshot('copy-before-update-preserved', expected);
  for (let index = 0; index < 10; ++index) expected[5 + index] = 1000 + index * 3;
  snapshot('partial-write-and-sentinels', expected);
  for (let index = 0; index < 4; ++index) expected[8 + index] = 9000 + index;
  snapshot('overlapping-update-in-order', expected);
  snapshot('updated-vertex-buffer', expected);
  for (let index = 17; index < 40; ++index) expected[index] = 0x13579bdf;
  snapshot('read-lock-observes-gpu-write', expected.slice(16, 48));
  snapshot('read-lock-cpu-changes-discarded', expected);
  const indices = Array(256).fill(0xdddddddd);
  for (let index = 0; index < 4; ++index) indices[32 + index] = 0xfeedface + index;
  snapshot('index16-lock-upload-and-guards', indices);
  expected[0] = 0xabcdef01;
  snapshot('direct-lock-after-gpu-write', expected);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.equal(mode.bypass, mode.mode.startsWith('bypass-'));
    assert.equal(mode.bufferedWriteLocks, mode.mode.endsWith('-buffered'));
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 1824);
    assert.equal(mode.dispatches, 1);
    assert.equal(mode.bufferLocksCreated, 6);
    assert.equal(mode.bufferLocksReleased, 6);
    assert.equal(mode.bufferUploads, 5);
    assert.equal(mode.bufferUploadBytes, 1100);
    assert.equal(mode.bufferReadLocks, 1);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    const submitted = {'recorded-direct': 28, 'recorded-buffered': 22, 'bypass-direct': 29, 'bypass-buffered': 29};
    assert.equal(mode.submittedCommandLists, submitted[mode.mode]);
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
  const log = fs.readFileSync(path.join(results, 'ue-rhi-buffer-lock-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_BUFFER_LOCK[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPacket: shader, targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, item) => sum + item.checkedValues, 0),
    boundary: 'Native temporary global RHI, one owner thread. Four-byte-aligned WriteOnly uploads encoded using fresh staging copies, with recorded/bypass and UE buffered-lock setting on/off. Synchronous native ReadOnly sees actual GPU writes. NoOverwrite, unaligned locks, asynchronous browser read locks, full boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-buffer-lock-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
