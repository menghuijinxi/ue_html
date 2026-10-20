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
const report = {date: new Date().toISOString(), pass: false, es31LibraryIntegrationVerified: false,
  shaderPayloadDecompressionVerified: false, engineLoopBrowserTickVerified: false,
  fullNormalUBTBuildVerified: false, completeUEScene: false, reports: [], sources: [audit(__filename)]};

try {
  const load = name => {
    const file = path.join(results, name + '.json');
    report.reports.push(audit(file));
    return read(file);
  };
  const link = load('web-engine-webgpu-link-results');
  assert(link.pass && !link.fullNormalUBTBuildVerified && link.sourceFiles.every(valid) &&
    link.linkInputs.length === 415 && link.linkInputs.every(valid) && link.products.every(valid));
  assert(['log', 'moduleCompileLog', 'linkResponse', 'generatedLinkResponse', 'ubt'].every(key => valid(link[key])));
  assert(link.recompiledObjects.every(item => item.exitCode === 0 &&
    ['response', 'source', 'product', 'log'].every(key => valid(item[key]))));
  const cook = load('web-engine-webgpu-es31-cook-results');
  assert(cook.pass && cook.exitCode === 0 && cook.mode === 'WebGPU-ES31' &&
    cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && cook.products.every(valid) &&
    valid(cook.log) && cook.shaderFailures.length === 0 && valid(cook.shaderInventory.artifact));
  assert(cook.validateShaderJobCache && cook.jobCacheDDCDisabled && cook.shaderMapDDCDisabled &&
    cook.arguments.includes('-noshaderddc'));
  assert(fs.readFileSync(cook.log.file, 'utf8').includes('Cooked packages 164 Packages Remain 0 Total 164'));
  const stage = load('web-engine-webgpu-es31-stage-results');
  assert(stage.pass && valid(stage.cookReport) && valid(stage.pack) && valid(stage.manifest) &&
    stage.sourceFiles.every(valid) && stage.files.length === 329 && stage.omittedMetadata.length === 2);
  const map = load('web-minimal-map-results');
  assert(map.pass && map.sources.every(valid) && valid(map.map) && valid(map.log) &&
    valid(cook.minimalMapPreparation) && valid(cook.minimalMap) &&
    map.map.sha256 === cook.minimalMap.sha256);
  for (const suffix of ['.umap', '.uexp'])
    assert(stage.files.some(item => item.path === `/Engine/Programs/UEWebEngine/Content/WebMinimal${suffix}`));
  const archive = load('web-global-archive-results');
  assert(archive.pass && valid(archive.cook) && archive.artifacts.every(valid) &&
    archive.sourceFiles.every(valid) && archive.shaderMaps === 91 && archive.uniqueShaders === 726);
  const materials = load('web-material-completion-results');
  assert(materials.pass && materials.allFortyFailuresAccountedFor && valid(materials.cook) &&
    valid(materials.wasmLink) && valid(materials.materialABIBaseline) && materials.sourceFiles.every(valid));
  assert.deepEqual(materials.observedJobs, {global: 838, material: 213, localVertexFactory: 115, failed: 0});
  assert(materials.browserRuns.length === 2 && materials.browserRuns.every(run => run.pass));
  assert(materials.originalFortyCookIsHistorical && valid(materials.currentCook));
  const materialPolicy = load('web-material-policy-results');
  assert(materialPolicy.pass && materialPolicy.causeVerified && materialPolicy.defaultDecalShaderMismatchResolved &&
    materialPolicy.reports.every(valid) && materialPolicy.sourceFiles.every(valid));
  assert.deepEqual(materialPolicy.observedJobs, {global: 838, material: 211, localVertexFactory: 114, failed: 0});
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.sourceFiles.every(valid) && runtime.configFiles.every(valid) &&
    ['buildReport', 'stageReport', 'webgpuStageReport', 'configBundle'].every(key => valid(runtime[key])));
  assert(runtime.es31LibraryIntegrationVerified && runtime.globalShaderMapStartupPassed &&
    runtime.projectShaderLibraryOpenedVerified && runtime.fileCacheVerified &&
    runtime.nullRHITickVerified && runtime.rendererSettingsMatched && runtime.materialPolicyMatched && runtime.stagedContentVerified);
  assert(!runtime.completeUEScene);
  assert.equal(runtime.browserRuns.length, 4);
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  const nullRuns = runtime.browserRuns.filter(run => run.rhi === 'null');
  assert.equal(gpu.length, 2);
  assert.equal(nullRuns.length, 2);
  for (const run of runtime.browserRuns) {
    assert(run.stagedContentVerified && run.wasmLayoutVerified);
    assert.deepEqual(run.layout, {maxFieldAlignment: 4294967295, flags: 1, pointerBytes: 8});
  }
  for (const run of gpu) {
    assert(run.deviceReady && run.rhiFactorySelected && run.preRHIResourcesInitialized &&
      run.shaderLibraryOpened && run.projectShaderLibraryOpened && run.globalShaderMapStartupPassed);
    assert.equal(run.gpuValidationErrors.length, 0);
    if (run.pass)
      assert(run.frames >= 9 && run.errors.length === 0 && !run.startupBlocker);
    else
      assert(run.startupBlocker && run.errors.length > 0 && run.failure);
    assert(!run.consoleLog.some(line => line.includes('incompatible memory image')));
    assert(!run.consoleLog.some(line => line.includes('WebGPURHI operation is not implemented: RHICalcTexturePlatformSize')));
    for (const [name, count] of [['Global', 726], ['UEWebEngine', 108]])
      assert(run.consoleLog.some(line =>
        line.includes(`ShaderArchive-${name}-SF_WEBGPU_ES31-SP_WEBGPU_ES31.ushaderbytecode`) &&
        line.includes(`Total ${count} unique shaders.`)));
  }
  assert(nullRuns.every(run => run.pass && run.frames >= 9 && run.errors.length === 0 && run.fileCacheVerified));
  const textures = load('web-texture2d-results');
  assert(textures.pass && valid(textures.runtime) && valid(textures.build) && valid(textures.cook) &&
    textures.sources.every(valid) && textures.browserRuns.length === 2 &&
    textures.browserRuns.every(run => run.pass && run.checkedBytes >= 7576620 && run.mips >= 65));
  for (const run of gpu) {
    const verified = textures.browserRuns.find(item => item.browser === run.browser);
    assert(verified && verified.checkedBytes === run.textureUploads.checkedBytes &&
      verified.mips === run.textureUploads.mips.length && verified.textures === run.textureUploads.textures);
  }
  report.textureMipUploadsVerified = true;
  const debugDefaults = load('web-debug-defaults-results');
  assert(debugDefaults.pass && debugDefaults.debugVolumeDefaultsExcluded &&
    debugDefaults.sourceFiles.every(valid) && debugDefaults.reports.every(valid));
  report.debugVolumeDefaultsExcluded = true;
  const systemDefaults = load('web-system-textures-results');
  assert(systemDefaults.pass && systemDefaults.systemDefaultsVerified &&
    systemDefaults.sourceFiles.every(valid) && systemDefaults.reports.every(valid) &&
    systemDefaults.nativeFormatChecks === 112 && systemDefaults.browserRuns.length === 2);
  report.systemDefaultsVerified = true;
  const canvas = load('web-canvas-viewport-results');
  assert(canvas.pass && canvas.canvasViewportConfiguredVerified && canvas.sources.every(valid) &&
    canvas.reports.every(valid) && canvas.nativeViewportChecks === 72 &&
    canvas.browserRuns.length === 2 && runtime.canvasViewportConfiguredVerified);
  report.canvasViewportConfiguredVerified = true;
  const ltc = load('web-ltc-defaults-results');
  assert(ltc.pass && ltc.ltcDefaultsExcluded && ltc.sources.every(valid) && ltc.reports.every(valid));
  report.ltcDefaultsExcluded = true;
  const breadcrumb = load('web-breadcrumb-abi-results');
  assert(breadcrumb.pass && breadcrumb.breadcrumbMarkerForwardedVerified &&
    breadcrumb.canvasBackbufferAcquiredVerified && breadcrumb.sources.every(valid) &&
    breadcrumb.reports.every(valid) && runtime.breadcrumbMarkerForwardedVerified &&
    runtime.canvasBackbufferAcquiredVerified);
  report.breadcrumbMarkerForwardedVerified = true;
  report.canvasBackbufferAcquiredVerified = true;
  const staticUniforms = load('web-static-uniforms-results');
  assert(staticUniforms.pass && staticUniforms.staticUniformBindingVerified &&
    staticUniforms.sources.every(valid) && staticUniforms.reports.every(valid) &&
    staticUniforms.nativeStaticChecks === 38 && staticUniforms.nativeEmptyUniformChecks === 8 &&
    runtime.staticUniformStartupVerified);
  report.staticUniformBindingVerified = true;
  const browserFIFO = load('web-browser-fifo-results');
  assert(browserFIFO.pass && browserFIFO.browserViewportEndVerified &&
    !browserFIFO.physicalPresentationVerified && !browserFIFO.renderedSceneVerified &&
    browserFIFO.sources.every(valid) && browserFIFO.reports.every(valid) &&
    browserFIFO.nativeViewportChecks === 72 && browserFIFO.applicationChecks === 68 &&
    browserFIFO.canvasDisplayBoundsVerified && runtime.browserViewportEndVerified);
  report.browserViewportEndVerified = true;
  report.canvasDisplayBoundsVerified = true;
  const payload = load('web-shader-payload-results');
  assert(payload.pass && payload.uncompressedArchivesVerified && payload.browserShaderCreationVerified &&
    payload.browserClearDrawSubmittedVerified && payload.nativePacketChecks === 16 &&
    payload.nativeSingleSampleChecks === 2 && payload.unchangedJobs === 1049 &&
    payload.sources.every(valid) && payload.reports.every(valid) &&
    payload.libraries.length === 2 && payload.libraries.every(item =>
      valid(item.before) && valid(item.archive) && item.compressedShaders === 0 &&
      item.hashesAndMapReferencesUnchanged));
  assert(runtime.browserShaderCreationVerified && runtime.browserClearDrawSubmittedVerified);
  const pso = load('web-pso-consolidation-results');
  assert(pso.pass && pso.synchronousPSOConsolidationVerified && pso.gpuSceneLightExclusionVerified &&
    pso.sources.every(valid) && pso.reports.every(valid));
  assert(runtime.synchronousPSOConsolidationConfigured && runtime.gameEngineInitializedVerified &&
    runtime.minimalMapLoadedVerified && !runtime.startupMapMissingObserved);
  assert(runtime.browserRuns.every(run => run.minimalMapLoaded &&
    run.world.package === '/Game/WebMinimal' && run.world.begunPlay && !run.world.exitRequested));
  assert(gpu.every(run =>
    run.startupBlocker !== 'Resource access mismatch: current=0x1000 requested=0x2' &&
    !run.consoleLog.some(line => line.includes('Consolidate was hit while Get/SetPSO was running')) &&
    run.canvas.shaderModules >= 2 && run.canvas.renderPipelines >= 1 &&
    run.canvas.drawCalls >= 1 && run.canvas.submittedCommandBuffers >= 15));
  const beforePresent = load('web-engine-webgpu-es31-results-before-present-transition-20261020');
  const afterPresent = load('web-engine-webgpu-es31-results-before-rhi-tick-20261020');
  assert(beforePresent.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.frames === 0 && run.startupBlocker === 'Resource access mismatch: current=0x1000 requested=0x2' &&
    run.errors.some(error => error.includes('RHIEndDrawingViewport') && error.includes('FEngineLoop::Tick'))));
  assert(afterPresent.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.frames === 0 && run.startupBlocker === 'WebGPURHI operation is not implemented: RHITick' &&
    run.viewportEnds.length === 2 && run.viewportEnds.every(end => end.backbufferReleased)));
  report.presentBeforeAfterRecordsAreHistorical = true;
  const rhiSource = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp');
  const viewportSource = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUViewport.cpp');
  const rhiText = fs.readFileSync(rhiSource, 'utf8');
  assert(rhiText.includes('GRHIGlobals.NeedsExtraTransitions = true;') &&
    rhiText.includes('void FWebGPUDynamicRHI::RHITick(float DeltaTime)') &&
    rhiText.includes('GRHIMaxDispatchThreadGroupsPerDimension = FIntVector(Limits.maxComputeWorkgroupsPerDimension);'));
  assert(fs.readFileSync(viewportSource, 'utf8').includes('RequireAccess(Viewport.BackBuffer, ERHIAccess::Present)'));
  report.sources.push(audit(rhiSource), audit(viewportSource));
  const mobile = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp');
  const mobileOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp');
  const mobileInstalled = 'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp';
  const mobileText = fs.readFileSync(mobile, 'utf8').replaceAll('\r', '');
  const webGuards = /^#if !PLATFORM_WEB\n([\s\S]*?)^#endif\n/gm;
  assert.equal([...mobileText.matchAll(webGuards)].length, 4);
  assert.equal(mobileText.replace(webGuards, '$1'), fs.readFileSync(mobileInstalled, 'utf8').replaceAll('\r', ''));
  assert.equal(sha(mobile), sha(mobileOverlay));
  const mobileCompile = link.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.16.cpp');
  assert(mobileCompile && ['source', 'response', 'product', 'log'].every(key => valid(mobileCompile[key])) &&
    fs.readFileSync(mobileCompile.source.file, 'utf8').includes('MobileShadingRenderer.cpp') &&
    link.linkInputs.some(item => item.file === mobileCompile.product.file && item.sha256 === mobileCompile.product.sha256));
  report.sources.push(audit(mobile), audit(mobileOverlay), audit(mobileInstalled));
  const scene = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp');
  const sceneOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp');
  const sceneInstalled = 'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp';
  const sceneText = fs.readFileSync(scene, 'utf8').replaceAll('\r', '');
  const profileBlock = /\/\/ Subsurface\n#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/m;
  const profile = sceneText.match(profileBlock);
  assert(profile && profile[1].includes('SSProfilesPreIntegratedTexture = nullptr;') &&
    !profile[1].includes('GetSSProfilesPreIntegratedTextureWithFallback') &&
    profile[2].includes('GetSSProfilesPreIntegratedTextureWithFallback'));
  const webViewBlocks = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/gm;
  assert.equal([...sceneText.matchAll(webViewBlocks)].length, 3);
  const priorViewBuild = load('web-engine-webgpu-link-results-before-present-transition-20261020');
  const priorScene = priorViewBuild.sourceFiles.find(item => item.file === scene);
  assert(priorScene);
  const rawScene = fs.readFileSync(scene, 'utf8');
  const restoredRawScene = rawScene.replace(
    /^#if PLATFORM_WEB\r?\n([\s\S]*?)^#else\r?\n([\s\S]*?)^#endif\r?\n/gm, '$2');
  assert.equal(crypto.createHash('sha256').update(restoredRawScene).digest('hex'), priorScene.sha256,
    'Removing this round Web view guards must restore the exact previous source bytes');
  assert.equal(sha(scene), sha(sceneOverlay));
  const profileRepro = load('web-engine-webgpu-es31-results-before-profile-consumer-20261020');
  assert(profileRepro.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.failure === 'RuntimeError: memory access out of bounds' &&
    run.errors.some(error => error.includes('FViewInfo::SetupUniformBufferParameters'))));
  assert(gpu.every(run => !run.errors.some(error =>
    error.includes('memory access out of bounds') && error.includes('FViewInfo::SetupUniformBufferParameters'))));
  const skyRepro = load('web-engine-webgpu-es31-results-before-mobile-sky-reflection-20261020');
  assert(skyRepro.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.failure === 'RuntimeError: memory access out of bounds' &&
    run.errors.some(error => error.includes('SetupMobileSkyReflectionUniformParameters'))));
  assert(gpu.every(run => !run.errors.some(error =>
    error.includes('memory access out of bounds') && error.includes('SetupMobileSkyReflectionUniformParameters'))));
  report.sources.push(audit(scene), audit(sceneOverlay), audit(sceneInstalled));
  report.uncompressedShaderArchivesVerified = true;
  report.browserShaderCreationVerified = true;
  report.browserClearDrawSubmittedVerified = true;
  report.synchronousPSOConsolidationVerified = true;
  report.gpuSceneLightExclusionVerified = true;
  report.engineInitReturnedVerified = runtime.engineInitReturnedVerified;
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.firstTickPresentAccessBlockerResolved = true;
  report.minimalMapLoadedVerified = true;
  report.emptyUniformBufferLifecycleVerified = true;
  report.mobileOptionalResourcesExcluded = true;
  report.profileAndSkyReflectionBeforeAfterRecordsAreHistorical = true;
  report.sceneDepthCreationBlocked = gpu.every(run =>
    run.consoleLog.some(line => line.includes(
      'Failed to create texture SceneDepthZ with pixel format DepthStencil because it is not supported.')) &&
    run.errors.some(error => error.includes('FRHITextureDesc::Validate') &&
      error.includes('FMinimalSceneTextures::InitializeViewFamily')));
  const depth = load('web-scene-depth-results');
  assert(depth.pass && depth.sceneDepthFormatBlockerResolved && depth.nativeDepthChecks === 18 &&
    depth.unusedMobileArrayDefaultsExcluded && depth.unusedForwardLightingDefaultsExcluded &&
    depth.sources.every(valid) && depth.reports.every(valid) &&
    !report.sceneDepthCreationBlocked);
  report.sceneDepthFormatBlockerResolved = true;
  report.nativeDepthChecks = depth.nativeDepthChecks;
  report.browserDepthAllocated = depth.browserDepthAllocated;
  report.browserDepthPassStarted = depth.browserDepthPassStarted;
  report.localFogArrayDefaultBlocked = depth.localFogArrayDefaultBlocked;
  const localFog = load('web-local-fog-defaults-results');
  assert(localFog.pass && localFog.localFogDefaultsExcluded && localFog.basePassArrayDefaultsExcluded &&
    localFog.basePassOptionalDefaultsExcluded &&
    localFog.sources.every(valid) &&
    localFog.reports.every(valid) && !report.localFogArrayDefaultBlocked);
  report.localFogDefaultsExcluded = true;
  report.basePassArrayDefaultsExcluded = true;
  report.basePassOptionalDefaultsExcluded = true;
  report.renderCurveDefaultBlocked = localFog.renderCurveDefaultBlocked;
  const renderCurve = load('web-render-curve-defaults-results');
  assert(renderCurve.pass && renderCurve.renderCurveDefaultsExcluded && renderCurve.naniteDefaultsExcluded &&
    renderCurve.sources.every(valid) && renderCurve.reports.every(valid) &&
    !renderCurve.renderCurveDefaultBlocked && !report.renderCurveDefaultBlocked);
  report.renderCurveDefaultsExcluded = true;
  report.naniteDefaultsExcluded = true;
  report.skinningDefaultBlocked = renderCurve.skinningDefaultBlocked;
  report.startupMapMissingObserved = false;
  const targetCache = path.join(root, 'reference-engine/Engine/Source/Runtime/Core/Private/FileCache/FileCache.cpp');
  const installedCache = 'H:/UE_5.8/Engine/Source/Runtime/Core/Private/FileCache/FileCache.cpp';
  const cacheText = fs.readFileSync(targetCache, 'utf8').replaceAll('\r', '');
  const webBlocks = cacheText.match(/^#if defined\(PLATFORM_WEB\) && PLATFORM_WEB\n[\s\S]*?^#endif\n/gm);
  assert.equal(webBlocks?.length, 3);
  assert.equal(cacheText.replace(/^#if defined\(PLATFORM_WEB\) && PLATFORM_WEB\n[\s\S]*?^#endif\n/gm, ''),
    fs.readFileSync(installedCache, 'utf8').replaceAll('\r', ''),
  'Desktop file-cache implementation must remain identical to the installed source');
  report.sources.push(audit(targetCache), audit(installedCache));
  const native = load('native-rendercore-build-results');
  assert(native.pass && native.installedInputs.every(valid));
  report.installedInputs = native.installedInputs;
  report.cookPackages = 164;
  report.stagedFiles = stage.files.length;
  report.stagedBytes = stage.totalBytes;
  report.libraryShaders = {global: 726, project: 108};
  report.materialPolicyMatched = true;
  report.defaultDecalShaderMismatchResolved = true;
  report.observedJobs = materialPolicy.observedJobs;
  report.browserRuns = runtime.browserRuns.map(run => ({
    browser: run.browser, rhi: run.rhi, frames: run.frames, layout: run.layout,
    fileCache: run.fileCache, shaderLibraryOpened: run.shaderLibraryOpened,
    projectShaderLibraryOpened: run.projectShaderLibraryOpened, startupBlocker: run.startupBlocker
  }));
  report.es31LibraryIntegrationVerified = true;
  report.pass = true;
  report.boundary = 'Phase pass covers actual ES3.1 Cook/Stage and its unchanged 1049 WGSL jobs and shader-map references. The project map has no placed scene meshes; it uses the built-in GameModeBase and DefaultPawn at runtime. It is cooked, mounted and reaches BeginPlay in both browser engines and both RHI modes without an exit request; valid NullRHI ticks and file-cache lifecycle are checked. Historical before/after records locate the original first-Tick Present error and show the extra transition reaches the later RHITick call. The current backend retains Present access validation and implements owner-thread event processing without browser blocking. Native viewport pixels and recorded/bypass empty-uniform creation and snapshot updates pass. Four Web guards omit GPU debug messaging, unused lighting profiles, VSM initialization and sky reflection updates; removing only those guards restores the complete installed mobile renderer, and the actual changed unity is linked. Three corresponding view-parameter guards preserve the exact prior SceneRendering source bytes outside their Web branches. Historical profile and sky-reflection crashes are recorded separately and absent from current browser runs. Same-binary PSO controls and all previous shader, texture and platform regressions remain separate audited evidence. The scene-depth phase requires 18 native depth/stencil checks and the full native RHI probe, including reversed-Z, read-only depth and real aspect readback. Three Web branches omit mobile array defaults and the existing zeroing constructor avoids unused dummy-light buffers; removal restores the audited prior source bodies. The local-fog phase checks zero/default parameters without optional resource creation, the disabled six shader types, strict DBuffer policy and unused BasePass arrays/reflections/debug defaults. Removing those Web branches restores audited previous source bodies. RenderCurve retains registration while Web disables the extension and zeroes its unused default parameters; its actual changed unity is compiled and linked, and both browsers must pass the historical Raw Buffer failure. Browser depth allocations and render passes remain separate observed fields. Current hardware Init completion, ticks and later blockers are copied from the runtime report; sceneDepthCreationBlocked identifies the unsupported SceneDepthZ format only when its diagnostic and real validation stack are both present. Phase pass does not imply runtime pass. No rendered mesh, camera interaction, HTML UI, physical presentation or fresh full normal Web UBT build is verified. The build remains mixed 5.8.3/5.8.0 and incremental.';
  report.boundary += ' Disabled Nanite material/ownership default callbacks are zeroed without Raw/Structured '
    + 'Buffer allocation, their existing capability checks and registrations remain, and their actual unity '
    + 'and the unchanged material symbol provider are recompiled and linked.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-es31-runtime-integration-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, es31LibraryIntegrationVerified: report.es31LibraryIntegrationVerified,
    stagedFiles: report.stagedFiles, stagedBytes: report.stagedBytes,
    minimalMapLoadedVerified: report.minimalMapLoadedVerified,
    engineInitReturnedVerified: report.engineInitReturnedVerified,
    engineLoopBrowserTickVerified: report.engineLoopBrowserTickVerified,
    sceneDepthCreationBlocked: report.sceneDepthCreationBlocked,
    sceneDepthFormatBlockerResolved: report.sceneDepthFormatBlockerResolved,
    browserDepthAllocated: report.browserDepthAllocated, browserDepthPassStarted: report.browserDepthPassStarted,
    localFogArrayDefaultBlocked: report.localFogArrayDefaultBlocked,
    localFogDefaultsExcluded: report.localFogDefaultsExcluded,
    basePassArrayDefaultsExcluded: report.basePassArrayDefaultsExcluded,
    basePassOptionalDefaultsExcluded: report.basePassOptionalDefaultsExcluded,
    renderCurveDefaultBlocked: report.renderCurveDefaultBlocked,
    renderCurveDefaultsExcluded: report.renderCurveDefaultsExcluded,
    naniteDefaultsExcluded: report.naniteDefaultsExcluded,
    skinningDefaultBlocked: report.skinningDefaultBlocked,
    completeUEScene: report.completeUEScene,
    failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
