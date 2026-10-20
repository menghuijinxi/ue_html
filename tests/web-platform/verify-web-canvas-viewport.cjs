const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, browserRuns: [], reports: [], sources: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-canvas-repro-20261020');
  const beforeGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(beforeGPU.length, 2);
  for (const run of beforeGPU) {
    const request = run.consoleLog.find(line => line.includes('P3_VIEWPORT_REQUEST '));
    assert(request);
    assert.deepEqual(JSON.parse(request.split('P3_VIEWPORT_REQUEST ')[1]), {
      window: '0', hasWindow: false, width: 640, height: 360, fullscreen: true, format: 18
    });
    assert.equal(run.startupBlocker, 'viewport-window-or-dimensions-invalid');
  }
  report.beforeFixRecordsAreHistorical = true;
  const beforeUsage = load('web-engine-webgpu-es31-results-surface-usage-repro-20261020');
  const usageGPU = beforeUsage.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(usageGPU.length, 2);
  assert(usageGPU.every(run => run.viewportRequest.hasWindow && !run.viewportRequest.fullscreen &&
    run.viewportRequest.format === 2 && run.consoleLog.some(line =>
      line.includes('Current viewport probe requires render attachment and CopySrc surface usages'))));
  const shim = path.join(root, '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/webgpu/src/webgpu.cpp');
  const shimText = fs.readFileSync(shim, 'utf8');
  const shimFunction = shimText.slice(shimText.indexOf('WGPUStatus wgpuSurfaceGetCapabilities('));
  assert(shimFunction.includes('capabilities->formats =') &&
    !shimFunction.slice(0, shimFunction.indexOf('return WGPUStatus_Success;')).includes('capabilities->usages'));
  report.sources.push(audit(shim));
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && !build.fullNormalUBTBuildVerified && build.sourceFiles.every(valid) &&
    build.linkInputs.every(valid) && build.products.every(valid) && valid(build.log));
  assert(build.recompiledObjects.every(item => build.linkInputs.some(input =>
    input.file === item.product.file && input.sha256 === item.product.sha256)));
  const prior = load('web-engine-webgpu-link-results-before-single-sample-raster-20261020');
  for (const name of ['Module.ApplicationCore.cpp', 'UEWebEngine.cpp', 'BrowserDynamicRHI.cpp',
    'BrowserViewport.cpp', 'Module.Launch.cpp', 'Module.SlateCore.3.cpp',
    'Module.RenderCore.3.cpp', 'Module.RenderCore.5.cpp', 'Module.Renderer.28.cpp',
    ...[23, 24, 46, 50, 53, 56, 65].map(n => `Module.Engine.${n}.cpp`)]) {
    const current = build.recompiledObjects.find(item => path.basename(item.source.file) === name);
    const compilation = current || (name === 'Module.RenderCore.3.cpp' ?
      prior.recompiledObjects.find(item => path.basename(item.source.file) === name) : null);
    assert(compilation && compilation.exitCode === 0 &&
      ['response', 'source', 'product', 'log'].every(key => valid(compilation[key])) &&
      build.linkInputs.some(item => item.file === compilation.product.file &&
        item.sha256 === compilation.product.sha256), name);
    if (!current) {
      assert(prior.pass && valid(prior.log) && valid(prior.moduleCompileLog));
      report.retainedCompilation = compilation;
    }
  }
  const application = load('web-application-results');
  const target = load('web-application-target-results');
  assert(target.pass && target.buildSucceeded && target.sourceFiles.every(valid) &&
    target.sourceAudit.every(item => valid(item) && sha(item.copied) === item.copiedSha256) &&
    target.platformAudit.every(item => valid(item) && sha(item.copied) === item.copiedSha256) &&
    target.objectAudit.every(item => valid(item) && sha(item.response) === item.responseSha256));
  assert(application.pass && application.sourceFiles.every(valid) && application.stagedFiles.every(valid) &&
    application.targetReportSha256 === sha(path.join(results, 'web-application-target-results.json')));
  assert.equal(application.browserRuns.length, 4);
  assert(application.browserRuns.every(run => run.pass && run.errors.length === 0 &&
    ['browser-frames-advance', 'canvas-resize-and-dpi', 'html-ui-keeps-keyboard-input',
      'destroy-removes-input-callbacks'].every(name => run.checks.includes(name))));
  report.applicationProfiles = application.browserRuns.map(run => ({
    browser: run.browser, profile: run.profile, deviceScaleFactor: run.deviceScaleFactor,
    checks: run.checks.length
  }));
  for (const relative of [
    'Platforms/Web/Source/Runtime/ApplicationCore/Private/Web/WebApplication.cpp',
    'Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformProperties.h'
  ]) {
    const source = path.join(root, 'reference-engine/Engine', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine', relative);
    assert.equal(sha(source), sha(copied));
    report.sources.push(audit(source), audit(copied));
  }
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.canvasViewportConfiguredVerified && runtime.sourceFiles.every(valid) &&
    runtime.configFiles.every(valid) && valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.deviceReady && run.stagedContentVerified && run.textureUploads.pass &&
      run.gpuValidationErrors.length === 0 && run.viewportRequest.hasWindow &&
      run.viewportRequest.window !== '0' && !run.viewportRequest.fullscreen && run.viewportRequest.format === 2);
    assert(run.consoleLog.some(line => line.includes('P3_WEB windowed canvas backbuffer setting=0')));
    assert(!run.errors.some(error => /Viewport requires a valid window|supports windowed presentation only|viewport currently supports RGBA8/.test(error)));
    assert(run.canvas.configurations.length > 0);
    assert.deepEqual(run.canvas.failures, []);
    for (const config of run.canvas.configurations) {
      assert(config.canvas === 'canvas' && config.deviceMatched && config.format === 'bgra8unorm');
      assert(config.width === config.cssWidth * config.devicePixelRatio &&
        config.height === config.cssHeight * config.devicePixelRatio);
      assert.equal(config.usage, 17);
    }
    report.browserRuns.push({browser: run.browser, version: run.version,
      viewportRequest: run.viewportRequest, viewportConfigured: run.viewportConfigured,
      canvas: run.canvas, frames: run.frames, startupBlocker: run.startupBlocker});
  }
  const nativeFile = path.join(__dirname, 'build/ue-rhi-canvas-viewport/viewport-rhi-results.json');
  const native = read(nativeFile);
  report.sources.push(audit(nativeFile), audit(path.join(results, 'web-canvas-native-viewport.log')));
  assert(native.pass && native.nativeSurfacePresentationVerified &&
    native.renderResourceLifecycleVerified && native.hostRHI === 'Null');
  assert.deepEqual(native.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const frames = [
    ['surface-first-frame', 64, 64, [191, 64, 128, 255]],
    ['surface-resized-frame', 96, 48, [32, 191, 64, 255]],
    ['surface-skipped-frame', 96, 48, [32, 64, 191, 255]],
    ['surface-resumed-frame', 96, 48, [128, 64, 191, 255]]
  ];
  for (const mode of native.modes) {
    assert(mode.pass && mode.errors.length === 0 && mode.checks.length === 36 &&
      mode.checks.every(check => check.pass) && mode.checkedValues === 71988);
    for (const name of ['reject-null-window', 'reject-zero-viewport', 'reject-oversized-viewport',
      'reject-fullscreen-viewport', 'reject-unsupported-viewport-format'])
      assert(mode.checks.some(check => check.name === name && check.pass));
    assert(mode.framesAcquired === 4 && mode.framesPresented === 3 && mode.framesSkipped === 1 &&
      mode.viewportsResized === 1 && mode.finalizedCommandLists === mode.submittedCommandLists);
    for (const [name, width, height, expected] of frames) {
      const file = path.join(path.dirname(nativeFile), `${mode.mode}-${name}.rgba`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, width * height * 4);
      for (let offset = 0; offset < bytes.length; ++offset)
        assert(Math.abs(bytes[offset] - expected[offset % 4]) <= (offset % 4 === 3 ? 0 : 1));
      report.sources.push(audit(file));
    }
  }
  report.nativeViewportChecks = 72;
  report.nativeComparedValues = 143976;
  for (const relative of [
    'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUViewport.cpp',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUViewportProbe.cpp',
    'tests/web-platform/capture-web-canvas.cjs', 'tests/web-platform/verify-web-canvas-viewport.cjs'
  ]) report.sources.push(audit(path.join(root, relative)));
  report.canvasViewportConfiguredVerified = true;
  report.pass = true;
  report.boundary = 'Actual wasm64 Engine RHICreateViewport reaches browser GPUCanvasContext.configure with a stable single-window identity, explicit windowed mode and real BGRA8 surface configuration. The observer forwards original calls. Configuration alone does not prove surface acquisition, rendering, presentation or an Engine frame. ApplicationCore normal UBT and four desktop-browser DPR/size profiles, plus independent native HWND lifecycle and pixel readbacks, are checked. Native frames do not count as browser Engine frames. Mixed incremental Engine build and historical before-fix records remain explicit.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-canvas-viewport-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, canvasViewportConfiguredVerified: report.canvasViewportConfiguredVerified,
    nativeViewportChecks: report.nativeViewportChecks, browserRuns: report.browserRuns.map(run => ({
      browser: run.browser, configurations: run.canvas.configurations.length,
      acquisitions: run.canvas.acquisitions.length, frames: run.frames, startupBlocker: run.startupBlocker
    })), failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
