const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-texture-srv');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const formats = ['rgba8', 'bgra8'];
const samples = ['default-view', 'direct-texture-rebind', 'view-survives-caller-release'];
const pattern = [[32, 64, 128, 255], [191, 32, 64, 128], [64, 191, 32, 64], [128, 64, 191, 32]];
const required = [
  'global-device-and-recording-mode', 'reject-null-resource', 'reject-buffer-srv', 'reject-uav-descriptor',
  'reject-unspecified-dimension', 'reject-cube-dimension', 'reject-stencil-plane', 'reject-format-reinterpretation',
  'reject-first-mip', 'reject-mip-count', 'reject-first-layer', 'reject-layer-count',
  'reject-missing-shader-resource-capability', 'reject-expired-texture',
  'resolve-srv-handle-and-underlying-texture', 'reject-non-texture-binding', 'reject-srv-attachment-feedback',
  'reject-srv-access-mismatch', 'reject-srv-during-split-transition', 'srv-valid-after-transition-end',
  'released-view-drops-texture-reference',
  ...formats.flatMap(format => ['views-retain-resource', ...samples, 'commands-obey-recording-mode',
    'shader-binding-retains-view'].map(name => `${format}-${name}`)),
  'graphics-pso-reused-for-srv-and-texture', 'split-transitions-released', 'gpu-validation-clean', 'host-rhi-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const runtime = read(path.join(output, 'texture-srv-results.json'));
  assert(core.pass && global.pass && global.moduleSha256 === core.moduleSha256);
  assert(runtime.pass && runtime.textureSRVDirectBindingVerified && runtime.hostRHI === 'Null');
  for (const field of ['generalBufferSRVImplemented', 'resourceTableSRVImplemented', 'browserEngineImplemented'])
    assert.equal(runtime[field], false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const images = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 6144);
    assert.equal(mode.draws, 6);
    assert.equal(mode.graphicsPipelinesCreated, 1);
    assert.equal(mode.boundGroups, 12);
    assert.equal(mode.transitionsReleased, 2);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert(mode.submittedCommandLists > 0);
    return formats.flatMap(format => samples.map(sample => {
      const name = `${format}-${sample}`;
      const raw = path.join(output, `${mode.mode}-${name}.rgba`);
      const pixels = fs.readFileSync(raw);
      assert.equal(pixels.length, 1024);
      for (let y = 0; y < 16; ++y)
        for (let x = 0; x < 16; ++x) {
          const expected = pattern[(y >= 8 ? 2 : 0) + (x >= 8 ? 1 : 0)];
          expected.forEach((value, channel) =>
            assert(Math.abs(pixels[(y * 16 + x) * 4 + channel] - value) <= (channel === 3 ? 0 : 1), name));
        }
      const png = new PNG({width: 16, height: 16});
      pixels.copy(png.data);
      const image = path.join(results, `ue-rhi-texture-srv-${mode.mode}-${name}.png`);
      fs.writeFileSync(image, PNG.sync.write(png));
      return {mode: mode.mode, name, raw, rawSha256: sha(raw), image, imageSha256: sha(image)};
    }));
  });
  assert(images.every(image => image.rawSha256 === images[0].rawSha256));
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  assert.equal(sha(commandlet), global.commandletSha256);
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  const packets = ['FScreenVS', 'FScreenPS'].map(name => {
    const file = path.join(__dirname, 'build/ue-platform-full-worker', `${name}.webshader`);
    assert.equal(decode(fs.readFileSync(file)).metadata.shaderPlatformEnum, 47);
    assert.equal(sha(file), core.shaderPackets.find(packet => packet.name === name).sha256);
    return {name, sha256: sha(file)};
  });
  const log = fs.readFileSync(path.join(results, 'ue-rhi-texture-srv-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_TEXTURE_SRV[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: '2026-10-15', runtime, images, shaderPackets: packets,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletSha256: global.commandletSha256, commandletDLLSha256: global.commandletDLLSha256,
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: runtime.modes.reduce((sum, mode) => sum + mode.checkedValues, 0),
    boundary: 'Native temporary global RHI; direct Texture2D SRVs with one mip/layer and matching linear RGBA8/BGRA8. General buffer SRVs, SRT SRVs, complete engine boot and browser UE runtime remain pending.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-texture-srv-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
