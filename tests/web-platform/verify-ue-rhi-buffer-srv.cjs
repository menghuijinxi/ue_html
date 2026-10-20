const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-buffer-srv');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'shader-reflects-read-only-uint32-storage',
  'typed-srv-alignment-advertised', 'reject-null-resource', 'reject-missing-shader-resource-capability',
  'reject-typed-view-of-structured-buffer', 'reject-unknown-buffer-type', 'reject-raw-buffer-view',
  'reject-float-format', 'reject-explicit-typed-stride', 'reject-counter-view', 'reject-unaligned-offset',
  'reject-offset-without-count', 'reject-offset-at-buffer-end', 'reject-out-of-range-count',
  'reject-overflowing-count', 'reject-uav-descriptor', 'whole-resource-normalized', 'subrange-normalized',
  'views-retain-buffer', 'reject-non-view-storage-binding', 'reject-storage-element-type-mismatch',
  'reject-writable-storage-shader', 'reject-srv-access-mismatch', 'reject-srv-during-split-transition',
  'srv-valid-after-transition-end', 'whole-view-copy-and-guards', 'read-only-source-preserved',
  'subrange-copy-and-guards', 'view-observes-copy-update', 'commands-obey-recording-mode',
  'srv-survives-caller-release', 'shader-binding-retains-buffer-view', 'updated-read-only-source-preserved',
  'compute-pso-reused', 'transitions-released', 'gpu-validation-clean', 'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shader = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'buffer-srv-results.json'));
  assert(core.pass && global.pass && shader.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(shader.targetEngineCommit, core.targetEngineCommit);
  assert.equal(shader.originalTypedBufferShadersSupported, false);
  for (const [file, hash] of [[shader.probeSource, shader.probeSourceSha256],
    [shader.formatSource, shader.formatSourceSha256], [shader.packet, shader.packetSha256],
    [core.moduleFile, core.moduleSha256]])
    assert.equal(sha(file), hash, `Stale artifact: ${file}`);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  const packet = decode(fs.readFileSync(shader.packet), shader.registration);
  assert.equal(packet.metadata.frequency, 5);
  assert.equal(packet.metadata.formatVersion, shader.worker.formatVersion);
  const input = packet.metadata.spirvBindings.find(binding => binding.name === 'SrcStructuredBuffer1x');
  const destination = packet.metadata.spirvBindings.find(binding => binding.name === 'DstStructuredBuffer1x');
  assert(input.readOnlyStorage && input.storageElementFormat === 28 && input.descriptorType === 7);
  assert(destination.readOnlyStorage === false && destination.descriptorType === 7);
  assert(runtime.pass && runtime.typedR32UintStorageSRVVerified && runtime.hostRHI === 'Null');
  for (const field of ['generalTypedBufferShaderLoweringImplemented', 'resourceTableSRVImplemented',
    'browserEngineImplemented'])
    assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const original = Array.from({length: 256}, (_, index) =>
    index === 0 ? 0 : index === 1 ? 0xffffffff : (Math.imul(index, 2654435761) ^ 0x80000000) >>> 0);
  const updated = original.map((_, index) => (Math.imul(index, 65537) ^ 0xfedcba98) >>> 0);
  const copies = [];
  const expected = Array(256).fill(0xa5a5a5a5);
  const snapshot = (name, values) => copies.push({name, values: [...values]});
  for (let index = 0; index < 129; ++index) expected[11 + index] = original[7 + index];
  snapshot('whole-view-copy-and-guards', expected);
  snapshot('read-only-source-preserved', original);
  for (let index = 0; index < 67; ++index) expected[97 + index] = original[64 + 3 + index];
  snapshot('subrange-copy-and-guards', expected);
  for (let index = 0; index < 35; ++index) expected[199 + index] = updated[64 + 10 + index];
  snapshot('view-observes-copy-update', expected);
  for (let index = 0; index < 200; ++index) expected[3 + index] = updated[5 + index];
  snapshot('srv-survives-caller-release', expected);
  snapshot('updated-read-only-source-preserved', updated);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 1536);
    assert.equal(mode.dispatches, 4);
    assert.equal(mode.computePipelinesCreated, 1);
    assert.equal(mode.boundGroups, 4);
    assert.equal(mode.transitionsReleased, 4);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 17 : 24);
    return copies.map(({name, values}) => {
      const file = path.join(output, `${mode.mode}-${name}.bin`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, 1024);
      values.forEach((value, index) => assert.equal(bytes.readUInt32LE(index * 4), value,
        `${mode.mode}/${name}[${index}]`));
      return {mode: mode.mode, name, file, sha256: sha(file), checkedValues: values.length};
    });
  });
  for (const copy of copies) {
    const modes = readbacks.filter(readback => readback.name === copy.name);
    assert.equal(modes[0].sha256, modes[1].sha256);
  }
  const log = fs.readFileSync(path.join(results, 'ue-rhi-buffer-srv-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_BUFFER_SRV[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPacket: shader.packet, shaderPacketSha256: shader.packetSha256,
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, readback) => sum + readback.checkedValues, 0),
    boundary: 'Native temporary global RHI; Typed R32_UINT buffer SRVs represented as reflected read-only uint32 storage arrays. Uses the existing ByteBuffer.usf structured branch. General Buffer<T> shader lowering, other typed formats, SRT SRVs, engine boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-buffer-srv-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
