const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-buffer-uav');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'shader-reflects-writable-uint32-storage',
  'reject-null-buffer', 'reject-missing-uav-capability', 'reject-typed-view-of-structured-buffer',
  'reject-unknown-buffer-type', 'reject-raw-buffer-view', 'reject-float-format', 'reject-explicit-typed-stride',
  'reject-counter-view', 'reject-append-view', 'reject-unaligned-offset', 'reject-offset-without-count',
  'reject-offset-at-buffer-end', 'reject-out-of-range-count', 'reject-overflowing-count', 'reject-srv-descriptor',
  'whole-resource-normalized', 'subrange-normalized', 'views-retain-buffer', 'reject-non-view-storage-binding',
  'reject-storage-element-type-mismatch', 'reject-missing-storage-element-type', 'reject-read-only-storage-shader',
  'reject-missing-storage-access', 'reject-uav-access-mismatch', 'reject-uav-during-split-transition',
  'uav-valid-after-transition-end', 'whole-view-fill', 'subrange-fill-and-guards', 'commands-obey-recording-mode',
  'memcpy-and-memset-order', 'typed-uav-writes-visible-through-srv', 'copy-preserves-earlier-write',
  'read-only-source-preserved', 'shader-binding-retains-buffer-view', 'uav-survives-caller-release',
  'compute-psos-reused', 'transitions-released', 'gpu-validation-clean', 'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shader = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'buffer-uav-results.json'));
  assert(core.pass && global.pass && shader.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(shader.targetEngineCommit, core.targetEngineCommit);
  assert.equal(shader.originalTypedBufferShadersSupported, false);
  const packets = shader.shaderPackets.filter(item => [28, 48].includes(item.elementFormat));
  assert.equal(packets.length, 4);
  for (const [file, hash] of [[shader.probeSource, shader.probeSourceSha256],
    [shader.formatSource, shader.formatSourceSha256], [core.moduleFile, core.moduleSha256]])
    assert.equal(sha(file), hash, `Stale artifact: ${file}`);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  for (const item of packets) {
    assert.equal(sha(item.packet), item.packetSha256);
    const packet = decode(fs.readFileSync(item.packet), shader.registration);
    assert.equal(packet.metadata.frequency, 5);
    assert.equal(packet.metadata.formatVersion, shader.worker.formatVersion);
    const destination = packet.metadata.spirvBindings.find(binding =>
      binding.name === (item.elementFormat === 48 ? 'DstStructuredBuffer4x' : 'DstStructuredBuffer1x'));
    assert(destination.readOnlyStorage === false && destination.storageElementFormat === item.elementFormat &&
      destination.descriptorType === 7);
  }
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert(runtime.pass && runtime.typedR32UintStorageUAVVerified && runtime.hostRHI === 'Null');
  for (const field of ['generalTypedBufferShaderLoweringImplemented', 'resourceTableUAVImplemented',
    'browserEngineImplemented'])
    assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const source = Array.from({length: 256}, (_, index) =>
    index === 0 ? 0 : index === 1 ? 0xffffffff : (Math.imul(index, 2654435761) ^ 0x80000000) >>> 0);
  const copies = [];
  const snapshot = (name, values) => copies.push({name, values: [...values]});
  const expected = Array(256).fill(0xffffffff);
  snapshot('whole-view-fill', expected);
  for (let index = 0; index < 67; ++index) expected[64 + 5 + index] = 0x80000001;
  snapshot('subrange-fill-and-guards', expected);
  const earlier = [...expected];
  for (let index = 0; index < 73; ++index) expected[64 + 9 + index] = source[7 + index];
  for (let index = 0; index < 13; ++index) expected[64 + 1 + index] = 0xfedcba98;
  snapshot('memcpy-and-memset-order', expected);
  snapshot('typed-uav-writes-visible-through-srv', expected);
  snapshot('copy-preserves-earlier-write', earlier);
  snapshot('read-only-source-preserved', source);
  for (let index = 0; index < 111; ++index) expected[143 + index] = 0;
  snapshot('uav-survives-caller-release', expected);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 1792);
    assert.equal(mode.dispatches, 6);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.boundGroups, 6);
    assert.equal(mode.transitionsReleased, 6);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 20 : 28);
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
  const log = fs.readFileSync(path.join(results, 'ue-rhi-buffer-uav-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_BUFFER_UAV[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPackets: shader.shaderPackets.map(({name, packet, packetSha256}) => ({name, packet, packetSha256})),
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, readback) => sum + readback.checkedValues, 0),
    boundary: 'Native temporary global RHI; R32_UINT typed UAVs represented as reflected writable uint32 storage arrays, using existing ByteBuffer.usf structured branches. General RWBuffer<T> lowering, other typed formats, SRT UAVs, engine boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-buffer-uav-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
