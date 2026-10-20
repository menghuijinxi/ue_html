const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-structured');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'shader-reflects-storage-stride-and-access',
  'reject-null-srv', 'reject-null-uav', 'reject-srv-without-capability', 'reject-uav-without-capability',
  'reject-srv-of-non-structured-buffer', 'reject-uav-of-non-structured-buffer',
  ...['format', 'stride', 'counter', 'append', 'storage-alignment', 'offset-without-count', 'offset-at-end',
    'range', 'overflow'].flatMap(name => [`reject-srv-${name}`, `reject-uav-${name}`]),
  'default-views-inherit-stride-and-count', 'explicit-and-inherited-subranges', 'views-retain-buffers',
  'reject-srv-shader-stride-mismatch', 'reject-uav-shader-stride-mismatch',
  'reject-srv-missing-shader-stride', 'reject-uav-missing-shader-stride',
  'reject-srv-access-mismatch', 'reject-srv-during-split-transition', 'srv-valid-after-transition-end',
  'whole-copy-and-guards', 'read-only-source-preserved', 'subrange-copy-and-guards', 'subrange-fill-all-components',
  'existing-view-observes-update', 'uav-writes-visible-through-srv', 'commands-obey-recording-mode',
  'shader-bindings-retain-views', 'views-survive-caller-release', 'updated-read-only-source-preserved',
  'compute-psos-reused', 'transitions-released', 'gpu-validation-clean', 'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shader = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'structured-results.json'));
  assert(core.pass && global.pass && shader.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(shader.targetEngineCommit, core.targetEngineCommit);
  assert.equal(shader.originalTypedBufferShadersSupported, false);
  for (const [file, hash] of [[shader.probeSource, shader.probeSourceSha256],
    [shader.formatSource, shader.formatSourceSha256], [core.moduleFile, core.moduleSha256]])
    assert.equal(sha(file), hash, `Stale artifact: ${file}`);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const packets = shader.shaderPackets.filter(item => [28, 48].includes(item.elementFormat));
  assert.equal(packets.length, 4);
  for (const item of packets) {
    assert.equal(sha(item.packet), item.packetSha256);
    const packet = decode(fs.readFileSync(item.packet), shader.registration);
    assert.equal(packet.metadata.frequency, 5);
    assert.equal(packet.metadata.formatVersion, shader.worker.formatVersion);
    const suffix = item.elementStride === 4 ? '1x' : '4x';
    const destination = packet.metadata.spirvBindings.find(binding => binding.name === `DstStructuredBuffer${suffix}`);
    assert(destination.readOnlyStorage === false && destination.storageElementStride === item.elementStride &&
      destination.descriptorType === 7);
    if (item.name.endsWith('_MemcpyCS')) {
      const source = packet.metadata.spirvBindings.find(binding => binding.name === `SrcStructuredBuffer${suffix}`);
      assert(source.readOnlyStorage && source.storageElementStride === item.elementStride && source.descriptorType === 7);
    }
    assert.equal(item.includes.length, 45);
  }
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert(runtime.pass && runtime.structuredStorageViewsVerified && runtime.hostRHI === 'Null');
  assert.equal(runtime.resourceTableViewsImplemented, false);
  assert.equal(runtime.browserEngineImplemented, false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded-4', 'recorded-16', 'bypass-4', 'bypass-16']);
  const first = [0, 0xffffffff, 0x80000000, 0x12345678];
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    const stride = mode.stride, size = 256 * stride, components = stride / 4, words = size / 4;
    assert([4, 16].includes(stride));
    assert.equal(mode.checkedValues, 8 * words);
    assert.equal(mode.dispatches, 6);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.boundGroups, 6);
    assert.equal(mode.transitionsReleased, 6);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode.startsWith('recorded-') ? 22 : 31);
    const original = Array.from({length: words}, (_, index) => index < 4 ? first[index] :
      (Math.imul(index, 2654435761) ^ (0x80000000 + index % 4)) >>> 0);
    const updated = original.map((_, index) => (Math.imul(index, 65537) ^ 0xfedcba98) >>> 0);
    const expected = Array(words).fill(0xa5a5a5a5);
    const copies = [];
    const snapshot = (name, values) => copies.push({name, values: [...values]});
    const copy = (values, src, dst, count) => {
      for (let index = 0; index < count * components; ++index)
        expected[dst * components + index] = values[src * components + index];
    };
    copy(original, 7, 11, 129);
    snapshot('whole-copy-and-guards', expected);
    snapshot('read-only-source-preserved', original);
    copy(original, 256 / stride + 3, 512 / stride + 9, 67);
    snapshot('subrange-copy-and-guards', expected);
    for (let index = 0; index < 13 * components; ++index)
      expected[(512 / stride + 1) * components + index] = 0xfedcba98;
    snapshot('subrange-fill-all-components', expected);
    copy(updated, 256 / stride + 10, 199, 35);
    snapshot('existing-view-observes-update', expected);
    snapshot('uav-writes-visible-through-srv', expected);
    copy(updated, 2, 3, 73);
    snapshot('views-survive-caller-release', expected);
    snapshot('updated-read-only-source-preserved', updated);
    return copies.map(({name, values}) => {
      const file = path.join(output, `${mode.mode}-${name}.bin`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, size);
      values.forEach((value, index) => assert.equal(bytes.readUInt32LE(index * 4), value,
        `${mode.mode}/${name}[${index}]`));
      return {mode: mode.mode, stride, name, file, sha256: sha(file), checkedValues: values.length};
    });
  });
  for (const item of readbacks.filter(item => item.mode.startsWith('recorded-'))) {
    const other = readbacks.find(candidate => candidate.mode === `bypass-${item.stride}` && candidate.name === item.name);
    assert.equal(item.sha256, other.sha256);
  }
  const log = fs.readFileSync(path.join(results, 'ue-rhi-structured-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_STRUCTURED[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPackets: shader.shaderPackets.map(({name, packet, packetSha256}) => ({name, packet, packetSha256})),
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, readback) => sum + readback.checkedValues, 0),
    boundary: 'Native temporary global RHI. Structured SRV/UAV with inherited or matching explicit stride, default/full or aligned subrange views; real uint/uint4 storage shaders. Reinterpreted stride, counter/append, raw views, SRT views, full engine boot and browser UE runtime remain pending. Other structured element layouts require their own GPU samples.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-structured-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
