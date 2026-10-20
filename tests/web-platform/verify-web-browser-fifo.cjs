const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r', '');
const report = {date: new Date().toISOString(), pass: false, browserViewportEndVerified: false,
  physicalPresentationVerified: false, renderedSceneVerified: false,
  reports: [], sources: [audit(__filename)], browserRuns: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-browser-fifo-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.frames === 0 &&
    run.startupBlocker === 'viewport-fifo-vsync-request-mismatch' &&
    run.consoleLog.some(line => line.includes('Assertion failed: Args.bLockToVsync'))));
  report.beforeFixRecordsAreHistorical = true;
  const beforeBounds = load('web-engine-webgpu-es31-results-before-canvas-bounds-20261020');
  assert(beforeBounds.browserViewportEndVerified);
  const boundsFailures = beforeBounds.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(boundsFailures.length === 2 && boundsFailures.every(run => run.frames === 0 &&
    run.consoleLog.some(line => line.includes('GetFullScreenInfo is not expected to be called on this platform')) &&
    run.errors.some(error => error.includes('FGenericWindow::GetFullScreenInfo') &&
      error.includes('FSceneViewport::ResizeFrame'))));
  const previousLink = load('web-engine-webgpu-link-results-before-browser-fifo-20261020');
  const shim = path.join(root, '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg/webgpu/src');
  const shimJS = path.join(shim, 'library_webgpu.js'), shimCPP = path.join(shim, 'webgpu.cpp');
  for (const file of [shimJS, shimCPP]) {
    assert(valid(previousLink.sourceFiles.find(item => item.file === file)),
      'The pinned Emdawn SDK must remain unchanged');
    report.sources.push(audit(file));
  }
  assert(text(shimCPP).includes('static constexpr WGPUPresentMode kPresentMode = WGPUPresentMode_Fifo;'));
  const js = text(shimJS);
  assert(js.includes("abort('wgpuSurfacePresent is unsupported (use requestAnimationFrame via html5.h instead)');"));
  const viewport = path.join(root,
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUViewport.cpp');
  const source = text(viewport);
  assert(source.includes('Configuration.presentMode = WGPUPresentMode_Fifo;'));
  assert(source.includes('#if !defined(PLATFORM_WEB) || !PLATFORM_WEB\n' +
    '    checkf(Args.bLockToVsync, TEXT("Current WebGPU viewport supports FIFO/vsync presentation only"));\n#else\n'));
  assert(source.includes('check(Viewport.Configuration.presentMode == WGPUPresentMode_Fifo);'));
  assert(source.includes('#if !defined(PLATFORM_WEB) || !PLATFORM_WEB\n' +
    '        check(wgpuSurfacePresent(Viewport.Surface) == WGPUStatus_Success);\n#endif'));
  report.sources.push(audit(viewport));
  const slate = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/SlateRHIRenderer/Private/SlateRHIRenderer.cpp');
  const installedSlate = 'H:/UE_5.8/Engine/Source/Runtime/SlateRHIRenderer/Private/SlateRHIRenderer.cpp';
  assert.equal(sha(slate), sha(installedSlate));
  assert(text(slate).includes('bLockToVsync |= (CVar->GetInt() != 0);') &&
    text(slate).includes('/*.bLockToVsync*/ DrawPassInputs.bLockToVsync'));
  report.sources.push(audit(slate), audit(installedSlate));
  const link = load('web-engine-webgpu-link-results');
  assert(link.pass && !link.fullNormalUBTBuildVerified && link.sourceFiles.every(valid) &&
    link.linkInputs.every(valid) && link.products.every(valid) && valid(link.log));
  assert(link.recompiledObjects.some(item => path.basename(item.source.file) === 'BrowserViewport.cpp' &&
    item.exitCode === 0 && ['source', 'response', 'product', 'log'].every(key => valid(item[key]))));
  const native = load('web-static-uniforms-native-results');
  assert(native.pass && native.sources.every(valid) && native.products.every(valid) && native.fixtures.every(valid));
  assert(native.runs.every(run => run.exitCode === 0 && valid(run.runtime) && valid(run.log)));
  const nativeViewport = read(native.runs.find(run => run.mode === 'viewport').runtime.file);
  assert(nativeViewport.pass && nativeViewport.nativeSurfacePresentationVerified);
  for (const mode of nativeViewport.modes) {
    assert(mode.pass && mode.checks.length === 36 && mode.checks.every(check => check.pass) &&
      mode.errors.length === 0 && mode.framesPresented === 3 && mode.framesSkipped === 1 &&
      mode.checkedValues === 71988);
  }
  report.nativeViewportChecks = 72;
  const application = load('web-application-results');
  const target = load('web-application-target-results');
  assert(application.pass && application.targetReportSha256 ===
    sha(path.join(results, 'web-application-target-results.json')) &&
    application.sourceFiles.every(valid) && application.stagedFiles.every(valid));
  assert(target.pass && target.buildSucceeded && target.sourceFiles.every(valid) &&
    target.platformAudit.every(item => valid(item) && sha(item.copied) === item.copiedSha256) &&
    target.sourceAudit.every(item => valid(item) && sha(item.copied) === item.copiedSha256) &&
    target.objectAudit.every(item => valid(item) && sha(item.response) === item.responseSha256));
  assert.equal(application.browserRuns.length, 4);
  assert(application.browserRuns.every(run => run.pass && run.errors.length === 0 &&
    run.checks.length === 17 && run.checks.includes('canvas-display-bounds-match-css') &&
    run.checks.includes('resized-display-bounds-match-css') &&
    run.display.x === 0 && run.display.y === 0 && run.display.scale === run.deviceScaleFactor &&
    run.resizedDisplay.width === 320 && run.resizedDisplay.height === 180 &&
    run.resizedDisplay.scale === run.deviceScaleFactor));
  report.applicationChecks = 68;
  const build = load('web-system-textures-native-results');
  assert(build.pass && valid(build.buildLog) && valid(build.runtime) && build.products.every(valid));
  assert(native.products.every(item => build.products.some(product =>
    product.file === item.file && product.sha256 === item.sha256)));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.browserViewportEndVerified && runtime.es31LibraryIntegrationVerified &&
    runtime.sourceFiles.every(valid) && valid(runtime.buildReport) &&
    runtime.configFiles.every(valid) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.textureUploads.pass && run.gpuValidationErrors.length === 0);
    assert(run.viewportEnds.some(end => end.effectiveMode === 'browser-fifo' &&
      end.requestedVSync === false && end.present && end.ended > 0 && end.skipped === 0 &&
      end.backbufferReleased && end.submitted > 0));
    assert(run.canvas.failures.length === 0 && run.canvas.acquisitions.length >= 1);
    assert(run.canvas.queueSubmissions > 0 && run.canvas.submittedCommandBuffers > 0);
    assert(run.engineQueueCompletion.pass &&
      run.engineQueueCompletion.queueSubmissions >= run.canvas.queueSubmissions &&
      run.engineQueueCompletion.submittedCommandBuffers >= run.canvas.submittedCommandBuffers);
    assert(!run.consoleLog.some(line => line.includes('Current WebGPU viewport supports FIFO/vsync presentation only')));
    assert(!run.consoleLog.some(line => line.includes('GetFullScreenInfo is not expected to be called on this platform')));
    report.browserRuns.push({browser: run.browser, version: run.version, viewportEnds: run.viewportEnds,
      engineQueueSubmissions: run.canvas.queueSubmissions,
      engineGPUWork: {shaderModules: run.canvas.shaderModules, renderPipelines: run.canvas.renderPipelines,
        computePipelines: run.canvas.computePipelines, renderPasses: run.canvas.renderPasses,
        drawCalls: run.canvas.drawCalls, dispatchCalls: run.canvas.dispatchCalls},
      engineQueueCompletion: run.engineQueueCompletion, frames: run.frames,
      startupBlocker: run.startupBlocker});
  }
  report.browserViewportEndVerified = true;
  report.canvasDisplayBoundsVerified = true;
  report.pass = true;
  report.boundary = 'Only Web accepts the UE caller requesting unlocked VSync, while keeping the configured FIFO Canvas policy. Native VSync validation and explicit surface presentation remain unchanged; current native build and 72 viewport checks pass. Both browser Engines submit real command buffers, complete the queue before audit texture readbacks, finish the first viewport end and release their backbuffer references. Web GetFullScreenInfo returns the existing canvas virtual display in CSS pixels; 68 normal ApplicationCore checks cover DPR 1/2 and resize, without enabling browser fullscreen. These records are backend completion, not physical screen presentation, a rendered scene or successful Engine ticks. The initial Slate graph can be empty. The pinned Emdawn SDK and Slate caller are unchanged; a fresh full normal Web Engine UBT build is still unverified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-browser-fifo-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, browserViewportEndVerified: report.browserViewportEndVerified,
    nativeViewportChecks: report.nativeViewportChecks, applicationChecks: report.applicationChecks,
    canvasDisplayBoundsVerified: report.canvasDisplayBoundsVerified, browserRuns: report.browserRuns,
    failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
