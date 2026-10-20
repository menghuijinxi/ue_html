const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, 'results');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, ''));
const currentHash = file => file && fs.existsSync(file) ?
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
function native(name) {
  const result = fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/)
    .find(line => line.startsWith('P0_RESULT '));
  if (!result) throw Error(`Native report missing: ${name}`);
  return JSON.parse(result.substring(10));
}
const gpu = native('native-webgpu.log');
const abi = native('native-abi.log');
const chrome = read('browser-results.json');
const edge = read('edge-results.json');
const shaderBuild = read('shader-build-results.json');
const shaderChrome = read('shader-browser-tier2-results.json');
const shaderEdge = read('shader-edge-tier2-results.json');
const graphics = [...chrome, ...edge].filter(result => result.variant.startsWith('gpu'));
const matchingHashes = graphics.every(result =>
  JSON.stringify(result.report.pixelHashes) === JSON.stringify(gpu.pixelHashes));
const summary = {
  date: new Date().toISOString(),
  nativeGpuPass: gpu.pass, nativeAbiPass: abi.pass,
  chromePassed: chrome.filter(result => result.pass).length, chromeTotal: chrome.length,
  edgePassed: edge.filter(result => result.pass).length, edgeTotal: edge.length,
  matchingPixelHashes: matchingHashes, pixelHashes: gpu.pixelHashes,
  p0Pass: gpu.pass && abi.pass && matchingHashes && chrome.every(result => result.pass) &&
    edge.every(result => result.pass),
  shaderConversionsSucceeded: shaderBuild.cases.filter(result =>
    !result.expectedRejection && result.pass).length,
  shaderExpectedRejections: shaderBuild.cases.filter(result =>
    result.expectedRejection && result.pass).map(result => result.name),
  shaderRuntimeTier2Pass: shaderChrome.every(result => result.pass) &&
    shaderEdge.every(result => result.pass),
  completeUECompiler: false, completeUEScene: false,
};
if (fs.existsSync(path.join(root, 'ue-full-shader-build-results.json'))) {
  const ueBuild = read('ue-full-shader-build-results.json');
  const ueRuntime = [...read('ue-full-chrome-results.json'), ...read('ue-full-edge-results.json')];
  summary.p1CoreProbePass = ueBuild.pass && ueRuntime.length === 4 && ueRuntime.every(result =>
    result.pass && result.report.moduleCount === ueBuild.convertedCount);
  summary.p1Complete = false;
  summary.ueHostEngine = ueBuild.hostEngine;
  summary.ueOriginalShaderCount = ueBuild.originalCount;
  summary.ueOriginalShadersConverted = ueBuild.originalConvertedCount;
  summary.ueClearFallbacksConverted = ueBuild.fallbackConvertedCount;
  summary.ueBindingContractsVerified = ueBuild.bindingContractCount;
  summary.ueExpectedOriginalRejections = ueBuild.expectedRejectionCount;
  summary.ueIncludeFilesVerified = ueBuild.includeAudit.length;
  summary.ueBrowserRunsPassed = ueRuntime.filter(result => result.pass).length;
  summary.ueCheckedValuesPerRun = ueRuntime.map(result => result.report.checkedValues);
  summary.completeWebShaderFormat = false;
}
if (fs.existsSync(path.join(root, 'ue-material-build-results.json'))) {
  const materialBuild = read('ue-material-build-results.json');
  const materialRuns = [...read('ue-material-chrome-results.json'), ...read('ue-material-edge-results.json')];
  summary.p1MaterialProbePass = materialBuild.pass && materialRuns.length === 4 && materialRuns.every(result =>
    result.pass && result.report.moduleCount === materialBuild.shaderCount);
  summary.ueMaterialShadersConverted = materialBuild.shaderCount;
  summary.ueMaterialBindingContractsVerified = materialBuild.bindingContractCount;
  summary.ueMaterialIncludeFilesVerified = materialBuild.includeAudit.length;
  summary.ueMaterialBrowserRunsPassed = materialRuns.filter(result => result.pass).length;
  summary.ueMaterialCheckedValuesPerRun = materialRuns.map(result => result.report.checkedValues);
}
if (fs.existsSync(path.join(root, 'ue-webformat-build-results.json')) &&
    fs.existsSync(path.join(root, 'ue-webformat-chrome-results.json')) &&
    fs.existsSync(path.join(root, 'ue-webformat-edge-results.json'))) {
  const formatBuild = read('ue-webformat-build-results.json');
  const formatRuns = [...read('ue-webformat-chrome-results.json'), ...read('ue-webformat-edge-results.json')];
  summary.p1WebFormatProbePass = formatBuild.pass && formatBuild.module.originalWorkerUnmodified &&
    formatRuns.length === 8 && formatRuns.every(result =>
      result.pass && result.report.shaderCompileWorkerIPCVerified && result.report.shaderSource === 'worker-bytecode');
  summary.shaderCompileWorkerIPCVerified = summary.p1WebFormatProbePass;
  summary.p1HostFormatRegistrationPass = summary.p1WebFormatProbePass &&
    formatBuild.reports.every(report => report.officialFormatRegistrationVerified);
  summary.webRuntimeShaderPlatformRegistered = false;
  summary.webCookPackagingImplemented = false;
  summary.ueWebFormatJobsVerified = formatBuild.reports.reduce((total, report) => total + report.jobs, 0);
  summary.ueWebFormatPacketsVerified = formatBuild.reports.reduce((total, report) => total + report.packets, 0);
  summary.ueWebFormatExpectedRejections = formatBuild.reports.reduce((total, report) => total + report.expectedRejections, 0);
  summary.ueWebPacketNegativeChecks = formatBuild.reports.reduce((total, report) => total + report.decoderNegativeChecks, 0);
  summary.ueWebFormatBrowserRunsPassed = formatRuns.filter(result => result.pass).length;
  summary.ueWebFormatCheckedValuesTotal = formatRuns.reduce((total, result) => total + result.report.checkedValues, 0);
  if (fs.existsSync(path.join(root, 'ue-standalone-chrome-regression-results.json')) &&
      fs.existsSync(path.join(root, 'ue-standalone-edge-regression-results.json'))) {
    const standalone = [...read('ue-standalone-chrome-regression-results.json'),
      ...read('ue-standalone-edge-regression-results.json')];
    summary.ueStandaloneRegressionPass = standalone.length === 8 && standalone.every(result =>
      result.pass && result.report.shaderSource === 'standalone-wgsl');
    summary.p1WebFormatProbePass &&= summary.ueStandaloneRegressionPass;
  }
}
if (fs.existsSync(path.join(root, 'ue-platform-build-results.json')) &&
    fs.existsSync(path.join(root, 'ue-platform-chrome-results.json')) &&
    fs.existsSync(path.join(root, 'ue-platform-edge-results.json'))) {
  const platformBuild = read('ue-platform-build-results.json');
  const platformNegatives = read('ue-platform-negative-results.json');
  const platformRuns = [...read('ue-platform-chrome-results.json'), ...read('ue-platform-edge-results.json')];
  summary.p1IndependentShaderPlatformProbePass = platformBuild.pass &&
    platformBuild.staticPlatformHost.pass &&
    platformNegatives.pass && platformNegatives.reports.length === 2 &&
    platformNegatives.reports.every(report => report.pass) &&
    platformBuild.reports.every(report => report.independentWebShaderPlatformVerified) &&
    platformRuns.length === 8 && platformRuns.every(result =>
      result.pass && result.report.independentWebShaderPlatformVerified &&
      result.report.shaderCompileWorkerIPCVerified);
  summary.webShaderPlatformMappingVerifiedInIsolatedHost = summary.p1IndependentShaderPlatformProbePass;
  summary.fullSourceEngineBuildCompleted = false;
  summary.webRuntimeShaderPlatformRegistered = false;
  summary.uePlatformRegistrationNegativeChecks = platformNegatives.reports.length;
  summary.uePlatformPacketPlatformNegativeChecks = platformBuild.reports.reduce(
    (sum, report) => sum + report.decoderPlatformNegativeChecks, 0);
  summary.uePlatformJobsVerified = platformBuild.reports.reduce((sum, report) => sum + report.jobs, 0);
  summary.uePlatformPacketsVerified = platformBuild.reports.reduce((sum, report) => sum + report.packets, 0);
  summary.uePlatformExpectedRejections = platformBuild.reports.reduce(
    (sum, report) => sum + report.expectedRejections, 0);
  summary.uePlatformPacketNegativeChecks = platformBuild.reports.reduce(
    (sum, report) => sum + report.decoderNegativeChecks, 0);
  summary.uePlatformBrowserRunsPassed = platformRuns.filter(result => result.pass).length;
  summary.uePlatformCheckedValuesTotal = platformRuns.reduce((sum, result) => sum + result.report.checkedValues, 0);
}
if (fs.existsSync(path.join(root, 'ue-rhi-build-results.json'))) {
  const rhi = read('ue-rhi-build-results.json');
  summary.p2CoreRHIProbePass = rhi.pass && rhi.runtime?.pass &&
    rhi.runtime.checks.length === 25 && rhi.runtime.checks.every(check => check.pass) &&
    rhi.runtime.errors.length === 0 && rhi.runtime.coreCounters.draws === 19 && rhi.runtime.coreCounters.dispatches === 2 &&
    rhi.runtime.finalizedCommandLists === rhi.runtime.submittedCommandLists;
  summary.p2MaterialRHIProbePass = rhi.pass && rhi.runtime?.material.pass &&
    rhi.runtime.material.checks.length === 32 && rhi.runtime.material.checks.every(check => check.pass) &&
    rhi.runtime.material.draws === 19 && rhi.runtime.material.resourceTableBindings === 20;
  summary.p2TransitionRHIProbePass = rhi.pass && rhi.runtime?.transitions.pass &&
    rhi.runtime.singleQueueTransitionsImplemented && !rhi.runtime.fullRHITransitionsImplemented &&
    !rhi.runtime.transitions.globalTransitionDispatchImplemented &&
    rhi.runtime.transitions.checks.length === 49 && rhi.runtime.transitions.checks.every(check => check.pass) &&
    rhi.runtime.transitions.created === 15 && rhi.runtime.transitions.begun === 15 &&
    rhi.runtime.transitions.ended === 15 && rhi.runtime.transitions.released === 15 &&
    rhi.runtime.transitionsCreated === rhi.runtime.transitionsReleased && rhi.runtime.pendingTransitionCount === 0;
  summary.p2Complete = false;
  summary.ueNativeRHIChecksPassed = rhi.runtime?.checks.filter(check => check.pass).length || 0;
  summary.ueNativeRHIMaterialChecksPassed = rhi.runtime?.material.checks.filter(check => check.pass).length || 0;
  summary.ueNativeRHIMaterialCheckedValues = rhi.runtime?.material.checkedValues || 0;
  summary.ueNativeRHITransitionChecksPassed = rhi.runtime?.transitions.checks.filter(check => check.pass).length || 0;
  summary.ueNativeRHITransitionCheckedValues = rhi.runtime?.transitions.checkedValues || 0;
  summary.ueNativeRHITotalChecksPassed = summary.ueNativeRHIChecksPassed +
    summary.ueNativeRHIMaterialChecksPassed + summary.ueNativeRHITransitionChecksPassed;
  summary.singleQueueRHITransitionsVerified = summary.p2TransitionRHIProbePass;
  summary.ueNativeRHICheckedValues = rhi.runtime?.checkedValues || 0;
  summary.ueNativeRHIDraws = rhi.runtime?.draws || 0;
  summary.ueNativeRHIDispatches = rhi.runtime?.dispatches || 0;
  summary.globalWebGPURHIReplaced = false;
  summary.completeBrowserUERuntime = false;
}
if (fs.existsSync(path.join(root, 'ue-rhi-global-build-results.json'))) {
  const global = read('ue-rhi-global-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2GlobalDispatchProbePass = global.pass && global.runtime?.pass &&
    global.moduleSha256 === core.moduleSha256 && global.runtime.hostRHI === 'Null' &&
    global.runtime.temporaryGlobalDispatchVerified && global.runtime.modes.length === 2 &&
    global.runtime.modes.every(mode => mode.pass && mode.errors.length === 0 && mode.checks.length === 22 &&
      mode.checks.every(check => check.pass) && mode.finalizedCommandLists === mode.submittedCommandLists);
  summary.temporaryGlobalWebGPURHIDispatchVerified = summary.p2GlobalDispatchProbePass;
  summary.importedWebGPURHIStartupVerified = false;
  summary.ueNativeRHIGlobalChecksPassed = global.checksPassed || 0;
  summary.ueNativeRHIGlobalCheckedValues = global.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed = summary.ueNativeRHITotalChecksPassed + summary.ueNativeRHIGlobalChecksPassed;
  summary.ueNativeRHIAllCheckedValues = summary.ueNativeRHICheckedValues + summary.ueNativeRHIGlobalCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-viewport-build-results.json'))) {
  const viewport = read('ue-rhi-viewport-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2ViewportRHIProbePass = viewport.pass && viewport.runtime?.pass &&
    viewport.moduleSha256 === core.moduleSha256 && viewport.runtime.hostRHI === 'Null' &&
    viewport.runtime.nativeSurfacePresentationVerified && viewport.runtime.renderResourceLifecycleVerified &&
    viewport.runtime.modes.length === 2 && viewport.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 36 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.framesAcquired === 4 && mode.framesPresented === 3 && mode.framesSkipped === 1);
  summary.nativeWebGPUSurfacePresentationVerified = summary.p2ViewportRHIProbePass;
  summary.webGPURenderResourceLifecycleVerified = summary.p2ViewportRHIProbePass;
  summary.ueNativeRHIViewportChecksPassed = viewport.checksPassed || 0;
  summary.ueNativeRHIViewportCheckedValues = viewport.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIViewportChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIViewportCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-texture-srv-build-results.json'))) {
  const srv = read('ue-rhi-texture-srv-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2TextureSRVProbePass = srv.pass && srv.runtime?.pass &&
    srv.moduleSha256 === core.moduleSha256 && srv.runtime.hostRHI === 'Null' &&
    srv.runtime.textureSRVDirectBindingVerified && srv.runtime.modes.length === 2 &&
    srv.runtime.modes.every(mode => mode.pass && mode.checks.length === 37 &&
      mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.draws === 6 && mode.checkedValues === 6144);
  summary.webGPUTextureSRVDirectBindingVerified = summary.p2TextureSRVProbePass;
  summary.ueNativeRHITextureSRVChecksPassed = srv.checksPassed || 0;
  summary.ueNativeRHITextureSRVCheckedValues = srv.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHITextureSRVChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHITextureSRVCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-buffer-srv-build-results.json'))) {
  const srv = read('ue-rhi-buffer-srv-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2BufferSRVProbePass = srv.pass && srv.runtime?.pass &&
    srv.moduleSha256 === core.moduleSha256 && srv.runtime.hostRHI === 'Null' &&
    srv.runtime.typedR32UintStorageSRVVerified && !srv.runtime.generalTypedBufferShaderLoweringImplemented &&
    srv.runtime.modes.length === 2 && srv.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 38 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 4 && mode.checkedValues === 1536);
  summary.webGPUTypedR32UintStorageSRVVerified = summary.p2BufferSRVProbePass;
  summary.generalTypedBufferShaderLoweringImplemented = false;
  summary.ueNativeRHIBufferSRVChecksPassed = srv.checksPassed || 0;
  summary.ueNativeRHIBufferSRVCheckedValues = srv.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIBufferSRVChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIBufferSRVCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-buffer-uav-build-results.json'))) {
  const uav = read('ue-rhi-buffer-uav-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2BufferUAVProbePass = uav.pass && uav.runtime?.pass &&
    uav.moduleSha256 === core.moduleSha256 && uav.runtime.hostRHI === 'Null' &&
    uav.runtime.typedR32UintStorageUAVVerified && !uav.runtime.generalTypedBufferShaderLoweringImplemented &&
    uav.runtime.modes.length === 2 && uav.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 41 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 6 && mode.checkedValues === 1792);
  summary.webGPUTypedR32UintStorageUAVVerified = summary.p2BufferUAVProbePass;
  summary.ueNativeRHIBufferUAVChecksPassed = uav.checksPassed || 0;
  summary.ueNativeRHIBufferUAVCheckedValues = uav.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIBufferUAVChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIBufferUAVCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-uint4-build-results.json'))) {
  const uint4 = read('ue-rhi-uint4-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2Uint4ViewsProbePass = uint4.pass && uint4.runtime?.pass &&
    uint4.moduleSha256 === core.moduleSha256 && uint4.runtime.hostRHI === 'Null' &&
    uint4.runtime.typedUint4StorageViewsVerified && !uint4.runtime.generalTypedBufferShaderLoweringImplemented &&
    uint4.runtime.modes.length === 2 && uint4.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 39 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 6 && mode.checkedValues === 4096);
  summary.webGPUTypedUint4StorageViewsVerified = summary.p2Uint4ViewsProbePass;
  summary.ueNativeRHIUint4ChecksPassed = uint4.checksPassed || 0;
  summary.ueNativeRHIUint4CheckedValues = uint4.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIUint4ChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIUint4CheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-structured-build-results.json'))) {
  const structured = read('ue-rhi-structured-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2StructuredViewsProbePass = structured.pass && structured.runtime?.pass &&
    structured.moduleSha256 === core.moduleSha256 && structured.runtime.hostRHI === 'Null' &&
    structured.runtime.structuredStorageViewsVerified && structured.runtime.modes.length === 4 &&
    structured.runtime.modes.every(mode => mode.pass && mode.checks.length === 50 &&
      mode.checks.every(check => check.pass) && mode.errors.length === 0 && mode.dispatches === 6 &&
      mode.checkedValues === (mode.stride === 4 ? 2048 : 8192));
  summary.webGPUStructuredStorageViewsVerified = summary.p2StructuredViewsProbePass;
  summary.ueNativeRHIStructuredChecksPassed = structured.checksPassed || 0;
  summary.ueNativeRHIStructuredCheckedValues = structured.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIStructuredChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIStructuredCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-float4-build-results.json'))) {
  const float4 = read('ue-rhi-float4-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2Float4ViewsProbePass = float4.pass && float4.runtime?.pass &&
    float4.moduleSha256 === core.moduleSha256 && float4.runtime.hostRHI === 'Null' &&
    float4.runtime.typedFloat4StorageViewsVerified && float4.runtime.probeOnlyShaders &&
    !float4.runtime.generalTypedBufferShaderLoweringImplemented && float4.runtime.modes.length === 2 &&
    float4.runtime.modes.every(mode => mode.pass && mode.checks.length === 41 &&
      mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 6 && mode.checkedValues === 8192);
  summary.webGPUTypedFloat4StorageViewsVerified = summary.p2Float4ViewsProbePass;
  summary.ueNativeRHIFloat4ChecksPassed = float4.checksPassed || 0;
  summary.ueNativeRHIFloat4CheckedValues = float4.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIFloat4ChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIFloat4CheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-buffer-lock-build-results.json'))) {
  const locks = read('ue-rhi-buffer-lock-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2BufferLockProbePass = locks.pass && locks.runtime?.pass &&
    locks.moduleSha256 === core.moduleSha256 && locks.runtime.hostRHI === 'Null' &&
    locks.runtime.bufferLockUploadVerified && locks.runtime.synchronousNativeReadLocksVerified &&
    locks.runtime.modes.length === 4 && locks.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 40 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 1 && mode.checkedValues === 1824 && mode.bufferLocksCreated === 6 &&
      mode.bufferLocksReleased === 6 && mode.bufferUploads === 5 && mode.bufferReadLocks === 1);
  summary.webGPUBufferLockUploadVerified = summary.p2BufferLockProbePass;
  summary.ueNativeRHIBufferLockChecksPassed = locks.checksPassed || 0;
  summary.ueNativeRHIBufferLockCheckedValues = locks.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIBufferLockChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIBufferLockCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-texture-3d-build-results.json'))) {
  const volume = read('ue-rhi-texture-3d-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2Texture3DProbePass = volume.pass && volume.runtime?.pass &&
    volume.moduleSha256 === core.moduleSha256 && volume.runtime.hostRHI === 'Null' &&
    volume.runtime.texture3DInitializationAndSamplingVerified && volume.runtime.bulkDataSnapshotAndDiscardVerified &&
    volume.runtime.probeOnlyShaders && !volume.runtime.multiMipVolumeImplemented &&
    volume.runtime.modes.length === 2 && volume.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 71 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 24 && mode.checkedValues === 1776 &&
      mode.finalizedCommandLists === mode.submittedCommandLists);
  summary.webGPUTexture3DAndBulkDataVerified = summary.p2Texture3DProbePass;
  summary.ueNativeRHITexture3DChecksPassed = volume.checksPassed || 0;
  summary.ueNativeRHITexture3DCheckedValues = volume.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHITexture3DChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHITexture3DCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-rhi-texture-uint-build-results.json'))) {
  const volume = read('ue-rhi-texture-uint-build-results.json');
  const core = read('ue-rhi-build-results.json');
  summary.p2IntegerVolumeProbePass = volume.pass && volume.runtime?.pass &&
    volume.moduleSha256 === core.moduleSha256 && volume.runtime.hostRHI === 'Null' &&
    volume.runtime.integerVolumeLoadVerified && volume.runtime.textureSampleTypeValidated &&
    volume.runtime.probeOnlyShaders && !volume.runtime.integerTextureFilteringImplemented &&
    volume.runtime.modes.length === 2 && volume.runtime.modes.every(mode => mode.pass &&
      mode.checks.length === 60 && mode.checks.every(check => check.pass) && mode.errors.length === 0 &&
      mode.dispatches === 10 && mode.checkedValues === 840 &&
      mode.finalizedCommandLists === mode.submittedCommandLists);
  summary.webGPUIntegerVolumeVerified = summary.p2IntegerVolumeProbePass;
  summary.ueNativeRHIIntegerVolumeChecksPassed = volume.checksPassed || 0;
  summary.ueNativeRHIIntegerVolumeCheckedValues = volume.checkedValues || 0;
  summary.ueNativeRHIAllChecksPassed += summary.ueNativeRHIIntegerVolumeChecksPassed;
  summary.ueNativeRHIAllCheckedValues += summary.ueNativeRHIIntegerVolumeCheckedValues;
}
if (fs.existsSync(path.join(root, 'ue-web-renderer-source-results.json'))) {
  const source = read('ue-web-renderer-source-results.json');
  const currentHash = file => fs.existsSync(file) ?
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  summary.webDistanceFieldConditionalSourceVerified = source.pass === true &&
    source.nonWebPreprocessedCodeUnchangedExceptDiagnosticLocations === true &&
    source.webDistanceFieldInitializationAndConsumerExcluded === true &&
    source.sourceSha256 === currentHash(source.sourceFile) &&
    source.compiledVariants?.length === 2 &&
    source.compiledVariants.every(variant => variant.objectSha256 === currentHash(variant.object) &&
      variant.publicDistanceFieldEntryPointsPreserved &&
      variant.distanceFieldDummySymbolsPresent === (variant.name === 'patched-desktop') &&
      variant.distanceFieldBindingDependenciesPresent === (variant.name === 'patched-desktop'));
  summary.modifiedWebRendererLinkedIntoHost = source.modifiedRendererLinkedIntoHost === true;
  summary.modifiedWebRendererStartupVerified = source.modifiedRendererStartupTested === true;
  summary.modifiedWebRendererWasmCompiled = source.wasmCompilationTested === true;
}
if (fs.existsSync(path.join(root, 'web-ubt-results.json'))) {
  const web = read('web-ubt-results.json');
  const currentHash = file => fs.existsSync(file) ?
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
  summary.p3WebToolchainFoundationPass = web.pass === true && web.webPlatformRegistered === true &&
    web.architecture === 'wasm64' && web.nodeResult?.pointerBytes === 8 &&
    web.compileArchiveLinkActionsVerified === true && web.compilerHeaderDependenciesRecorded === true &&
    web.wasmExecutableVerified === true && web.missingSdkRejected === true &&
    web.ubtSha256 === currentHash(web.ubt) && web.wasmSha256 === currentHash(web.wasmFile) &&
    web.actionsSha256 === currentHash(web.actionsFile) &&
    web.sourceFiles?.length >= 9 && web.sourceFiles.every(source => source.sha256 === currentHash(source.file)) &&
    web.nodeResult?.pass === true && web.browserRuns?.length === 2 &&
    web.browserRuns.every(run => run.pass === true && run.report?.pass === true && run.errors.length === 0);
  summary.webUBTPlatformRegistered = summary.p3WebToolchainFoundationPass;
  summary.webUBTSourceEngineVersion = web.ubtSourceEngineVersion;
  summary.webUBTArchitecture = web.architecture;
  summary.p3Complete = false;
  summary.webCoreModuleWasmCompiled = false;
  if (fs.existsSync(path.join(root, 'web-core-types-results.json'))) {
    const types = read('web-core-types-results.json');
    summary.p3CoreTypeHeadersPass = types.pass === true && types.architecture === 'wasm64' &&
      types.realCoreTypeHeadersWasmVerified === true && types.highPointerRoundTripVerified === true &&
      types.ubtSha256 === currentHash(types.ubt) && types.ubtSha256 === web.ubtSha256 &&
      types.wasmSha256 === currentHash(types.wasmFile) &&
      types.sourceFiles?.length === 7 &&
      types.sourceFiles.every(source => source.sha256 === currentHash(source.file)) &&
      types.nodeResult?.pass === true && types.nodeResult.pointerBytes === 8 &&
      types.nodeResult.sizeTBytes === 8 && types.nodeResult.tcharBytes === 2 &&
      types.browserRuns?.length === 2 && types.browserRuns.every(run =>
        run.pass === true && run.types?.pass === true && run.types.pointerBytes === 8 &&
        run.types.sizeTBytes === 8 && run.types.tcharBytes === 2 &&
        run.highPointerValue === '100000021' && run.errors.length === 0);
    summary.webCoreTypesWasmVerified = summary.p3CoreTypeHeadersPass;
  }
  if (fs.existsSync(path.join(root, 'web-core-compression-source-results.json'))) {
    const compression = read('web-core-compression-source-results.json');
    summary.webCoreOodleConditionalSourceVerified = compression.pass === true &&
      compression.webOodleImplementationAndConsumersExcluded === true &&
      compression.files?.length === 5 && compression.files.every(source =>
        source.sha256 === currentHash(source.source) && source.desktopPreprocessedCodeUnchanged === true &&
        source.variants?.length === 2 && source.variants.every(variant =>
          variant.objectSha256 === currentHash(variant.object) &&
          variant.oodleSymbols === (variant.name === 'desktop')));
  }
  if (fs.existsSync(path.join(root, 'web-core-target-diagnostic.json'))) {
    const core = read('web-core-target-diagnostic.json');
    summary.webCoreTargetBuildVerified = core.diagnosticVerified === true &&
      core.normalTargetRulesReached === true && core.buildSucceeded === true &&
      core.architecture === 'wasm64' && core.normalTargetActionGraphGenerated === true &&
      core.coreCppCompilationAttempted === true && core.oodleLibraryDependencyExcluded === true &&
      core.zlibPortLinkOptionResolved === true && core.actionGraphContainsOutdatedActionsOnly === true &&
      core.actionsSha256 === currentHash(core.actionsFile) &&
      core.overlayFiles?.length === 21 && core.overlayFiles.every(source =>
        source.sha256 === currentHash(source.file) && source.copiedSha256 === source.sha256 &&
        source.copiedSha256 === currentHash(source.copied)) &&
      core.ubtSha256 === currentHash(core.ubt) && core.ubtSha256 === web.ubtSha256 &&
      core.logSha256 === currentHash(core.logFile) &&
      core.normalTargetCppCompilationReachedLink === true && core.ordinaryProgramLinked === true &&
      core.coreModuleWasmCompiled === true && core.blocker === null && core.undefinedSymbols?.length === 0 &&
      core.jsSha256 === currentHash(core.jsFile) && core.wasmSha256 === currentHash(core.wasmFile) &&
      core.linkResponseSha256 === currentHash(core.linkResponse) &&
      core.linkObjectCount === core.linkObjects?.length && core.linkObjectCount > 24 &&
      core.linkObjects.every(unit => unit.objectSha256 === currentHash(unit.object) &&
        unit.responseSha256 === currentHash(unit.response)) &&
      core.platformFiles?.length >= 20 && core.platformFiles.every(source =>
        source.sha256 === currentHash(source.file) && source.copiedSha256 === source.sha256 &&
        source.copiedSha256 === currentHash(source.copied)) &&
      core.positiveLogSha256 === currentHash(core.positiveLogFile) &&
      core.coreSourceObjectsWasmCompiled === true &&
      core.compressionWasmObjectHasNoOodleCodecReferences === true &&
      core.minimalProgramSourceWasmCompiled === true &&
      core.selectedCoreSources?.length === 23 && core.selectedPlatformCoreSources?.length === 3 &&
      core.selectedCoreObjectsCompiled === 26 &&
      core.compiledUnits?.length === 27 && core.compiledUnits.every(unit =>
        unit.compiled === true && unit.sourceSha256 === currentHash(unit.source) &&
        unit.targetSourceSha256 === unit.sourceSha256 &&
        unit.targetSourceSha256 === currentHash(unit.targetSource) &&
        unit.objectSha256 === currentHash(unit.object) && unit.responseSha256 === currentHash(unit.response)) &&
      core.sourceFiles.every(source => source.sha256 === currentHash(source.file));
    summary.webCoreTargetRulesReached = summary.webCoreTargetBuildVerified;
    summary.webCoreNormalTargetActionGraphGenerated = summary.webCoreTargetBuildVerified;
    summary.webCoreCppCompilationAttempted = summary.webCoreTargetBuildVerified;
    summary.webCoreTargetActions = core.totalActions;
    summary.webCoreCompileActions = core.coreCompileActions;
    summary.webCoreActionGraphContainsOutdatedActionsOnly = core.actionGraphContainsOutdatedActionsOnly;
    summary.webCoreSourceObjectsWasmCompiled = summary.webCoreTargetBuildVerified;
    summary.webCoreWasmObjectsCompiled = core.compiledUnits?.filter(unit => unit.module === 'Core').length || 0;
    summary.webMinimalProgramSourceWasmCompiled = summary.webCoreTargetBuildVerified;
    summary.webCoreTargetBuildSucceeded = summary.webCoreTargetBuildVerified;
    summary.webCoreModuleWasmCompiled = summary.webCoreTargetBuildVerified;
    summary.webCoreNormalTargetCppReachedLink = summary.webCoreTargetBuildVerified;
    summary.webCoreTargetUndefinedLinkSymbols = core.undefinedSymbols;
    summary.webCoreTargetBlocker = core.blocker;
  }
  if (fs.existsSync(path.join(root, 'web-core-program-results.json'))) {
    const program = read('web-core-program-results.json');
    const core = read('web-core-target-diagnostic.json');
    summary.p3CoreProgramPass = summary.webCoreTargetBuildVerified === true &&
      program.pass === true && program.architecture === 'wasm64' &&
      program.ordinaryProgramLinkedAndExecuted === true && program.realUEArrayAllocationAndReleaseVerified === true &&
      program.realUEFileIOVerified === true && program.alignedReallocationVerified === true &&
      program.jsSha256 === core.jsSha256 && program.jsSha256 === currentHash(program.jsFile) &&
      program.wasmSha256 === core.wasmSha256 && program.wasmSha256 === currentHash(program.wasmFile) &&
      program.stagedFiles?.length === 2 && program.stagedFiles.every(file => file.sha256 === currentHash(file.file)) &&
      program.sourceFiles?.length === 2 && program.sourceFiles.every(file => file.sha256 === currentHash(file.file)) &&
      program.nodeResult?.pass === true && program.nodeResult.pointerBytes === 8 &&
      program.nodeResult.arraySum === 25188352 && program.nodeResult.groups === 6 &&
      program.registerTransformFPUVerified === true && program.arithmeticShiftFPUVerified === true &&
      program.browserRuns?.length === 2 && program.browserRuns.every(run =>
        run.pass === true && run.program?.pass === true && run.program.pointerBytes === 8 &&
        run.program.arraySum === 25188352 && run.program.groups === 6 &&
        run.failure === null && run.errors.length === 0);
    summary.webOrdinaryCoreProgramLinkedAndExecuted = summary.p3CoreProgramPass;
  }
  if (fs.existsSync(path.join(root, 'web-core-services-results.json'))) {
    const services = read('web-core-services-results.json');
    const core = read('web-core-target-diagnostic.json');
    const stringObject = core.compiledUnits?.find(unit => unit.source.endsWith('GenericPlatformStricmp.cpp'));
    summary.p3CoreServicesSubsetPass = services.pass === true && services.singleThreaded === true &&
      services.architecture === 'wasm64' && services.realCoreStringObjectLinkedAndExecuted === true &&
      summary.webCoreTargetBuildVerified === true &&
      services.compiledCoreObject?.objectSha256 === stringObject?.objectSha256 &&
      services.compiledCoreObject?.objectSha256 === currentHash(services.compiledCoreObject?.object) &&
      services.ubtSha256 === web.ubtSha256 && services.ubtSha256 === currentHash(services.ubt) &&
      services.wasmSha256 === currentHash(services.wasmFile) &&
      services.archiveResponseSha256 === currentHash(services.archiveResponse) &&
      services.linkResponseSha256 === currentHash(services.linkResponse) &&
      services.sourceFiles?.length >= 20 &&
      services.sourceFiles.every(source => source.sha256 === currentHash(source.file)) &&
      services.groups?.length === 7 && services.nodeResult?.pass === true &&
      services.nodeResult.groups === 7 && services.nodeResult.pointerBytes === 8 &&
      services.nodeResult.int128Alignment === 16 &&
      services.nodeResult.zlibVersion === '1.3.2' &&
      services.browserRuns?.length === 2 && services.browserRuns.every(run =>
        run.pass === true && run.services?.pass === true && run.services.groups === 7 &&
        run.services.pointerBytes === 8 && run.services.int128Alignment === 16 &&
        run.services.zlibVersion === '1.3.2' &&
        run.highAtomicValue === '100000021' && run.errors.length === 0);
    summary.webCoreStringObjectLinkedAndExecuted = summary.p3CoreServicesSubsetPass;
    summary.webCoreServicesGroupsPassedPerRuntime = services.nodeResult?.groups || 0;
    summary.webCoreServicesBrowserRunsPassed = services.browserRuns?.filter(run => run.pass).length || 0;
  }
  if (fs.existsSync(path.join(root, 'web-application-target-results.json'))) {
    const application = read('web-application-target-results.json');
    const validFiles = items => items?.length > 0 && items.every(item =>
      item.sha256 === currentHash(item.file) &&
      (!item.copied || item.copiedSha256 === item.sha256 && item.copiedSha256 === currentHash(item.copied)));
    summary.webApplicationTargetBuildVerified = application.pass === true &&
      application.buildSucceeded === true && application.exitCode === 0 && application.architecture === 'wasm64' &&
      application.ubtSha256 === currentHash(application.ubt) &&
      application.jsSha256 === currentHash(application.jsFile) &&
      application.wasmSha256 === currentHash(application.wasmFile) &&
      application.logSha256 === currentHash(application.logFile) &&
      application.linkResponseSha256 === currentHash(application.linkResponse) &&
      validFiles(application.sourceAudit) && validFiles(application.platformAudit) &&
      validFiles(application.sourceFiles) && validFiles(application.objectAudit) &&
      application.objectAudit.every(item => item.responseSha256 === currentHash(item.response));
    if (fs.existsSync(path.join(root, 'web-application-results.json'))) {
      const runtime = read('web-application-results.json');
      summary.p3ApplicationCoreBrowserPass = summary.webApplicationTargetBuildVerified === true &&
        runtime.pass === true && runtime.architecture === 'wasm64' &&
        runtime.browserMainLoopVerified === true && runtime.applicationCoreInputVerified === true &&
        runtime.targetReportSha256 === currentHash(path.join(root, 'web-application-target-results.json')) &&
        runtime.jsSha256 === application.jsSha256 && runtime.wasmSha256 === application.wasmSha256 &&
        validFiles(runtime.stagedFiles) && validFiles(runtime.sourceFiles) &&
        runtime.browserRuns?.length === 4 && runtime.browserRuns.every(run =>
          run.pass === true && run.ready === true && run.stopped?.frames > 3 &&
          run.checks?.length === 15 && run.errors?.length === 0);
      summary.webBrowserMainLoopVerified = summary.p3ApplicationCoreBrowserPass;
      summary.webApplicationCoreInputVerified = summary.p3ApplicationCoreBrowserPass;
      summary.webApplicationBrowserRunsPassed = runtime.browserRuns?.filter(run => run.pass).length || 0;
    }
  }
}
if (fs.existsSync(path.join(root, 'web-blake3-results.json'))) {
  const blake = read('web-blake3-results.json');
  const valid = item => item?.file && item.sha256 === currentHash(item.file);
  const build = read('web-blake3-build-results.json');
  summary.webBlake3PortableVectorsVerified = blake.pass === true && blake.architecture === 'wasm64' &&
    valid(blake.buildReport) && valid(blake.library) && build.pass === true &&
    build.portable === true && build.version === '1.3.1' &&
    build.sourceFiles?.length === 7 && build.sourceFiles.every(valid) &&
    build.objects?.length === 3 && build.objects.every(valid) &&
    build.products?.length === 2 && build.products.every(valid) &&
    blake.sourceFiles?.length === 3 && blake.sourceFiles.every(valid) &&
    blake.vectorCases > 20 && blake.modes === 3 && blake.outputBytes === 131 &&
    blake.defaultOutputPrefixChecked === true &&
    blake.node?.pass === true && blake.node.checks === blake.vectorCases * 6 &&
    blake.browserRuns?.length === 2 && ['Chrome', 'Edge'].every(name =>
      blake.browserRuns.some(run => run.browser === name && run.pass === true &&
        run.checks === blake.vectorCases * 6 && run.errors?.length === 0));
}
if (fs.existsSync(path.join(root, 'web-libpng-results.json'))) {
  const png = read('web-libpng-results.json');
  const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 === currentHash(item.file);
  const build = read('web-libpng-build-results.json');
  const passed = run => run?.pass === true && run.cases === 4 && run.checks === 8 &&
    run.depths?.length === 2 && run.depths.includes(8) && run.depths.includes(16) &&
    run.metadata === true && run.corruptRejected === true;
  summary.webLibPngPortableVerified = png.pass === true && png.architecture === 'wasm64' &&
    valid(png.buildReport) && valid(png.library) && build.pass === true &&
    build.portable === true && build.version === '1.6.44' &&
    build.sourceFiles?.length >= 24 && build.sourceFiles.every(valid) &&
    build.objects?.length === 15 && build.objects.every(valid) &&
    build.products?.length === 2 && build.products.every(valid) &&
    png.sourceFiles?.length === 2 && png.sourceFiles.every(valid) &&
    png.compatibleHeaders?.length === 5 && png.compatibleHeaders.every(item =>
      valid(item.source) && valid(item.installed)) && passed(png.node) &&
    png.browserRuns?.length === 2 && ['Chrome', 'Edge'].every(name =>
      png.browserRuns.some(run => run.browser === name && passed(run) && run.errors?.length === 0));
}
if (fs.existsSync(path.join(root, 'web-engine-target-results.json'))) {
  const engine = read('web-engine-target-results.json');
  const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 ===
    crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex');
  const validList = items => items?.length > 0 && items.every(valid);
  summary.p3EngineCompileProbePass = engine.pass === true && engine.architecture === 'wasm64' &&
    engine.engineTargetActionGraphGenerated === true && engine.uhtCodeGenerationVerified === true &&
    engine.realEngineLoopMethodDefinitionsVerified === true && engine.oodleStartupReferenceExcluded === true &&
    engine.applicationModuleBoilerplateVerified === true && valid(engine.entryPointSymbols) &&
    engine.actionGraphContainsOutdatedActionsOnly === true &&
    valid(engine.ubt) && valid(engine.actions) && valid(engine.manifest) && valid(engine.symbols) &&
    valid(engine.graphLog) && validList(engine.generatedAudit) && validList(engine.sourceFiles) &&
    engine.lowLevelMemoryTrackerExcluded === true &&
    ['source', 'original', 'object', 'response', 'log'].every(key =>
      valid(engine.lowLevelMemoryTrackerCompileCheck?.[key])) &&
    validList(engine.copiedAudit) && engine.copiedAudit.every(item =>
      item.sha256 === item.copiedSha256 && valid({file: item.copied, sha256: item.copiedSha256})) &&
    engine.preshader2SourceWasmCompiled === true &&
    engine.cpuSkinSourceWasmCompiled === true &&
    engine.inputCoreSourceWasmCompiled === true &&
    engine.inputCorePlatformSourceWasmCompiled === true &&
    engine.ioStoreOnDemandNetworkExcluded === true &&
    engine.ioStoreOnDemandCoreRetained === true &&
    engine.audioDecodersExcluded === true &&
    engine.portableBlake3AndPngLinked === true &&
    engine.rhiValidationExcluded === true &&
    ['source', 'original', 'object', 'response', 'definitions', 'log'].every(key =>
      valid(engine.rhiValidationCompileCheck?.[key])) &&
    engine.units?.length === 10 && engine.units.every(unit =>
      ['source', 'original', 'object', 'response', 'definitions', 'log'].every(key => valid(unit[key])));
  summary.webEngineTargetActionGraphGenerated = summary.p3EngineCompileProbePass;
  summary.webEngineReflectionGenerationVerified = summary.p3EngineCompileProbePass;
  summary.webLaunchEngineLoopWasmCompiled = summary.p3EngineCompileProbePass;
  summary.webEngineTargetBuildSucceeded = false;
  summary.webEngineLoopBrowserTickVerified = false;
}
if (fs.existsSync(path.join(root, 'web-engine-full-build-results.json'))) {
  const build = read('web-engine-full-build-results.json');
  const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 ===
    crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex');
  summary.webEngineFullBuildAttempted = build.fullBuildAttempted === true;
  summary.webEngineFullBuildReportVerified = build.architecture === 'wasm64' &&
    valid(build.log) && valid(build.ubtLog) && valid(build.ubt);
  const platformRoot = path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web');
  const platformFiles = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(item =>
    item.isDirectory() ? platformFiles(path.join(directory, item.name)) : [path.join(directory, item.name)]);
  const auditedFiles = new Set((build.sourceFiles || []).map(item => path.resolve(item.file).toLowerCase()));
  summary.webEngineFullBuildMatchesCurrentSources =
    build.sourceFiles?.length > 0 && build.sourceFiles.every(valid) &&
    platformFiles(platformRoot).every(file => auditedFiles.has(path.resolve(file).toLowerCase()));
  summary.webEngineTargetBuildSucceeded = summary.webEngineFullBuildReportVerified &&
    summary.webEngineFullBuildMatchesCurrentSources &&
    build.pass === true && build.buildSucceeded === true && build.exitCode === 0 &&
    valid(build.linkResponse) && build.products?.length === 3 && build.products.every(valid);
  summary.webEngineFullBuildErrors = build.compilerErrors || [];
  summary.webEngineFullBuildProcessFailures = build.failedProcesses || [];
  summary.webEngineFullLinkAttempted = build.fullLinkAttempted === true;
  summary.webEngineTargetCompileStageCompleted = summary.webEngineFullBuildReportVerified &&
    summary.webEngineFullBuildMatchesCurrentSources && summary.webEngineFullLinkAttempted;
}
if (fs.existsSync(path.join(root, 'web-engine-exclusion-results.json'))) {
  const exclusions = read('web-engine-exclusion-results.json');
  const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 ===
    crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex');
  summary.webEngineOptionalImplementationsExcluded = exclusions.pass === true &&
    exclusions.architecture === 'wasm64' && exclusions.sdfImplementationExcluded === true &&
    exclusions.fontDataInterfacesRetained === true && exclusions.bsdSocketImplementationExcluded === true &&
    exclusions.udpProbeImplementationExcluded === true && exclusions.patchTimedSemaphoreWaitExcluded === true &&
    exclusions.portableLibrariesLinked === true && exclusions.runtimePngCodecRetained === true &&
    valid(exclusions.pngDefinitions) && valid(exclusions.linkResponse) &&
    exclusions.portableLibraries?.length === 2 && exclusions.portableLibraries.every(item =>
      valid(item.source) && valid(item.linked) && item.source.sha256 === item.linked.sha256) &&
    exclusions.linkResponse?.sha256 === read('web-engine-full-build-results.json').linkResponse?.sha256 &&
    valid(exclusions.buildReport) && valid(exclusions.definitions) &&
    exclusions.sourceFiles?.length > 0 && exclusions.sourceFiles.every(valid) &&
    exclusions.objects?.length === 12 && exclusions.objects.every(valid) &&
    exclusions.symbols?.length === 5 && exclusions.symbols.every(valid);
}
if (fs.existsSync(path.join(root, 'web-engine-stage-results.json'))) {
  const stage = read('web-engine-stage-results.json');
  const cook = read('web-engine-cook-results.json');
  const valid = item => item?.sha256 && item.sha256 === currentHash(item.file);
  summary.webNullRHICookStageVerified = stage.pass === true && cook.pass === true &&
    stage.mode === 'NullRHI-only' && cook.mode === 'NullRHI-only' &&
    stage.architecture === 'wasm64' && cook.architecture === 'wasm64' && cook.exitCode === 0 &&
    Array.isArray(cook.shaderFormats) && cook.shaderFormats.length === 0 &&
    valid(cook.log) && valid(stage.cookReport) &&
    cook.sourceFiles?.length > 0 && cook.sourceFiles.every(valid) &&
    cook.hostProducts?.length === 3 && cook.hostProducts.every(valid) &&
    cook.products?.length > 0 && cook.products.every(valid) &&
    stage.sourceFiles?.length === 1 && stage.sourceFiles.every(valid) &&
    valid(stage.pack) && valid(stage.manifest) &&
    stage.files?.length === cook.products.length &&
    stage.totalBytes === cook.totalBytes;
  summary.webNullRHICookedFileCount = stage.files?.length || 0;
  summary.webNullRHICookedBytes = stage.totalBytes || 0;
  // Full rendering Cook/UAT packaging is a separate milestone from this shader-free boot test.
}
if (fs.existsSync(path.join(root, 'web-engine-runtime-results.json'))) {
  const runtime = read('web-engine-runtime-results.json');
  const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 ===
    crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex');
  const buildFile = path.join(root, 'web-engine-full-build-results.json');
  const build = fs.existsSync(buildFile) ? read('web-engine-full-build-results.json') : {};
  summary.webEngineLoopBrowserTickVerified = summary.webEngineTargetBuildSucceeded === true &&
    runtime.pass === true && runtime.architecture === 'wasm64' &&
    runtime.engineLoopBrowserTickVerified === true && valid(runtime.buildReport) &&
    path.resolve(runtime.buildReport.file).toLowerCase() === path.resolve(buildFile).toLowerCase() &&
    runtime.sourceFiles?.length === 2 && runtime.sourceFiles.every(valid) &&
    ['web-engine.html', 'verify-web-engine.cjs'].every(name => runtime.sourceFiles.some(item =>
      path.resolve(item.file).toLowerCase() === path.join(__dirname, name).toLowerCase())) &&
    runtime.stagedFiles?.length === 2 && runtime.stagedFiles.every(item =>
      valid(item) && build.products?.some(product =>
        path.basename(product.file) === path.basename(item.file) && product.sha256 === item.sha256)) &&
    summary.webNullRHICookStageVerified === true && valid(runtime.stageReport) &&
    valid(runtime.contentPack) && valid(runtime.contentManifest) &&
    runtime.contentFiles?.length === summary.webNullRHICookedFileCount &&
    runtime.contentNegativeChecks?.length === 2 && runtime.contentNegativeChecks.every(item =>
      item.pass === true && item.ready === null && item.frames === 0) &&
    valid(runtime.configBundle) && runtime.configFiles?.length === 9 && runtime.configFiles.every(valid) &&
    runtime.browserRuns?.length === 2 && ['Chrome', 'Edge'].every(name =>
      runtime.browserRuns.some(run => run.browser === name && run.pass === true &&
        run.ready?.nullRHI === true && run.firstFrame >= 3 && run.frames >= run.firstFrame + 6 &&
        run.configFiles?.length === runtime.configFiles.length && runtime.configFiles.every(config =>
          run.configFiles.some(item => item.path === config.virtualPath && item.sha256 === config.sha256)) &&
        run.contentFiles?.length === runtime.contentFiles.length && runtime.contentFiles.every(file =>
          run.contentFiles.some(item => item.path === file.path && item.sha256 === file.sha256 && item.size === file.size)) &&
        run.failure === null && Array.isArray(run.errors) && run.errors.length === 0));
  summary.webEngineRuntimeFailure = runtime.failure || null;
}
if (fs.existsSync(path.join(root, 'ue-rhi-startup-diagnostic.json'))) {
  const startup = read('ue-rhi-startup-diagnostic.json');
  const core = read('ue-rhi-build-results.json');
  summary.importedWebGPUModuleSelectionVerified = startup.diagnosticVerified &&
    startup.importedModuleSelectionVerified && startup.moduleSha256 === core.moduleSha256 &&
    startup.minimalStartup?.diagnosticVerified === true;
  summary.importedWebGPURHIStartupVerified = false;
  summary.webGPURHIUnprunedStartupBlocker = startup.blocker;
  summary.webGPURHIStartupBlocker = startup.minimalStartup?.blocker;
  summary.webGPUMinimalStartupPruningVerified = startup.minimalStartup?.optionalDefaultPruningVerified === true;
  summary.webGPUDefaultVertexBuffersPreservedVerified = startup.minimalStartup?.defaultVertexBufferGPUReadbackBytes === 28 &&
    startup.minimalStartup?.omittedVertexSRVs?.length === 2 &&
    startup.minimalStartup.omittedVertexSRVs.every(item => item.gpuReadbackVerified);
  summary.webGPUDeferredStateValidationVerified = startup.minimalStartup?.deferredStateValidationVerified === true &&
    startup.minimalStartup?.deferredStateCases?.length === 2 &&
    startup.minimalStartup.deferredStateCases.every(item => item.descriptorRetained && item.unsupportedUseRejected);
  summary.webGPURHIStartupOptionalDefaultsUnregistered =
    startup.minimalStartup?.optionalDefaultsUnregistered || [];
  summary.webGPURHIStartupTextureSRVsCreated = startup.preRHITextureSRVsCreated?.length || 0;
  summary.webGPURHIStartupBufferSRVsCreated = startup.preRHIBufferSRVsCreated?.length || 0;
  summary.webGPURHIMinimalStartupBufferSRVsCreated = summary.webGPURHIStartupBufferSRVsCreated +
    (startup.minimalStartup?.additionalBufferSRVsCreated?.length || 0);
  summary.webGPURHIStartupBufferUAVsCreated = startup.preRHIBufferUAVsCreated?.length || 0;
  summary.webGPURHIStartupBufferLocksReleased = startup.preRHIBufferLocksReleased?.length || 0;
  summary.webGPURHIStartupTexture3DUploads = startup.preRHITexture3DUploads?.length || 0;
}
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.p0Pass && summary.shaderRuntimeTier2Pass && shaderBuild.pass &&
  summary.p1CoreProbePass !== false && summary.p1MaterialProbePass !== false &&
  summary.p1WebFormatProbePass !== false && summary.p1IndependentShaderPlatformProbePass !== false &&
  summary.p2CoreRHIProbePass !== false && summary.p2MaterialRHIProbePass !== false &&
  summary.p2TransitionRHIProbePass !== false && summary.p2GlobalDispatchProbePass !== false &&
  summary.p2ViewportRHIProbePass !== false &&
  summary.p2TextureSRVProbePass !== false &&
  summary.p2BufferSRVProbePass !== false &&
  summary.p2BufferUAVProbePass !== false &&
  summary.p2Uint4ViewsProbePass !== false &&
  summary.p2StructuredViewsProbePass !== false &&
  summary.p2Float4ViewsProbePass !== false &&
  summary.p2BufferLockProbePass !== false &&
  summary.p2Texture3DProbePass !== false &&
  summary.p2IntegerVolumeProbePass !== false &&
  summary.webGPUDefaultVertexBuffersPreservedVerified !== false &&
  summary.webGPUDeferredStateValidationVerified !== false &&
  summary.webDistanceFieldConditionalSourceVerified !== false &&
  summary.p3WebToolchainFoundationPass !== false &&
  summary.p3CoreTypeHeadersPass !== false &&
  summary.webCoreOodleConditionalSourceVerified !== false &&
  summary.webCoreTargetBuildVerified !== false &&
  summary.p3CoreProgramPass !== false &&
  summary.p3CoreServicesSubsetPass !== false &&
  summary.webApplicationTargetBuildVerified !== false &&
  summary.p3ApplicationCoreBrowserPass !== false &&
  summary.p3EngineCompileProbePass !== false &&
  summary.webBlake3PortableVectorsVerified !== false &&
  summary.webLibPngPortableVerified !== false &&
  summary.webEngineOptionalImplementationsExcluded !== false &&
  summary.importedWebGPUModuleSelectionVerified !== false ? 0 : 1;
