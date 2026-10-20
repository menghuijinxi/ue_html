const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const sample = path.join(__dirname, 'build/ue-platform-full');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, evidenceVerified: false,
  globalShaderSamplesVerified: false, materialRegressionVerified: false,
  webgpuShaderCookVerified: false, nullRHIBrowserTickVerified: false,
  hardwareEngineTickVerified: false, fullNormalUBTBuildVerified: false, completeUEScene: false,
  reports: [], sourceFiles: [audit(__filename)]};

function load(file) {
  report.reports.push(audit(file));
  return read(file);
}

function checkCook(file) {
  const cook = load(file);
  assert(valid(cook.log) && cook.sourceFiles.every(valid) && cook.hostProducts.every(valid),
    `Cook inputs have changed: ${file}`);
  if (cook.mode !== 'NullRHI-only') {
    assert(valid(cook.hostPreparationReport) && valid(cook.hostPreparationLog));
    const prepared = read(cook.hostPreparationReport.file);
    assert(prepared.pass && prepared.sourceFiles.every(valid) && prepared.products.every(valid));
    assert(valid(cook.nativeRenderCoreBuildReport) && valid(prepared.nativeRenderCoreBuildReport) &&
      valid(prepared.nativeRenderCore));
    const native = read(cook.nativeRenderCoreBuildReport.file);
    assert(native.pass && native.installedInputsUnmodified && native.installedInputs.every(valid) &&
      native.sourceFiles.every(valid) && native.products.every(valid));
    assert(valid(cook.shaderInventory.artifact) && cook.minimalRendererSettingsVerified);
    assert(valid(cook.shaderSourcesReport) && valid(prepared.shaderSources.report));
    const shaders = read(cook.shaderSourcesReport.file);
    assert(shaders.pass && shaders.sourceFiles.every(valid) && valid(shaders.installedEngineUnmodified) &&
      shaders.installedInputs.length === 13 && shaders.installedInputs.every(valid) &&
      shaders.files.every(item => sha(path.join(shaders.output, item.relative)) === item.sha256));
  }
  if (cook.pass) assert(cook.exitCode === 0 && cook.products.every(valid));
  return cook;
}

try {
  const globals = load(path.join(sample, 'web-manifest.json'));
  const worker = load(path.join(sample, 'worker/worker-results.json'));
  const registration = load(path.join(sample, 'platform-registration.json'));
  const module = load(path.join(results, 'worker-module-build.json'));
  assert(globals.pass && worker.pass && registration.pass && globals.cases.length === 71 &&
    worker.cases.length === 71 && worker.badInputVersionRejected && worker.badFormatVersionRejected);
  assert(sha(module.dll) === module.dllSha256 && module.originalWorkerUnmodified &&
    valid(module.preservedStaticPlatformMap) && valid(module.preservedStaticPlatformMap.report));
  let packets = 0, rejections = 0;
  for (const item of globals.cases) {
    const compiled = worker.cases.find(candidate => candidate.name === item.name);
    assert(compiled?.pass && compiled.compiled === item.converted);
    if (!compiled.compiled) {
      assert(item.expectedRejection && compiled.expectedRejection);
      ++rejections;
      continue;
    }
    assert(item.bindingContractVerified && compiled.outputHashMatchesEditor && compiled.inputHashVerified);
    const packetFile = path.join(sample, 'worker', compiled.packet);
    const packet = fs.readFileSync(packetFile);
    assert.deepEqual(packet, fs.readFileSync(path.join(sample, 'worker', `${item.name}.editor.webshader`)));
    assert.equal(decode(packet, registration).metadata.formatVersion, worker.formatVersion);
    ++packets;
  }
  assert(packets === 55 && rejections === 16);
  report.globalShaderSamplesVerified = true;
  report.globalShaderSamples = 71;
  report.convertedPackets = packets;
  report.expectedRejections = rejections;
  report.editorWorkerBytecodeEqual = true;
  report.globalSamplesPlatform = 'WebGPU/47 sample DDPI; distinct from Cook Web/46 and Web/47';
  report.materialRegressionStatus = 'ES31 Cook succeeds: 39 unsupported vertex-factory jobs are explicitly excluded and the decal failure is repaired. Resource-only bindings retain native negative controls and browser GPU readback. The disabled fog depth generator no longer triggers the installed metadata mismatch.';

  const sm5 = checkCook(path.join(results, 'web-engine-webgpu-cook-results.json'));
  const es31 = checkCook(path.join(results, 'web-engine-webgpu-es31-cook-results.json'));
  const profiles = load(path.join(results, 'web-engine-shader-profiles-results.json'));
  assert(profiles.comparisonVerified && valid(profiles.es31.report) && valid(profiles.es31.inventory) &&
    profiles.es31.currentInputsMatch && es31.stopOnShaderError === false);
  report.webgpuSM5ShaderCookVerified = sm5.pass;
  report.webgpuES31ShaderCookVerified = es31.pass;
  report.webgpuShaderCookVerified = es31.pass;
  report.es31EligiblePermutations = profiles.es31.permutations;
  report.es31DistinctRecordedFailedJobs = profiles.es31.distinctFailedJobs;
  report.es31GlobalJobs = profiles.es31.globalJobs;
  report.es31MaterialJobs = profiles.es31.materialJobs;
  const material = load(path.join(results, 'web-resource-only-uniform-results.json'));
  const completion = load(path.join(results, 'web-material-completion-results.json'));
  const materialBuild = load(path.join(results, 'web-material-host-build-results.json'));
  assert(material.pass && material.productionBindingValidatorVerified && material.shaderGPUExecutionVerified &&
    material.resourceOnlyShaderEligibilityUnchanged && material.sourceFiles.every(valid) && valid(material.cook) &&
    valid(material.baseline) &&
    material.nativeBuild.sha256 === sha(path.join(results, 'web-material-host-build-results.json')) &&
    material.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    materialBuild.pass && materialBuild.sources.every(valid) && materialBuild.products.every(valid) &&
    completion.pass && completion.allFortyFailuresAccountedFor && completion.cookSucceeded &&
    completion.decalShaderGPUExecutionVerified && completion.excludedFailures.length === 39 &&
    completion.recoveredFailures.length === 1 && completion.sourceFiles.every(valid) &&
    valid(completion.cook) && completion.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    valid(completion.vertexFactoryPolicy) && valid(completion.wasmLink) &&
    material.nativeChecks.length === 15 && material.nativeChecks.every(item =>
      valid(item.input) && valid(item.result) && valid(item.reflection) && valid(item.log)) &&
    material.recoveredJobs.length === 2 && material.recoveredJobs.every(item =>
      valid(item.previousInput) && valid(item.previousWgsl) && valid(item.current.input) &&
      valid(item.current.spirv) && valid(item.current.wgsl)) &&
    material.browserRuns.length === 2 && material.browserRuns.every(run =>
      run.pass && run.cases.length === 2 && run.checkedValues === 24));
  const materialBefore = read(material.baseline.file);
  const previousMaterialFailures = new Set(materialBefore.shaderFailures.map(item => item.detail.shader));
  const currentMaterialFailures = new Set(es31.shaderFailures.map(item => item.detail.shader));
  assert.equal(previousMaterialFailures.size, 42);
  assert.equal(currentMaterialFailures.size, 0);
  assert.deepEqual(new Set(previousMaterialFailures), new Set([
    ...material.recoveredJobs.map(item => item.shader),
    ...completion.excludedFailures.map(item => item.shader),
    ...completion.recoveredFailures.map(item => item.shader)]));
  assert.deepEqual(material.observedJobs.global, {total: 838, succeeded: 838, failed: 0});
  assert.equal(material.observedJobs.material.failed, 0);
  assert.equal(material.observedJobs.material.total, completion.observedJobs.material);
  assert.equal(profiles.es31.globalJobs.distinctAttemptedJobs, 838);
  assert.equal(profiles.es31.globalJobs.distinctFailedJobs, 0);
  assert.equal(profiles.es31.materialJobs.distinctAttemptedJobs, completion.observedJobs.material);
  assert.equal(profiles.es31.materialJobs.distinctFailedJobs, 0);
  assert(material.hostMetadataMismatch.verified && valid(material.hostMetadataMismatch.metadata) &&
    valid(material.hostMetadataMismatch.log) && valid(material.hostMetadataMismatch.installedRenderer) &&
    valid(material.hostMetadataMismatch.installedRendererSource));
  report.materialResourceOnlyBindingRegressionVerified = true;
  report.materialRegressionVerified = true;
  report.allFortyMaterialFailuresAccountedFor = true;
  report.materialUnsupportedVertexFactoryJobsExcluded = completion.excludedFailures.length;
  report.materialDecalJobsRecovered = completion.recoveredFailures.length;
  report.materialResourceOnlyRecoveredJobs = material.recoveredJobs.map(item => item.shader);
  report.materialCookRemainingFailedJobs = material.remainingMaterialFailureCount;
  report.materialHostMetadataMismatch = material.hostMetadataMismatch;
  report.materialJobCacheAssertionAvoidedWithPerJobDDCDisabled = true;
  report.materialPreviousFailedJobs = previousMaterialFailures.size;
  report.materialNewFailedJobs = 0;
  const tonemap = load(path.join(results, 'web-tonemap-cook-regression-results.json'));
  assert(tonemap.pass && tonemap.tonemapConversionVerified &&
    tonemap.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    valid(tonemap.shaderSources) &&
    tonemap.sourceFiles.every(valid) && tonemap.recoveredJobs.every(item => valid(item.spirv) && valid(item.wgsl)));
  report.tonemapValidationHistorical = tonemap.historicalRecoveredJobs > 0;
  report.tonemapValidationDate = tonemap.date;
  report.tonemapRecoveredJobs = tonemap.previouslyFailedJobs;
  report.tonemapCurrentRecompiledRecoveredJobs = tonemap.currentRecompiledRecoveredJobs;
  report.tonemapHistoricalRecoveredJobs = tonemap.historicalRecoveredJobs;
  report.tonemapCurrentFailures = [...new Set(es31.shaderFailures
    .filter(item => item.detail.source === '/Engine/Private/PostProcessTonemap.usf')
    .map(item => item.detail.shader))];
  const finite = load(path.join(results, 'web-finite-capture-shadow-results.json'));
  assert(finite.pass && finite.conversionVerified && finite.shaderGPUExecutionVerified &&
    finite.numericalShaderEligibilityUnchanged && finite.sourceFiles.every(valid) &&
    valid(finite.cook) && finite.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    finite.recoveredJobs.length === 2 && finite.retainedJobs.length === 8 &&
    [...finite.recoveredJobs, ...finite.retainedJobs].every(item =>
      valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  report.finiteCaptureShadowShaderGPUExecutionVerified = true;
  report.finiteCaptureShadowRecoveredJobs = finite.recoveredJobs.map(item => item.shader);
  report.finiteCaptureShadowBrowserRuns = finite.browserRuns.map(run => ({
    browser: run.browser, pass: run.pass, modules: run.modules, cases: run.checks.length,
    checkedValues: run.checks.reduce((sum, item) => sum + item.checkedValues, 0)}));
  const archive = load(path.join(results, 'web-global-archive-results.json'));
  assert(archive.pass && archive.archiveStructureVerified && archive.sourceFiles.every(valid) &&
    valid(archive.cook) && archive.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    archive.artifacts.length === 4 && archive.artifacts.every(valid) &&
    archive.shaderMaps === 91 && archive.uniqueShaders === 726 && archive.shaderReferences === 729 &&
    archive.compressedShaders === 726 && !archive.hostParameterMismatchObserved &&
    !archive.materialJobCacheAssertionObserved && !archive.shaderPayloadDecompressionVerified &&
    !archive.globalShaderMapDeserializationVerified && !archive.browserShaderLibraryLoadVerified);
  report.es31GlobalArchiveStructureVerified = true;
  report.es31GlobalArchiveShaderMaps = archive.shaderMaps;
  report.es31GlobalArchiveUniqueShaders = archive.uniqueShaders;
  report.es31GlobalArchiveShaderReferences = archive.shaderReferences;
  report.es31GlobalArchiveBrowserLoadVerified = false;
  report.hostParameterMismatchObserved = archive.hostParameterMismatchObserved;
  report.materialJobCacheAssertionObserved = archive.materialJobCacheAssertionObserved;
  report.tonemapBrowserModuleValidation = tonemap.browserRuns;
  if (tonemap.historicalCook) {
    assert(valid(tonemap.historicalCook) && valid(tonemap.historicalReport));
  }
  const policy = load(path.join(results, 'web-minimal-shader-policy-results.json'));
  assert(policy.pass && policy.nativeCookPolicyVerified && policy.wasmPolicyCompileLinkVerified &&
    policy.sourceFiles.every(valid) && policy.inputs.every(valid));
  report.sharedMinimalShaderPolicyVerified = true;
  report.removedOptionalPermutations = policy.removedPermutations;
  report.runtimeOptionalPassSelectionVerified = policy.runtimePassSelectionVerified;
  assert(policy.hzbVisibilityPolicy?.excludedVisibilityFormat === 3 &&
    policy.hzbVisibilityPolicy.currentPermutations === 48 &&
    policy.excludedHZBJobs.length === 12 && policy.retainedHZBJobs.length === 50 &&
    policy.excludedHZBJobs.every(item => valid(item.diagnostic)) &&
    policy.retainedHZBJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  report.hzbVisibilityPermutationsExcluded = policy.excludedHZBJobs.length;
  report.hzbRetainedShaderConversionVerified = true;
  report.hzbDepthReductionGPUExecutionVerified = false;
  assert(policy.capsuleShadowPolicy?.previousPermutations === 20 &&
    policy.capsuleShadowPolicy.currentPermutations === 0 &&
    policy.excludedCapsuleJobs.length === 12 &&
    policy.excludedCapsuleJobs.every(item => valid(item.diagnostic)) &&
    policy.capsulePreparationAndPassPolicyCompileVerified);
  report.capsuleShadowPermutationsExcluded = 20;
  report.capsuleShadowPreparationAndPassPolicyCompileVerified = true;
  report.capsuleShadowRuntimePassSelectionVerified = policy.capsuleShadowPolicy.runtimePassSelectionVerified;
  assert(policy.msaaResolvePolicy?.removedPermutations === 18 &&
    policy.msaaResolvePolicy.changedTypes === 13 && policy.excludedMSAAJobs.length === 17 &&
    policy.excludedMSAAJobs.every(item => valid(item.diagnostic)) &&
    policy.retainedSingleSampleJobs.length === 2 &&
    policy.retainedSingleSampleJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.msaaResolvePredicatesAndPassPolicyCompileVerified);
  report.msaaResolvePermutationsExcluded = 18;
  report.singleSampleDepthAndColorConversionVerified = true;
  report.msaaResolveRuntimePassSelectionVerified = policy.msaaResolvePolicy.runtimePassSelectionVerified;
  assert(policy.fogPolicy?.removedPermutations === 28 && policy.fogPolicy.changedTypes === 8 &&
    policy.excludedFogJobs.length === 7 && policy.excludedFogJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedFogConvertedJobs.length === 21 &&
    policy.excludedFogConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.fogPredicatesAndPassPolicyCompileVerified);
  report.fogPermutationsExcluded = 28;
  report.fogPredicatesAndPassPolicyCompileVerified = true;
  report.fogRuntimePassSelectionVerified = policy.fogPolicy.runtimePassSelectionVerified;
  report.fogDummyResourceRuntimeVerified = policy.fogPolicy.dummyResourceRuntimeVerified;
  assert(policy.pointShadowPolicy?.removedPermutations === 10 &&
    policy.excludedPointShadowJobs.length === 10 &&
    policy.excludedPointShadowJobs.every(item => valid(item.diagnostic)) &&
    policy.retainedOrdinaryShadowJobs.length === 15 &&
    policy.retainedOrdinaryShadowJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.pointShadowPreparationAndPassPolicyCompileVerified);
  report.pointShadowPermutationsExcluded = 10;
  report.ordinaryShadowProjectionConversionVerified = true;
  report.pointShadowPreparationAndPassPolicyCompileVerified = true;
  report.pointShadowRuntimePassSelectionVerified = false;
  assert(policy.oitPolicy?.removedPermutations === 5 && policy.oitPolicy.changedTypes === 4 &&
    policy.excludedOITJobs.length === 5 && policy.excludedOITJobs.every(item => valid(item.diagnostic)) &&
    policy.oitConsumerSources.length === 6 && policy.oitConsumerSources.every(valid) &&
    policy.oitPreparationAndPassPolicyCompileVerified);
  report.oitTriangleSortingPermutationsExcluded = 5;
  report.oitPreparationAndPassPolicyCompileVerified = true;
  report.oitRuntimePassSelectionVerified = false;
  assert(policy.smaaPolicy?.removedPermutations === 18 && policy.smaaPolicy.changedTypes === 8 &&
    policy.excludedSMAAJobs.length === 4 && policy.excludedSMAAJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedSMAAConvertedJobs.length === 14 &&
    policy.excludedSMAAConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.smaaPreparationAndPassPolicyCompileVerified);
  report.smaaPermutationsExcluded = 18;
  report.smaaPreparationAndPassPolicyCompileVerified = true;
  report.smaaRuntimePassSelectionVerified = false;
  report.smaaOverrideOutputFallbackGPUExecutionVerified = false;
  assert(policy.mobileExposurePolicy?.removedPermutations === 5 &&
    policy.mobileExposurePolicy.changedTypes === 5 &&
    policy.excludedMobileExposureJobs.length === 5 &&
    policy.excludedMobileExposureJobs.every(item => valid(item.diagnostic)) &&
    policy.retainedMobilePostProcessJobs.length === 41 &&
    policy.retainedMobilePostProcessJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.mobileExposureConsumerSources.length === 4 && policy.mobileExposureConsumerSources.every(valid) &&
    policy.mobileExposurePreparationAndPassPolicyCompileVerified);
  report.mobileExposurePermutationsExcluded = 5;
  report.mobileExposurePreparationAndPassPolicyCompileVerified = true;
  report.mobileExposureRuntimePassSelectionVerified = false;
  report.mobileExposureFixedExposureFallbackGPUExecutionVerified = false;
  assert(policy.skyAtmospherePolicy?.removedPermutations === 103 &&
    policy.skyAtmospherePolicy.changedTypes === 7 &&
    policy.excludedSkyAtmosphereJobs.length === 3 &&
    policy.excludedSkyAtmosphereJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedSkyAtmosphereConvertedJobs.length === 100 &&
    policy.excludedSkyAtmosphereConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.skyAtmosphereConsumerSources.length === 10 && policy.skyAtmosphereConsumerSources.every(valid) &&
    policy.skyAtmospherePreparationAndPassPolicyCompileVerified);
  report.skyAtmospherePermutationsExcluded = 103;
  report.skyAtmospherePreparationAndPassPolicyCompileVerified = true;
  report.skyAtmosphereRuntimePassSelectionVerified = false;
  report.skyAtmosphereDefaultViewResourcesGPUExecutionVerified = false;
  assert(policy.renderDebugPolicy?.removedPermutations === 5 &&
    policy.renderDebugPolicy.changedTypes === 3 &&
    policy.excludedRenderDebugJobs.length === 4 &&
    policy.excludedRenderDebugJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedRenderDebugConvertedJobs.length === 1 &&
    policy.excludedRenderDebugConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.renderDebugConsumerSources.length === 6 && policy.renderDebugConsumerSources.every(valid) &&
    policy.renderDebugPreparationAndPassPolicyCompileVerified);
  report.renderDebugPermutationsExcluded = 5;
  report.renderDebugPreparationAndPassPolicyCompileVerified = true;
  report.renderDebugRuntimePassSelectionVerified = false;
  report.hdrDebugOverrideOutputFallbackGPUExecutionVerified = false;
  assert(policy.sparseVolumePolicy?.removedPermutations === 4 &&
    policy.sparseVolumePolicy.changedTypes === 2 &&
    policy.excludedSparseVolumeJobs.length === 3 &&
    policy.excludedSparseVolumeJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedSparseVolumeConvertedJobs.length === 1 &&
    policy.excludedSparseVolumeConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.sparseVolumeConsumerSources.length === 4 && policy.sparseVolumeConsumerSources.every(valid) &&
    policy.sparseVolumePreparationAndPassPolicyCompileVerified);
  report.sparseVolumePermutationsExcluded = 4;
  report.sparseVolumePreparationAndPassPolicyCompileVerified = true;
  report.sparseVolumeRuntimePassSelectionVerified = false;
  report.sparseVolumeUploadUnlockAndReleaseRuntimeVerified = false;
  assert(policy.gpuSortPolicy?.removedPermutations === 7 &&
    policy.gpuSortPolicy.changedTypes === 7 &&
    policy.excludedGPUSortJobs.length === 7 &&
    policy.excludedGPUSortJobs.every(item => valid(item.diagnostic)) &&
    policy.gpuSortConsumerSources.length === 8 && policy.gpuSortConsumerSources.every(valid) &&
    policy.gpuSortPreparationAndPassPolicyCompileVerified);
  report.gpuSortPermutationsExcluded = 7;
  report.gpuSortPreparationAndPassPolicyCompileVerified = true;
  report.gpuSortRuntimePassSelectionVerified = false;
  report.cascadeUnsortedFallbackRuntimeVerified = false;
  assert(policy.compositeHMDPolicy?.removedPermutations === 6 &&
    policy.compositeHMDPolicy.changedTypes === 4 &&
    policy.excludedCompositeHMDJobs.length === 3 &&
    policy.excludedCompositeHMDJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedCompositeHMDConvertedJobs.length === 3 &&
    policy.excludedCompositeHMDConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.compositeHMDConsumerSources.length === 6 && policy.compositeHMDConsumerSources.every(valid) &&
    policy.compositeHMDPreparationAndPassPolicyCompileVerified);
  report.compositeHMDPermutationsExcluded = 6;
  report.compositeHMDPreparationAndPassPolicyCompileVerified = true;
  report.compositeHMDRuntimePassSelectionVerified = false;
  report.hmdOverrideOutputFallbackGPUExecutionVerified = false;
  report.editorOnlyCompositeEntryCompileVerified = false;
  assert(policy.landscapeIESPolicy?.removedPermutations === 7 &&
    policy.landscapeIESPolicy.changedTypes === 4 &&
    policy.excludedLandscapeIESJobs.length === 4 &&
    policy.excludedLandscapeIESJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedLandscapeIESConvertedJobs.length === 3 &&
    policy.excludedLandscapeIESConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.landscapeIESConsumerSources.length === 4 && policy.landscapeIESConsumerSources.every(valid) &&
    policy.retainedIESAtlasJobs.length === 1 &&
    policy.retainedIESAtlasJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.landscapeIESPreparationAndPassPolicyCompileVerified);
  report.landscapeIESPermutationsExcluded = 7;
  report.landscapeIESPreparationAndPassPolicyCompileVerified = true;
  report.landscapeIESRuntimePassSelectionVerified = false;
  report.ordinaryLandscapeRenderingVerified = false;
  report.ordinaryIESGPUExecutionVerified = false;
  assert(policy.occlusionFeedbackPolicy?.removedPermutations === 3 &&
    policy.occlusionFeedbackPolicy.changedTypes === 2 &&
    policy.excludedOcclusionFeedbackJobs.length === 2 &&
    policy.excludedOcclusionFeedbackJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedOcclusionFeedbackConvertedJobs.length === 1 &&
    policy.excludedOcclusionFeedbackConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.occlusionFeedbackConsumerSources.length === 8 && policy.occlusionFeedbackConsumerSources.every(valid) &&
    policy.occlusionFeedbackPreparationAndPassPolicyCompileVerified);
  report.occlusionFeedbackPermutationsExcluded = 3;
  report.occlusionFeedbackPreparationAndPassPolicyCompileVerified = true;
  report.occlusionFeedbackRuntimePassSelectionVerified = false;
  report.occlusionFeedbackConsoleEnableOverrideRuntimeVerified = false;
  report.ordinaryOcclusionRuntimeVerified = false;
  assert(policy.vtPageTablePolicy?.removedPermutations === 8 &&
    policy.vtPageTablePolicy.changedTypes === 8 &&
    policy.excludedVTPageTableJobs.length === 2 &&
    policy.excludedVTPageTableJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedVTPageTableConvertedJobs.length === 6 &&
    policy.excludedVTPageTableConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.vtPageTableConsumerSources.length === 8 && policy.vtPageTableConsumerSources.every(valid) &&
    policy.vtPageTablePreparationAndPassPolicyCompileVerified);
  report.vtPageTablePermutationsExcluded = 8;
  report.vtPageTablePreparationAndPassPolicyCompileVerified = true;
  report.vtPageTableRuntimePassSelectionVerified = false;
  report.unsupportedVTAssetRejectionRuntimeVerified = false;
  report.virtualTextureAssetCookVerified = false;
  assert(policy.gpuParticlePolicy?.removedPermutations === 10 &&
    policy.gpuParticlePolicy.changedTypes === 10 &&
    policy.excludedGPUParticleJobs.length === 1 &&
    policy.excludedGPUParticleJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedGPUParticleConvertedJobs.length === 9 &&
    policy.excludedGPUParticleConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.gpuParticleConsumerSources.length === 8 && policy.gpuParticleConsumerSources.every(valid) &&
    policy.gpuParticlePreparationAndPassPolicyCompileVerified);
  report.gpuParticlePermutationsExcluded = 10;
  report.gpuParticlePreparationAndPassPolicyCompileVerified = true;
  report.gpuParticleRuntimePassSelectionVerified = false;
  report.gpuParticleConsoleEnableOverrideRuntimeVerified = false;
  report.gpuParticleAssetCookVerified = false;
  report.cpuParticleRuntimeVerified = false;
  assert(policy.cubeShadowCopyPolicy?.removedPermutations === 2 &&
    policy.cubeShadowCopyPolicy.changedTypes === 2 &&
    policy.excludedCubeShadowCopyJobs.length === 1 &&
    policy.excludedCubeShadowCopyJobs.every(item => valid(item.diagnostic)) &&
    policy.excludedCubeShadowCopyConvertedJobs.length === 1 &&
    policy.excludedCubeShadowCopyConvertedJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.retainedShadowCopyJobs.length === 3 &&
    policy.retainedShadowCopyJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    policy.cubeShadowCopyConsumerSources.length === 6 && policy.cubeShadowCopyConsumerSources.every(valid) &&
    policy.cubeShadowCopyPreparationAndPassPolicyCompileVerified);
  report.cubeShadowCopyPermutationsExcluded = 2;
  report.cubeShadowCopyPreparationAndPassPolicyCompileVerified = true;
  report.cubeShadowCopyRuntimePassSelectionVerified = false;
  report.ordinaryShadowCopyGPUExecutionVerified = false;
  const buffers = load(path.join(results, 'web-buffer-cook-regression-results.json'));
  assert(buffers.pass && buffers.conversionVerified && buffers.shaderGPUExecutionVerified &&
    buffers.allPreviouslyFailedJobsRecompiled && buffers.bufferShaderInventoryUnchanged &&
    buffers.indirectShaderInventoryUnchanged && buffers.indirectDispatchGPUExecutionVerified &&
    buffers.recoveredJobs.length === 26 && buffers.indirectRecoveredJobs.length === 4 &&
    valid(buffers.indirectBaseline) &&
    buffers.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    valid(buffers.baseline) && valid(buffers.shaderSources) && buffers.sourceFiles.every(valid) &&
    buffers.recoveredJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  report.bufferShaderConversionVerified = true;
  report.bufferShaderGPUExecutionVerified = true;
  report.bufferShaderEngineRHIIntegrationVerified = buffers.engineRHIIntegrationVerified;
  report.bufferShaderRecoveredJobs = buffers.recoveredJobs.length;
  report.indirectArgumentRecoveredJobs = buffers.indirectRecoveredJobs;
  report.indirectDispatchGPUExecutionVerified = true;
  report.indirectDispatchesPerBrowser = buffers.indirectDispatchesPerBrowser;
  report.es31ObservedUniqueJobs = buffers.observedUniqueJobs;
  report.es31ObservedSuccessfulUniqueJobs = buffers.observedSuccessfulUniqueJobs;
  report.es31ObservedFailedUniqueJobs = buffers.observedFailedUniqueJobs;
  report.bufferShaderBrowserRuns = buffers.browserRuns.map(run => ({browser: run.browser,
    pass: run.pass, cases: run.checks.length,
    checkedValues: run.checks.reduce((count, item) => count + item.checkedValues, 0)}));

  const textures = load(path.join(results, 'web-texture-update-cook-regression-results.json'));
  assert(textures.pass && textures.conversionVerified && textures.shaderGPUExecutionVerified &&
    textures.textureShaderInventoryUnchanged && textures.recoveredJobs.length === 6 &&
    textures.cook.sha256 === sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    valid(textures.baseline) && valid(textures.shaderSources) && textures.sourceFiles.every(valid) &&
    valid(textures.readWriteNegativeControl) && valid(textures.readWriteCook) &&
    textures.readWriteNegativeJobs.length === 4 &&
    textures.readWriteNegativeJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)) &&
    textures.recoveredJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  report.textureUpdateShaderConversionVerified = true;
  assert.deepEqual([...textures.otherPreviouslyFailedJobsNotRecorded].sort(),
    [...policy.excludedHZBJobs, ...policy.excludedCapsuleJobs, ...policy.excludedMSAAJobs,
      ...policy.excludedFogJobs, ...policy.excludedPointShadowJobs, ...policy.excludedOITJobs,
      ...policy.excludedSMAAJobs, ...policy.excludedMobileExposureJobs, ...policy.excludedSkyAtmosphereJobs,
      ...policy.excludedRenderDebugJobs, ...policy.excludedSparseVolumeJobs, ...policy.excludedGPUSortJobs,
      ...policy.excludedCompositeHMDJobs, ...policy.excludedLandscapeIESJobs, ...policy.excludedOcclusionFeedbackJobs,
      ...policy.excludedVTPageTableJobs, ...policy.excludedGPUParticleJobs, ...policy.excludedCubeShadowCopyJobs]
      .map(item => item.detail.shader).concat(buffers.indirectRecoveredJobs,
        finite.recoveredJobs.map(item => item.shader)).sort());
  report.textureUpdateShaderGPUExecutionVerified = true;
  report.textureUpdateEngineRHIIntegrationVerified = textures.engineRHIIntegrationVerified;
  report.textureUpdateRecoveredJobs = textures.recoveredJobs.length;
  report.textureUpdateBrowserRuns = textures.browserRuns.map(run => ({browser: run.browser,
    pass: run.pass, cases: run.checks.length,
    checkedValues: run.checks.reduce((count, item) => count + item.checkedValues, 0)}));

  const nullCook = checkCook(path.join(results, 'web-engine-cook-results.json'));
  const stage = load(path.join(results, 'web-engine-stage-results.json'));
  assert(nullCook.pass && stage.pass && valid(stage.cookReport) &&
    valid(stage.pack) && valid(stage.manifest) && stage.sourceFiles.every(valid));
  const rejected = load(path.join(results, 'web-engine-webgpu-stage-results.json'));
  report.failedSM5CookRejectedByStage = !sm5.pass && rejected.pass === false &&
    /cook\.pass && cook\.exitCode/.test(rejected.failure || '');
  assert(report.failedSM5CookRejectedByStage);
  const browser = load(path.join(results, 'web-engine-webgpu-results.json'));
  assert(valid(browser.buildReport) && valid(browser.stageReport) && valid(browser.configBundle) &&
    browser.configFiles.every(valid) && browser.sourceFiles.every(valid));
  report.nullRHIBrowserTickVerified = browser.nullRHITickVerified;
  report.nullRHIMinimalPolicyVerified = browser.nullRHIMinimalPolicyVerified;
  report.hardwareEngineTickVerified = browser.engineLoopBrowserTickVerified;
  report.deviceCreationVerified = browser.deviceCreationVerified;
  report.preRHIResourcesInitialized = browser.preRHIResourcesInitialized;
  report.browserRuns = browser.browserRuns.map(({browser, version, rhi, pass, frames, errors, startupBlocker}) =>
    ({browser, version, rhi, pass, frames, pageErrors: errors.length, startupBlocker}));
  assert(report.nullRHIBrowserTickVerified && report.nullRHIMinimalPolicyVerified);
  report.evidenceVerified = true;
  report.pass = report.webgpuShaderCookVerified && report.hardwareEngineTickVerified &&
    report.fullNormalUBTBuildVerified;
  report.boundary = 'Evidence verification is separate from runtime completion. Current native Cook uses ' +
    'rebuilt RenderCore with otherwise installed 5.8.0 modules against a 5.8.3 target branch. ES31 is Cook-only; the browser remains SM5. ' +
    'ES31 Cook and material regressions pass; browser shader loading and a project scene remain unverified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-engine-shadercook-regression-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({evidenceVerified: report.evidenceVerified, pass: report.pass,
    globalShaderSamplesVerified: report.globalShaderSamplesVerified,
    es31EligiblePermutations: report.es31EligiblePermutations,
    es31DistinctRecordedFailedJobs: report.es31DistinctRecordedFailedJobs,
    es31GlobalJobs: report.es31GlobalJobs, es31MaterialJobs: report.es31MaterialJobs,
    materialResourceOnlyBindingRegressionVerified: report.materialResourceOnlyBindingRegressionVerified,
    nullRHIBrowserTickVerified: report.nullRHIBrowserTickVerified,
    hardwareEngineTickVerified: report.hardwareEngineTickVerified, failure: report.failure}, null, 2));
  process.exitCode = report.evidenceVerified ? 0 : 1;
}
