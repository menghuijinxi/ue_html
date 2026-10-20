const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-viewport');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const required = [
  'post-init-through-global-entry', 'texture-initializer-rgba8', 'texture-initializer-bgra8',
  'resource-array-discard-after-snapshot',
  'resource-array-upload-survives-discard', 'render-resource-init-is-idempotent',
  'render-resource-initial-data', 'render-resource-update-recreates', 'render-resource-updated-data',
  'render-resource-release-clears', 'render-resource-reinitializes', 'render-resource-reinitialized-data',
  'render-resource-final-release', 'reject-null-window', 'reject-zero-viewport', 'reject-oversized-viewport',
  'reject-fullscreen-viewport', 'reject-unsupported-viewport-format', 'surface-native-window-and-swapchain',
  'surface-acquire-is-stable', 'surface-first-frame', 'surface-first-present', 'reject-expired-surface-frame',
  'surface-resize-reacquires', 'surface-resized-frame', 'surface-second-present', 'surface-skipped-frame',
  'surface-skip-does-not-present', 'surface-resumed-frame', 'surface-resumes-after-skip',
  'surface-pso-cache-reused', 'surface-transitions-balanced', 'surface-gpu-validation-clean',
  'surface-breadcrumbs-balanced', 'surface-gpu-debug-marker-emitted', 'surface-host-rhi-restored',
];
const frames = [
  ['surface-first-frame', 64, 64, [191, 64, 128, 255]],
  ['surface-resized-frame', 96, 48, [32, 191, 64, 255]],
  ['surface-skipped-frame', 96, 48, [32, 64, 191, 255]],
  ['surface-resumed-frame', 96, 48, [128, 64, 191, 255]],
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const global = read(path.join(results, 'ue-rhi-global-build-results.json'));
  const runtime = read(path.join(output, 'viewport-rhi-results.json'));
  assert(core.pass && global.pass && global.moduleSha256 === core.moduleSha256);
  assert(runtime.pass && runtime.nativeSurfacePresentationVerified && runtime.renderResourceLifecycleVerified);
  assert.equal(runtime.hostRHI, 'Null');
  assert.equal(runtime.importedRHIStartupImplemented, false);
  assert.equal(runtime.browserEngineImplemented, false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const images = runtime.modes.flatMap(mode => {
    assert(mode.pass && mode.errors.length === 0);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...required].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.checkedValues, 71988);
    for (const [name, count] of Object.entries({draws: 4, graphicsPipelinesCreated: 1, viewportsCreated: 1,
      viewportsResized: 1, framesAcquired: 4, framesPresented: 3, framesSkipped: 1,
      transitionsReleased: 8, breadcrumbsBegun: 4, breadcrumbsEnded: 4}))
      assert.equal(mode[name], count, name);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert(mode.breadcrumbMarkersEmitted > 0);
    return frames.map(([name, width, height, expected]) => {
      const raw = path.join(output, `${mode.mode}-${name}.rgba`);
      const pixels = fs.readFileSync(raw);
      assert.equal(pixels.length, width * height * 4);
      for (let offset = 0; offset < pixels.length; offset += 4)
        expected.forEach((value, channel) =>
          assert(Math.abs(pixels[offset + channel] - value) <= (channel === 3 ? 0 : 1), name));
      const png = new PNG({width, height});
      pixels.copy(png.data);
      const image = path.join(results, `ue-rhi-viewport-${mode.mode}-${name}.png`);
      fs.writeFileSync(image, PNG.sync.write(png));
      return {mode: mode.mode, name, width, height, expected, rawSha256: sha(raw), image, imageSha256: sha(image)};
    });
  });
  frames.forEach(([name]) => assert.equal(images.find(image => image.name === name && image.mode === 'recorded').rawSha256,
    images.find(image => image.name === name && image.mode === 'bypass').rawSha256));
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  assert.equal(sha(commandletDLL), global.commandletDLLSha256);
  assert.equal(sha(commandlet), global.commandletSha256);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)), file.sha256);
  const log = fs.readFileSync(path.join(results, 'ue-rhi-viewport-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_VIEWPORT[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  Object.assign(report, {pass: true, date: new Date().toISOString(), runtime, images,
    moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandletDLLSha256: global.commandletDLLSha256, commandletSha256: global.commandletSha256,
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: runtime.modes.reduce((sum, mode) => sum + mode.checkedValues, 0),
    boundary: 'Temporary global RHI; real hidden Windows HWND surface; FIFO. Presentation calls and GPU readback verified, visible display and browser canvas are not tested.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-viewport-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
