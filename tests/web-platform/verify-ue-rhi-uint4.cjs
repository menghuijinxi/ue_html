const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-uint4');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'shader-reflects-uint4-read-write-storage',
  'uint4-storage-alignment-advertised', 'reject-partial-uint4-srv', 'reject-partial-uint4-uav',
  ...['storage-offset-alignment', 'out-of-range-elements', 'overflowing-elements', 'offset-without-count',
    'float-scalar-format'].flatMap(name => [`reject-srv-${name}`, `reject-uav-${name}`]),
  'whole-views-normalized-to-16-byte-elements', 'subranges-use-vector-element-counts', 'views-retain-buffers',
  'reject-scalar-shader-for-uint4-srv', 'reject-scalar-shader-for-uint4-uav',
  'reject-uint4-shader-for-scalar-srv', 'reject-uint4-shader-for-scalar-uav',
  'reject-uav-access-mismatch', 'reject-uav-during-split-transition', 'uav-valid-after-transition-end',
  'whole-copy-distinct-components-and-guards', 'read-only-source-preserved',
  'subrange-copy-distinct-components-and-guards', 'subrange-memset-all-components',
  'existing-view-observes-source-update', 'uint4-uav-writes-visible-through-srv',
  'commands-obey-recording-mode', 'shader-bindings-retain-both-views', 'views-survive-caller-release',
  'updated-read-only-source-preserved', 'compute-psos-reused', 'transitions-released', 'gpu-validation-clean',
  'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shader = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'uint4-results.json'));
  assert(core.pass && global.pass && shader.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(shader.targetEngineCommit, core.targetEngineCommit);
  assert.equal(shader.originalTypedBufferShadersSupported, false);
  for (const [file, hash] of [[shader.probeSource, shader.probeSourceSha256],
    [shader.formatSource, shader.formatSourceSha256], [core.moduleFile, core.moduleSha256]])
    assert.equal(sha(file), hash, `Stale artifact: ${file}`);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const packets = shader.shaderPackets.filter(item => item.elementFormat === 48);
  assert.equal(packets.length, 2);
  for (const item of packets) {
    assert.equal(sha(item.packet), item.packetSha256);
    const packet = decode(fs.readFileSync(item.packet), shader.registration);
    assert.equal(packet.metadata.frequency, 5);
    assert.equal(packet.metadata.formatVersion, shader.worker.formatVersion);
    const destination = packet.metadata.spirvBindings.find(binding => binding.name === 'DstStructuredBuffer4x');
    assert(destination.readOnlyStorage === false && destination.storageElementFormat === 48 &&
      destination.descriptorType === 7);
    if (item.name.endsWith('_MemcpyCS')) {
      const input = packet.metadata.spirvBindings.find(binding => binding.name === 'SrcStructuredBuffer4x');
      assert(input.readOnlyStorage && input.storageElementFormat === 48 && input.descriptorType === 7);
    }
    assert.equal(item.includes.length, 45);
  }
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert(runtime.pass && runtime.typedUint4StorageViewsVerified && runtime.hostRHI === 'Null');
  for (const field of ['generalTypedBufferShaderLoweringImplemented', 'resourceTableViewsImplemented',
    'browserEngineImplemented'])
    assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const first = [0, 0xffffffff, 0x80000000, 0x12345678];
  const source = Array.from({length: 512}, (_, index) => index < 4 ? first[index] :
    (Math.imul(index, 2654435761) ^ (0x80000000 + index % 4)) >>> 0);
  const updated = source.map((_, index) => (Math.imul(index, 65537) ^ 0xfedcba98) >>> 0);
  const expected = Array(512).fill(0xa5a5a5a5);
  const copies = [];
  const snapshot = (name, values) => copies.push({name, values: [...values]});
  const copy = (values, src, dst, count) => {
    for (let index = 0; index < count * 4; ++index) expected[dst * 4 + index] = values[src * 4 + index];
  };
  copy(source, 5, 7, 97);
  snapshot('whole-copy-distinct-components-and-guards', expected);
  snapshot('read-only-source-preserved', source);
  copy(source, 16 + 3, 32 + 9, 37);
  snapshot('subrange-copy-distinct-components-and-guards', expected);
  for (let index = 0; index < 13 * 4; ++index) expected[(32 + 1) * 4 + index] = 0xfedcba98;
  snapshot('subrange-memset-all-components', expected);
  copy(updated, 3, 13, 67);
  snapshot('existing-view-observes-source-update', expected);
  snapshot('uint4-uav-writes-visible-through-srv', expected);
  copy(updated, 2, 3, 73);
  snapshot('views-survive-caller-release', expected);
  snapshot('updated-read-only-source-preserved', updated);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 4096);
    assert.equal(mode.dispatches, 6);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.boundGroups, 6);
    assert.equal(mode.transitionsReleased, 6);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 22 : 31);
    return copies.map(({name, values}) => {
      const file = path.join(output, `${mode.mode}-${name}.bin`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, 2048);
      values.forEach((value, index) => assert.equal(bytes.readUInt32LE(index * 4), value,
        `${mode.mode}/${name}[${index}]`));
      return {mode: mode.mode, name, file, sha256: sha(file), checkedValues: values.length};
    });
  });
  for (const copy of copies) {
    const modes = readbacks.filter(readback => readback.name === copy.name);
    assert.equal(modes[0].sha256, modes[1].sha256);
  }
  const log = fs.readFileSync(path.join(results, 'ue-rhi-uint4-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_UINT4[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPackets: packets.map(({name, packet, packetSha256}) => ({name, packet, packetSha256})),
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, readback) => sum + readback.checkedValues, 0),
    boundary: 'Native temporary global RHI; R32G32B32A32_UINT SRV/UAVs represented as reflected uint4 storage arrays, using original ByteBuffer.usf structured branches. Structured views are tested by a separate probe. General Buffer<T>/RWBuffer<T> lowering, other Typed formats, SRT views, engine boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-uint4-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
