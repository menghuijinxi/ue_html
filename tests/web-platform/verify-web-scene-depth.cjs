const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, sceneDepthFormatBlockerResolved: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false, reports: [], sources: [audit(__filename)]};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-scene-depth-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.minimalMapLoaded && run.frames === 0 &&
    run.consoleLog.some(line => line.includes(
      'Failed to create texture SceneDepthZ with pixel format DepthStencil because it is not supported.')) &&
    run.errors.some(error => error.includes('FMinimalSceneTextures::InitializeViewFamily'))));
  const reproFile = path.join(__dirname, 'build/ue-rhi-depth-repro/global-rhi-results.json');
  const repro = read(reproFile);
  assert(!repro.pass && repro.modes.length === 2 && repro.modes.every(mode =>
    mode.checks.filter(check => !check.pass).every(check =>
      check.name === 'scene-depth-and-stencil-formats-registered') &&
    mode.checks.some(check => check.name === 'scene-depth-and-stencil-formats-registered' && !check.pass)));
  report.sources.push(audit(reproFile), audit(path.join(results, 'round46-depth-native-before.log')));
  report.beforeFixRecordsAreHistorical = true;
  const native = load('web-static-uniforms-native-results');
  assert(native.pass && native.sources.every(valid) && native.products.every(valid) &&
    native.fixtures.every(valid) && native.runs.every(run =>
      run.exitCode === 0 && valid(run.runtime) && valid(run.log)));
  const global = read(native.runs.find(run => run.mode === 'global').runtime.file);
  const names = [
    'scene-depth-and-stencil-formats-registered', 'scene-depth-rejects-unrelated-view-format',
    'scene-depth-rejects-missing-attachment-capability', 'scene-depth-rejects-multisampling',
    'scene-depth-reflected-bindings-validate-scalar-types',
    'scene-depth-reversed-z-occludes-farther-draws', 'scene-depth-aspect-loads-written-depth',
    'scene-stencil-aspect-loads-clear-value', 'scene-depth-host-format-registration-restored'
  ];
  assert.deepEqual(global.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  for (const mode of global.modes) {
    assert(mode.pass && mode.errors.length === 0 && mode.checks.every(check => check.pass));
    assert.deepEqual(mode.checks.filter(check => /^scene-(?:depth|stencil)-/.test(check.name))
      .map(check => check.name), names);
  }
  report.nativeDepthChecks = names.length * global.modes.length;
  const fullFile = path.join(__dirname, 'build/ue-rhi-depth-full/rhi-results.json');
  const full = read(fullFile);
  assert(full.pass && full.errors.length === 0 && full.draws === 43 && full.dispatches === 5 &&
    full.checkedValues === 1344520 && full.material.pass && full.transitions.pass &&
    full.transitions.checks.every(check => check.pass) && full.checks.every(check => check.pass) &&
    full.checks.some(check => check.name === 'reversed-z-depth-occlusion'));
  assert(full.transitions.checks.some(check =>
    check.name === 'depth-write-to-read-only-preserves-occlusion'));
  report.sources.push(audit(fullFile), audit(path.join(results, 'round46-depth-full.log')));
  report.nativeFullProbe = {draws: full.draws, dispatches: full.dispatches, checkedValues: full.checkedValues};
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && !build.fullNormalUBTBuildVerified && build.sourceFiles.every(valid) &&
    build.linkInputs.every(valid) && build.products.every(valid) && valid(build.log));
  for (const name of ['BrowserDynamicRHI', 'BrowserViewport', 'BrowserBreadcrumbs', 'BrowserBufferLock',
    'BrowserTransitions', 'WebGPUBrowserModule'])
    assert(build.recompiledObjects.some(item => path.basename(item.source.file) === `${name}.cpp` &&
      item.exitCode === 0 && ['source', 'response', 'product', 'log'].every(key => valid(item[key]))));
  const scene = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp');
  const overlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp');
  const installed = 'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/SceneTextures.cpp';
  const sceneText = fs.readFileSync(scene, 'utf8').replaceAll('\r', '');
  const webGuards = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/gm;
  const guards = [...sceneText.matchAll(webGuards)];
  assert.equal(guards.length, 3);
  assert(guards.every(match => /TextureArray = nullptr;/.test(match[1]) &&
    match[2].includes('ETextureDimension::Texture2DArray')));
  assert.equal(sceneText.replace(webGuards, '$2'), fs.readFileSync(installed, 'utf8').replaceAll('\r', ''));
  assert.equal(sha(scene), sha(overlay));
  const compilation = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.28.cpp');
  assert(compilation && ['source', 'response', 'product', 'log'].every(key => valid(compilation[key])) &&
    fs.readFileSync(compilation.source.file, 'utf8').includes('SceneTextures.cpp') &&
    build.linkInputs.some(item => item.file === compilation.product.file &&
      item.sha256 === compilation.product.sha256));
  report.sources.push(...[scene, overlay, installed].map(audit));
  const beforeArrays = load('web-engine-webgpu-es31-results-before-mobile-scene-arrays-20261020');
  assert(beforeArrays.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.startupBlocker.startsWith('WebGPU texture creation unsupported: dimension=1') &&
    run.errors.some(error => error.includes('SetupMobileSceneTextureUniformParameters'))));
  const lightsBefore = load('web-engine-webgpu-es31-results-before-dummy-forward-light-20261020');
  assert(lightsBefore.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.errors.some(error => error.includes('GetDefaultByteAddressBuffer') &&
      error.includes('SetupDummyForwardLightUniformParameters'))));
  const lightsSource = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/LightGridInjection.cpp');
  const lightsOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/LightGridInjection.cpp');
  const lightsText = fs.readFileSync(lightsSource, 'utf8');
  assert(lightsText.includes('#if PLATFORM_WEB\n\tForwardLightUniformParameters = FForwardLightUniformParameters();\n#else\n'));
  const priorLightBuild = load('web-engine-webgpu-link-results-before-dummy-forward-light-20261020');
  const priorLightSource = priorLightBuild.sourceFiles.find(item => item.file === lightsSource);
  assert(priorLightSource && sha(lightsSource) === sha(lightsOverlay));
  assert.equal(crypto.createHash('sha256').update(lightsText.replace(
    /^#if PLATFORM_WEB\r?\n([\s\S]*?)^#else\r?\n([\s\S]*?)^#endif\r?\n/gm, '$2')).digest('hex'),
    priorLightSource.sha256, 'The sole Web branch must preserve the exact previous lighting source bytes');
  const lightCompile = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.9.cpp');
  assert(lightCompile && ['source', 'response', 'product', 'log'].every(key => valid(lightCompile[key])) &&
    fs.readFileSync(lightCompile.source.file, 'utf8').includes('LightGridInjection.cpp') &&
    build.linkInputs.some(item => item.file === lightCompile.product.file &&
      item.sha256 === lightCompile.product.sha256));
  report.sources.push(audit(lightsSource), audit(lightsOverlay));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.minimalMapLoadedVerified && runtime.es31LibraryIntegrationVerified &&
    runtime.sourceFiles.every(valid) && valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(gpu.length === 2);
  for (const run of gpu) {
    assert(run.textureUploads.pass && run.gpuValidationErrors.length === 0 && run.engineQueueCompletion.pass);
    assert(!run.consoleLog.some(line => line.includes(
      'Failed to create texture SceneDepthZ with pixel format DepthStencil because it is not supported.')));
    assert(!run.errors.some(error => error.includes('SetupMobileSceneTextureUniformParameters') &&
      error.includes('GetDefaultTexture')));
    assert(!run.errors.some(error => error.includes('SetupDummyForwardLightUniformParameters') &&
      error.includes('GetDefaultByteAddressBuffer')));
    assert(Array.isArray(run.canvas.depthTextures) && Array.isArray(run.canvas.depthViews) &&
      Array.isArray(run.canvas.depthPasses));
    for (const texture of run.canvas.depthTextures)
      assert(texture.width > 0 && texture.height > 0 && texture.format === 'depth24plus-stencil8' &&
        texture.sampleCount === 1 && texture.mipLevelCount === 1);
  }
  report.sceneDepthFormatBlockerResolved = true;
  report.unusedMobileArrayDefaultsExcluded = true;
  report.unusedForwardLightingDefaultsExcluded = true;
  report.browserDepthAllocated = gpu.every(run => run.canvas.depthTextures.some(texture =>
    texture.label === 'SceneDepthZ'));
  report.browserDepthPassStarted = gpu.every(run => run.canvas.depthPasses.length > 0);
  report.localFogArrayDefaultBlocked = gpu.every(run =>
    run.startupBlocker?.includes('ExternalPooledTexture.IsValid()') &&
    run.errors.some(error => error.includes('SetDummyLocalFogVolumeForView') &&
      error.includes('GetZeroUIntArrayDummy')));
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.browserRuns = gpu.map(run => ({browser: run.browser, frames: run.frames,
    depthTextures: run.canvas.depthTextures, depthViews: run.canvas.depthViews,
    depthPasses: run.canvas.depthPasses, startupBlocker: run.startupBlocker}));
  report.pass = true;
  report.boundary = 'Native recorded and bypass tests use the real UE texture, transition, render-pass and PSO paths. '
    + 'Reversed-Z and a read-only second pass retain green occlusion pixels; a diagnostic WebGPU compute shader reads '
    + 'the actual depth-only and stencil-only views, requiring depth 0.75 and clear stencil 37. Host format registrations '
    + 'are restored after the temporary RHI. Browser observers forward original GPU calls and separately report actual '
    + 'allocation and pass creation; those can remain false when a later RDG setup failure precedes allocation. '
    + 'Three Web-only branches omit unused mobile array defaults; removing them restores the installed source body. '
    + 'Web initializes dummy forward-light parameters with the existing zeroing constructor and retains the uniform '
    + 'interface without allocating unused Raw/Structured light buffers; removing that branch restores the prior source. '
    + 'This phase resolves the unsupported SceneDepthZ format diagnostic, not every depth, stencil or shading feature. '
    + 'Stencil compare/write pipelines, depth filtering, MSAA, copies and mip chains remain outside this change. '
    + 'Current Engine ticks and later failures come from the runtime report. No rendered mesh or fresh full Web UBT is implied.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-scene-depth-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, nativeDepthChecks: report.nativeDepthChecks,
    sceneDepthFormatBlockerResolved: report.sceneDepthFormatBlockerResolved,
    browserDepthAllocated: report.browserDepthAllocated, browserDepthPassStarted: report.browserDepthPassStarted,
    localFogArrayDefaultBlocked: report.localFogArrayDefaultBlocked,
    engineLoopBrowserTickVerified: report.engineLoopBrowserTickVerified, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
