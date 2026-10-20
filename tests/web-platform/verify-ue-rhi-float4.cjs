const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-float4');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'global-device-and-recording-mode', 'shader-reflects-float4-storage-and-access',
  'float4-storage-alignment-advertised', 'reject-partial-element-srv', 'reject-partial-element-uav',
  ...['explicit-stride', 'offset-alignment', 'offset-without-count', 'range', 'overflow',
    'float-scalar-format'].flatMap(name => [`reject-srv-${name}`, `reject-uav-${name}`]),
  'whole-views-normalized', 'subranges-normalized', 'views-retain-buffers',
  'reject-uint4-shader-for-float4-srv', 'reject-uint4-shader-for-float4-uav',
  'reject-float4-shader-for-uint4-srv', 'reject-float4-shader-for-uint4-uav',
  'reject-uav-access-mismatch', 'reject-uav-during-split-transition', 'uav-valid-after-transition-end',
  'whole-transform-fractions-and-guards', 'read-only-source-preserved', 'subrange-transform-and-guards',
  'subrange-fill-distinct-components', 'existing-view-observes-update', 'uav-writes-visible-through-srv',
  'commands-obey-recording-mode', 'shader-bindings-retain-views', 'views-survive-caller-release',
  'updated-read-only-source-preserved', 'compute-psos-reused', 'transitions-released', 'gpu-validation-clean',
  'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const shader = read(path.join(results, 'ue-buffer-shader-build-results.json'));
  const runtime = read(path.join(output, 'float4-results.json'));
  assert(core.pass && global.pass && shader.pass && global.moduleSha256 === core.moduleSha256);
  assert.equal(shader.targetEngineCommit, core.targetEngineCommit);
  assert.equal(shader.originalTypedBufferShadersSupported, false);
  for (const [file, hash] of [[shader.probeSource, shader.probeSourceSha256],
    [shader.formatSource, shader.formatSourceSha256], [core.moduleFile, core.moduleSha256]])
    assert.equal(sha(file), hash, `Stale artifact: ${file}`);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const packets = shader.shaderPackets.filter(item => item.elementFormat === 1);
  assert.deepEqual(packets.map(item => item.name), ['WebFloat4_TransformCS', 'WebFloat4_FillCS']);
  const sourceVerification = read(path.join(results, 'ue-shader-source-verification.json'));
  for (const item of packets) {
    assert(item.probeOnlySource);
    assert.equal(item.elementStride, 16);
    assert.equal(item.includes.length, 44);
    assert.equal(sha(item.packet), item.packetSha256);
    const packet = decode(fs.readFileSync(item.packet), shader.registration);
    assert.equal(packet.metadata.frequency, 5);
    assert.equal(packet.metadata.formatVersion, shader.worker.formatVersion);
    assert(packet.wgsl.includes('vec4<f32>'));
    const destination = packet.metadata.spirvBindings.find(binding => binding.name === 'DstFloat4');
    assert(destination.readOnlyStorage === false && destination.storageElementStride === 16 &&
      destination.storageElementFormat === 1 && destination.descriptorType === 7);
    if (item.name.endsWith('_TransformCS')) {
      const source = packet.metadata.spirvBindings.find(binding => binding.name === 'SrcFloat4');
      assert(source.readOnlyStorage && source.storageElementStride === 16 &&
        source.storageElementFormat === 1 && source.descriptorType === 7);
      for (const name of ['Scale', 'Bias'])
        assert.equal(packet.metadata.ueParameterMap.find(parameter => parameter.name === name).size, 16);
    }
    const probeSources = item.includes.filter(include => include.origin === 'probe-only');
    assert.equal(probeSources.length, 1);
    assert.equal(probeSources[0].virtual, '/WebGPUProbe/Private/WebFloat4Probe.usf');
    assert.equal(probeSources[0].file, path.join(root, 'tests/ue-shader-host/Shaders/Private/WebFloat4Probe.usf'));
    for (const include of item.includes) {
      if (include.origin === 'probe-only') assert.equal(sha(include.file), include.sha256);
      else {
        const file = sourceVerification.verified.find(file =>
          file.source === include.virtual.replace(/^\/Engine\//, 'Engine/Shaders/'));
        assert(file && file.sha256 === include.sha256 && file.gitBlob === include.gitBlob);
        assert.equal(sha(path.join(root, '.tools/ue58-verified-shaders', include.virtual.slice(8))), include.sha256);
      }
    }
  }
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert(runtime.pass && runtime.typedFloat4StorageViewsVerified && runtime.probeOnlyShaders && runtime.hostRHI === 'Null');
  for (const field of ['generalTypedBufferShaderLoweringImplemented', 'resourceTableViewsImplemented',
    'browserEngineImplemented']) assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const first = [0, -1.5, 0.25, 1024];
  const original = Array.from({length: 1024}, (_, index) => index < 4 ? first[index] : ((index * 17 % 257) - 128) * 0.25);
  const updated = original.map((_, index) => ((index * 29 % 509) - 254) * 0.125);
  const scale = [0.5, -2, 4, -0.25], bias = [-3, 0.25, 16, -0.5], fill = [-0.5, 7.25, -16, 0.125];
  const expected = Array(1024).fill(-2048.5);
  const copies = [];
  const snapshot = (name, values) => copies.push({name, values: [...values]});
  const transform = (source, src, dst, count) => {
    for (let index = 0; index < count * 4; ++index)
      expected[dst * 4 + index] = Math.fround(Math.fround(source[src * 4 + index] * scale[index % 4]) + bias[index % 4]);
  };
  transform(original, 5, 7, 197);
  snapshot('whole-transform-fractions-and-guards', expected);
  snapshot('read-only-source-preserved', original);
  transform(original, 16 + 3, 32 + 9, 67);
  snapshot('subrange-transform-and-guards', expected);
  for (let index = 0; index < 13 * 4; ++index) expected[(32 + 1) * 4 + index] = fill[index % 4];
  snapshot('subrange-fill-distinct-components', expected);
  transform(updated, 3, 13, 167);
  snapshot('existing-view-observes-update', expected);
  snapshot('uav-writes-visible-through-srv', expected);
  transform(updated, 2, 3, 173);
  snapshot('views-survive-caller-release', expected);
  snapshot('updated-read-only-source-preserved', updated);
  const readbacks = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 8192);
    assert.equal(mode.dispatches, 6);
    assert.equal(mode.computePipelinesCreated, 2);
    assert.equal(mode.boundGroups, 6);
    assert.equal(mode.transitionsReleased, 6);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 22 : 31);
    return copies.map(({name, values}) => {
      const file = path.join(output, `${mode.mode}-${name}.bin`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, 4096);
      values.forEach((value, index) => {
        const actual = bytes.readFloatLE(index * 4);
        assert(Number.isFinite(actual));
        assert(actual === value, `${mode.mode}/${name}[${index}]: ${actual} != ${value}`);
      });
      return {mode: mode.mode, name, file, sha256: sha(file), checkedValues: values.length};
    });
  });
  for (const copy of copies) {
    const modes = readbacks.filter(readback => readback.name === copy.name);
    assert.equal(modes[0].sha256, modes[1].sha256);
  }
  const log = fs.readFileSync(path.join(results, 'ue-rhi-float4-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_FLOAT4[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, readbacks,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    shaderPackets: packets.map(({name, packet, packetSha256, includes}) => ({name, packet, packetSha256, includes})),
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: readbacks.reduce((sum, readback) => sum + readback.checkedValues, 0),
    boundary: 'Native temporary global RHI. Typed PF_A32B32G32R32F SRV/UAV bound as reflected float4 storage, tested with two explicitly probe-only shaders. Finite binary fractions and component-wise arithmetic/fill; no NaN/Inf/subnormal contract tested. Original engine typed shader lowering, SRT views, full boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-float4-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
