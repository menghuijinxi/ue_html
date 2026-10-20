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
const report = {date: new Date().toISOString(), pass: false, breadcrumbMarkerForwardedVerified: false,
  reports: [], sources: [audit(__filename)], browserRuns: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-breadcrumb-string-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(oldGPU.length, 2);
  assert(oldGPU.every(run => run.frames === 0 && run.canvas.acquisitions.length === 1 &&
    run.errors.some(error => error.includes('Cannot mix BigInt') &&
      error.includes('makeStringFromStringView') && error.includes('RHIBeginBreadcrumbGPU'))));
  report.beforeFixRecordsAreHistorical = true;
  const focused = load('web-marker-abi-results');
  assert(focused.pass && focused.sources.every(valid) && valid(focused.build) &&
    focused.browserRuns.length === 4 && focused.browserRuns.every(run => run.pass));
  assert(focused.browserRuns.filter(run => run.variant === 'before').every(run =>
    !run.ok && run.markers.length === 0 && run.failure.includes('Cannot mix BigInt')));
  assert(focused.browserRuns.filter(run => run.variant === 'fixed').every(run =>
    run.ok && !run.failure && run.markers.length === 6 && run.errors.length === 0));
  const focusedBuild = read(focused.build.file);
  assert(focusedBuild.sources.every(valid) &&
    focusedBuild.variants.every(item => item.products.every(valid) && valid(item.log)));
  const link = load('web-engine-webgpu-link-results');
  assert(link.pass && valid(link.stringViewABI) && valid(link.emdawnPort) &&
    link.sourceFiles.every(valid) && link.linkInputs.every(valid) && link.products.every(valid) &&
    valid(link.linkResponse) && valid(link.generatedLinkResponse));
  const response = fs.readFileSync(link.linkResponse.file, 'utf8');
  assert(response.includes('--use-port=') && response.includes(link.emdawnPort.file.replaceAll('\\', '/')));
  const target = path.join(root, 'tests/ue-web-smoke/Source/UEWebEngine.Target.cs');
  assert(fs.readFileSync(target, 'utf8').includes('Platforms/Web/Build/emdawnwebgpu-ue.port.py'));
  report.sources.push(audit(target));
  const js = fs.readFileSync(link.products.find(item => item.file.endsWith('.js')).file, 'utf8');
  for (const name of ['wgpuCommandEncoderInsertDebugMarker', 'wgpuRenderPassEncoderInsertDebugMarker']) {
    const start = js.indexOf(`function _${name}(`);
    assert(start >= 0, `Actual generated wasm64 wrapper required: ${name}`);
    const wrapper = js.slice(start, start + 600);
    for (const parameter of ['encoderPtr', 'markerLabelPtr'])
      assert(wrapper.includes(`${parameter} = bigintToI53Checked(${parameter});`));
    assert(wrapper.includes('encoder.insertDebugMarker(WebGPU.makeStringFromStringView(markerLabelPtr));'));
  }
  const oldLink = load('web-engine-webgpu-link-results-before-ltc-defaults-20261020');
  const pinned = path.join(root, '.tools/emdawnwebgpu-v20261009.190412/emdawnwebgpu_pkg');
  const originalInputs = oldLink.sourceFiles.filter(item => item.file.startsWith(pinned + path.sep));
  assert(originalInputs.length > 5 && originalInputs.every(valid), 'Keep the pinned Emdawn SDK unchanged');
  report.sources.push(...originalInputs);
  const breadcrumbs = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUBreadcrumbs.cpp');
  assert(valid(oldLink.sourceFiles.find(item => item.file === breadcrumbs)),
    'Preserve the shared native/Web C++ breadcrumb implementation');
  report.sources.push(audit(breadcrumbs));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.es31LibraryIntegrationVerified && runtime.breadcrumbMarkerForwardedVerified &&
    runtime.canvasBackbufferAcquiredVerified && runtime.sourceFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.textureUploads.pass && !run.gpuValidationErrors.length);
    assert(run.canvas.debugMarkers.some(marker => marker.kind === 'command' && marker.label.length > 0));
    assert(!run.errors.some(error => error.includes('Cannot mix BigInt') || error.includes('makeStringFromStringView')));
    report.browserRuns.push({browser: run.browser, version: run.version, markers: run.canvas.debugMarkers,
      acquisitions: run.canvas.acquisitions.length, frames: run.frames, startupBlocker: run.startupBlocker});
  }
  report.breadcrumbMarkerForwardedVerified = true;
  report.canvasBackbufferAcquiredVerified = true;
  report.pass = true;
  report.boundary = 'Two signatures are appended after the pinned Emdawn signature table, leaving SDK and shared C++ implementation unchanged. The actual Engine forwards command-encoder breadcrumb strings and acquires real Canvas backbuffers in both browsers. Separate wasm64 positive/negative tests exercise both command/render-pass APIs, bounded lengths, UTF-8 and empty labels with queue completion. This does not imply an Engine frame, shader payload execution, presentation or a complete fresh normal UBT build.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-breadcrumb-abi-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, breadcrumbMarkerForwardedVerified: report.breadcrumbMarkerForwardedVerified,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
