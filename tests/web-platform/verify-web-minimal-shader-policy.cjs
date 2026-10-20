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
const report = {date: new Date().toISOString(), pass: false, nativeCookPolicyVerified: false,
  wasmPolicyCompileLinkVerified: false, runtimePassSelectionVerified: false,
  webgpuShaderCookVerified: false, completeUEScene: false, sourceFiles: [audit(__filename)]};

try {
  const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-finite-capture-shadow-20261020-1008.json');
  const cubeBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-cube-shadow-copy-policy-20261020-0952.json');
  const particleBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-gpu-particle-policy-20261020-0944.json');
  const particleLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-cube-shadow-copy-policy-20261020-0952.json');
  const vtBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-vt-page-table-policy-20261020-0927.json');
  const vtLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-gpu-particle-policy-20261020-0944.json');
  const occlusionBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-occlusion-feedback-policy-20261020-0915.json');
  const occlusionLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-vt-page-table-policy-20261020-0927.json');
  const landscapeBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-landscape-ies-policy-20261019-2054.json');
  const landscapeLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-occlusion-feedback-policy-20261020-0915.json');
  const compositeBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-composite-hmd-policy-20261019-2036.json');
  const compositeLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-landscape-ies-policy-20261019-2054.json');
  const gpuSortBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-gpu-sort-policy-20261019-1929.json');
  const gpuSortLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-composite-hmd-policy-20261019-2036.json');
  const sparseBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-sparse-volume-policy-20261019-1803.json');
  const sparseLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-gpu-sort-policy-20261019-1929.json');
  const renderDebugBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-render-debug-policy-20261019-1752.json');
  const renderDebugLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-sparse-volume-policy-20261019-1803.json');
  const skyBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-sky-atmosphere-policy-20261019-1738.json');
  const skyLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-render-debug-policy-20261019-1752.json');
  const mobileBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-mobile-exposure-policy-20261019-1726.json');
  const smaaBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-smaa-policy-20261019-1714.json');
  const oitBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-oit-policy-20261019-1700.json');
  const pointBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-point-shadow-policy-20261019-1645.json');
  const indirectBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-indirect-args-20261019-1629.json');
  const fogBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-fog-policy-20261019-1611.json');
  const msaaBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-msaa-policy-20261019-1557.json');
  const capsuleBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-capsule-policy-20261019-1535.json');
  const hzbBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-hzb-policy-20261019-1512.json');
  const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
  const buildFile = path.join(results, 'native-rendercore-build-results.json');
  const linkFile = path.join(results, 'web-engine-webgpu-link-results.json');
  const materialPreviousLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-material-policy-20261020-1106.json');
  const previousLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-point-shadow-policy-20261019-1645.json');
  const pointLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-oit-policy-20261019-1700.json');
  const oitCompileFile = path.join(results, 'web-engine-webgpu-link-results-oit-compile-20261019-170112.json');
  const smaaLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-mobile-exposure-policy-20261019-1726.json');
  const mobileLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-sky-atmosphere-policy-20261019-1738.json');
  const priorLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-msaa-policy-20261019-1557.json');
  const msaaLinkFile = path.join(results, 'web-engine-webgpu-link-results-before-fog-policy-20261019-1611.json');
  const fogCompileFile = path.join(results, 'web-engine-webgpu-link-results-fog-depth-missing-20261019-1616.json');
  const baseline = read(baselineFile), cook = read(cookFile), native = read(buildFile), link = read(linkFile);
  const materialPreviousLink = read(materialPreviousLinkFile);
  assert(materialPreviousLink.pass && valid(materialPreviousLink.log));
  const cubeBaseline = read(cubeBaselineFile);
  assert(valid(cubeBaseline.log) && valid(cubeBaseline.shaderInventory.artifact));
  const finiteFile = path.join(results, 'web-finite-capture-shadow-results.json');
  const finite = read(finiteFile);
  assert(finite.pass && finite.conversionVerified && finite.shaderGPUExecutionVerified &&
    finite.numericalShaderEligibilityUnchanged && valid(finite.cook) && finite.cook.sha256 === sha(cookFile) &&
    valid(finite.baseline) && finite.baseline.sha256 === sha(baselineFile) &&
    finite.sourceFiles.every(valid) && finite.recoveredJobs.length === 2 &&
    finite.recoveredJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  const finiteRecovered = new Set(finite.recoveredJobs.map(item => item.shader));
  report.finiteCaptureShadowReport = audit(finiteFile);
  report.finiteCaptureShadowRecoveredJobs = [...finiteRecovered];
  report.finiteCaptureShadowGPUExecutionVerified = true;
  const particleBaseline = read(particleBaselineFile), particleLink = read(particleLinkFile);
  assert(valid(particleBaseline.log) && valid(particleBaseline.shaderInventory.artifact));
  assert(particleLink.pass && valid(particleLink.log) && valid(particleLink.linkResponse));
  const vtBaseline = read(vtBaselineFile), vtLink = read(vtLinkFile);
  assert(valid(vtBaseline.log) && valid(vtBaseline.shaderInventory.artifact));
  assert(vtLink.pass && valid(vtLink.log) && valid(vtLink.linkResponse));
  const occlusionBaseline = read(occlusionBaselineFile), occlusionLink = read(occlusionLinkFile);
  assert(valid(occlusionBaseline.log) && valid(occlusionBaseline.shaderInventory.artifact));
  assert(occlusionLink.pass && valid(occlusionLink.log) && valid(occlusionLink.linkResponse));
  const landscapeBaseline = read(landscapeBaselineFile), landscapeLink = read(landscapeLinkFile);
  assert(valid(landscapeBaseline.log) && valid(landscapeBaseline.shaderInventory.artifact));
  assert(landscapeLink.pass && valid(landscapeLink.log) && valid(landscapeLink.linkResponse));
  const compositeBaseline = read(compositeBaselineFile), compositeLink = read(compositeLinkFile);
  assert(valid(compositeBaseline.log) && valid(compositeBaseline.shaderInventory.artifact));
  assert(compositeLink.pass && valid(compositeLink.log) && valid(compositeLink.linkResponse));
  const gpuSortBaseline = read(gpuSortBaselineFile), gpuSortLink = read(gpuSortLinkFile);
  assert(valid(gpuSortBaseline.log) && valid(gpuSortBaseline.shaderInventory.artifact));
  assert(gpuSortLink.pass && valid(gpuSortLink.log) && valid(gpuSortLink.linkResponse));
  const sparseBaseline = read(sparseBaselineFile), sparseLink = read(sparseLinkFile);
  assert(valid(sparseBaseline.log) && valid(sparseBaseline.shaderInventory.artifact));
  assert(sparseLink.pass && valid(sparseLink.log) && valid(sparseLink.linkResponse));
  const renderDebugBaseline = read(renderDebugBaselineFile), renderDebugLink = read(renderDebugLinkFile);
  assert(valid(renderDebugBaseline.log) && valid(renderDebugBaseline.shaderInventory.artifact));
  assert(renderDebugLink.pass && valid(renderDebugLink.log) && valid(renderDebugLink.linkResponse));
  const skyBaseline = read(skyBaselineFile), skyLink = read(skyLinkFile);
  assert(valid(skyBaseline.log) && valid(skyBaseline.shaderInventory.artifact));
  assert(skyLink.pass && valid(skyLink.log) && valid(skyLink.linkResponse));
  const hzbBaseline = read(hzbBaselineFile);
  const capsuleBaseline = read(capsuleBaselineFile);
  const msaaBaseline = read(msaaBaselineFile);
  const fogBaseline = read(fogBaselineFile);
  const previousLink = read(previousLinkFile);
  const pointLink = read(pointLinkFile), pointBaseline = read(pointBaselineFile);
  const oitCompile = read(oitCompileFile);
  const mobileBaseline = read(mobileBaselineFile), mobileLink = read(mobileLinkFile);
  assert(valid(mobileBaseline.log) && valid(mobileBaseline.shaderInventory.artifact));
  assert(mobileLink.pass && valid(mobileLink.log) && valid(mobileLink.linkResponse));
  const smaaBaseline = read(smaaBaselineFile), smaaLink = read(smaaLinkFile);
  assert(valid(smaaBaseline.log) && valid(smaaBaseline.shaderInventory.artifact));
  assert(smaaLink.pass && valid(smaaLink.log) && valid(smaaLink.linkResponse));
  const oitBaseline = read(oitBaselineFile);
  assert(valid(oitBaseline.log) && valid(oitBaseline.shaderInventory.artifact));
  assert(oitCompile.pass && valid(oitCompile.log) && valid(oitCompile.linkResponse));
  assert(valid(pointBaseline.log) && valid(pointBaseline.shaderInventory.artifact));
  assert(valid(fogBaseline.log) && valid(fogBaseline.shaderInventory.artifact));
  assert(valid(baseline.log) && valid(baseline.shaderInventory.artifact));
  assert(valid(hzbBaseline.log) && valid(hzbBaseline.shaderInventory.artifact));
  assert(valid(capsuleBaseline.log) && valid(capsuleBaseline.shaderInventory.artifact));
  assert(valid(msaaBaseline.log) && valid(msaaBaseline.shaderInventory.artifact));
  assert(valid(cook.log) && cook.sourceFiles.every(valid) && cook.hostProducts.every(valid));
  assert(native.pass && native.installedInputsUnmodified && native.installedInputs.every(valid) &&
    native.sourceFiles.every(valid) && native.products.every(valid) && valid(cook.nativeRenderCoreBuildReport));
  assert.equal(cook.nativeRenderCoreBuildReport.sha256, sha(buildFile));
  const prepared = read(cook.hostPreparationReport.file);
  assert(valid(cook.hostPreparationReport) && valid(prepared.nativeRenderCore) &&
    valid(prepared.nativeRenderCoreBuildReport));
  assert.equal(prepared.nativeRenderCore.sha256,
    native.products.find(item => path.basename(item.file) === 'UnrealEditor-RenderCore.dll').sha256);
  assert(valid(cook.shaderInventory.artifact) && cook.minimalRendererSettingsVerified);
  const before = baseline.shaderInventory.detail, after = cook.shaderInventory.detail;
  assert.deepEqual(read(cook.shaderInventory.artifact.file), after);
  assert.equal(before.registeredTypes, after.registeredTypes);
  for (const [name, value] of Object.entries(before.settings)) assert.deepEqual(after.settings[name], value);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.settings['r.Mobile.SupportGPUScene'], {host: '0', target: '0'});
  assert.deepEqual(after.settings['r.GPUSkin.UseSceneExtension'], {host: 'false', target: 'false'});
  assert.deepEqual(after.settings['r.SupportLocalFogVolumes'], {host: '0', target: '0'});
  assert.deepEqual(after.settings['r.VolumetricFog'], {host: '0', target: '0'});
  assert.equal(after.gpuSceneEnabled, false);
  const capsuleSource = '/Engine/Private/CapsuleShadowShaders.usf';
  const msaaSources = new Set(['/Engine/Private/ResolvePixelShader.usf',
    '/Engine/Private/HdrCustomResolveShaders.usf']);
  const partialMSAATypes = new Set(['FCopyDepthPS', 'FMobileCustomResolvePS']);
  const pointSource = '/Engine/Private/ShadowProjectionPixelShader.usf';
  const oitSource = '/Engine/Private/OIT/OITSorting.usf';
  const skySource = '/Engine/Private/SkyAtmosphere.usf';
  const sparseVolumeSource = '/Engine/Private/SparseVolumeTexture/UpdateSparseVolumeTexture.usf';
  const landscapeSource = '/Engine/Private/Landscape/LandscapeMergeTexturesPS.usf';
  const occlusionSource = '/Engine/Private/OcclusionFeedbackShaders.usf';
  const vtPageTableSource = '/Engine/Private/PageTableUpdate.usf';
  const gpuParticleSources = new Set(['ParticleSimulationShader', 'ParticleInjectionShader',
    'ParticleSimVisualizeShader', 'ParticleCurveInjectionShader'].map(name => `/Engine/Private/${name}.usf`));
  const cubeShadowCopyTypes = new Set(['TScreenVSForGS<true>', 'TScreenVSForGS<false>',
    'FCopyShadowMapsCubeGS', 'FCopyShadowMapsCubePS']);
  const retainedShadowCopyTypes = new Set(['FScreenVS', 'FCopyShadowMaps2DPS', 'FScrollingShadowMaps2DPS']);
  const iesSource = '/Engine/Private/IESAtlas.usf';
  const iesDebugType = 'FIESAtlasDebugInfoCS';
  const gpuSortSources = new Set(['/Engine/Private/RadixSortShaders.usf', '/Engine/Private/BitonicSort.usf']);
  const compositeHMDSources = new Set(['/Engine/Private/PostProcessCompositePrimitives.usf',
    '/Engine/Private/PostProcessHMD.usf']);
  const renderDebugSources = new Set(['/Engine/Private/Tools/VisualizeLightShape.usf',
    '/Engine/Private/PostProcessVisualizeHDR.usf']);
  const mobileSource = '/Engine/Private/PostProcessMobile.usf';
  const mobileExposureTypes = new Set(['FMobileAverageLuminanceCS', 'TMobileHistogramCS< true >',
    'TMobileHistogramCS< false >', 'FMobileBasicEyeAdaptationCS', 'FMobileHistogramEyeAdaptationCS']);
  const mobileExposureEntries = new Set(['AverageLuminance_MainCS', 'Histogram_MainCS',
    'BasicEyeAdaptationCS_Mobile', 'HistogramEyeAdaptationCS']);
  const smaaSources = new Set(['SMAAEdgeDetectionShader', 'SMAABlendingWeightCalculationShader',
    'SMAANeighborhoodBlendingShader', 'SMAADebugVisualization']
    .map(name => `/Engine/Private/SMAA/${name}.usf`));
  const pointTypes = new Set(before.types.filter(item => item.source === pointSource &&
    item.name.startsWith('FOnePassPointShadowProjectionPS')).map(item => item.name));
  assert.equal(pointTypes.size, 15);
  const fogSources = new Set(['/Engine/Private/LocalFogVolumes/LocalFogVolumeSplat.usf',
    '/Engine/Private/LocalFogVolumes/LocalFogVolumeTiledCulling.usf',
    '/Engine/Private/VolumetricFog.usf', '/Engine/Private/VolumetricFogVoxelization.usf',
    '/Engine/Private/VolumetricFogLightFunction.usf']);
  const excluded = new Set(['/Engine/Private/GenerateConservativeDepth.usf', ...gpuParticleSources, vtPageTableSource, occlusionSource, landscapeSource, ...compositeHMDSources, ...gpuSortSources, sparseVolumeSource, ...renderDebugSources, skySource, ...smaaSources, oitSource, ...fogSources, ...msaaSources, capsuleSource, '/Engine/Private/LightGridInjection.usf', '/Engine/Private/MobileFog.usf',
    '/Engine/Private/Tools/GPUDebugCrashUtils.usf',
    '/Engine/Private/ShaderPrintDraw.usf', '/Engine/Private/ShaderPrintDrawPrimitive.usf',
    '/Engine/Private/InstanceCulling/BuildInstanceDrawCommands.usf',
    '/Engine/Private/InstanceCulling/CompactVisibleInstances.usf',
    '/Engine/Private/InstanceCulling/InstanceCullingOcclusionQuery.usf',
    '/Engine/Private/GPUScene/GPUSceneDataManagement.usf', '/Engine/Private/GPUSceneDebugRender.usf',
    ...['AnimSequenceTransformProvider', 'AnimBankEval', 'TransformProviders',
      'CopyPreviousTransforms', 'ResolveAttachments', 'SkinnedMeshDebug']
      .map(name => `/Engine/Private/Skinning/${name}.usf`)]);
  const priorTypes = new Map(before.types.map(item => [item.name, item]));
  assert.equal(priorTypes.size, after.types.length);
  let removedPermutations = 0, unchangedTypes = 0;
  report.excludedTypes = [];
  for (const type of after.types) {
    const prior = priorTypes.get(type.name);
    assert(prior && prior.source === type.source && prior.frequency === type.frequency);
    if (type.name === 'FHZBBuildCS') {
      assert.equal(type.source, '/Engine/Private/HZB.usf');
      assert.equal(prior.permutations, 48);
      assert.equal(type.permutations, 48);
      report.hzbVisibilityPolicy = {name: type.name, source: type.source,
        previousPermutations: prior.permutations, currentPermutations: type.permutations,
        excludedVisibilityFormat: 3, ordinaryDepthPreserved: true, unchangedThisRound: true};
    } else if (cubeShadowCopyTypes.has(type.name)) {
      assert.equal(type.source, type.name.startsWith('TScreenVSForGS') ?
        '/Engine/Private/ScreenVertexShader.usf' : '/Engine/Private/CopyShadowMaps.usf');
      assert.equal(type.permutations, 0);
      removedPermutations += prior.permutations;
      report.excludedTypes.push({name: type.name, source: type.source,
        previousPermutations: prior.permutations, currentPermutations: type.permutations});
    } else if (pointTypes.has(type.name) || mobileExposureTypes.has(type.name) || type.name === iesDebugType) {
      assert.equal(type.source, pointTypes.has(type.name) ? pointSource :
        type.name === iesDebugType ? iesSource : mobileSource);
      assert.equal(type.permutations, 0);
      removedPermutations += prior.permutations;
      report.excludedTypes.push({name: type.name, source: type.source,
        previousPermutations: prior.permutations, currentPermutations: type.permutations});
    } else if (partialMSAATypes.has(type.name)) {
      assert.equal(prior.permutations, 1);
      assert.equal(type.permutations, 1);
      removedPermutations += prior.permutations - type.permutations;
      report.excludedTypes.push({name: type.name, source: type.source,
        previousPermutations: prior.permutations, currentPermutations: type.permutations});
    } else if (excluded.has(type.source)) {
      assert.equal(type.permutations, 0);
      removedPermutations += prior.permutations;
      report.excludedTypes.push({name: type.name, source: type.source,
        previousPermutations: prior.permutations, currentPermutations: type.permutations});
    } else {
      assert.equal(type.permutations, prior.permutations, `Unexpected policy change: ${type.name}`);
      ++unchangedTypes;
    }
  }
  assert.equal(before.permutations - after.permutations, removedPermutations);
  let attemptedJobs = 0;
  const conversion = path.join(cook.output, 'ShaderConversion');
  for (const entry of fs.readdirSync(conversion, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const file = path.join(conversion, entry.name, 'input.json');
    if (!fs.existsSync(file)) continue;
    const input = read(file);
    for (const source of excluded) assert(!input.shader.includes(source), input.shader);
    assert(!pointTypes.has(input.shaderName));
    assert(!cubeShadowCopyTypes.has(input.shaderName));
    assert(!mobileExposureTypes.has(input.shaderName));
    assert.notEqual(input.shaderName, iesDebugType);
    ++attemptedJobs;
  }
  assert(attemptedJobs > 0);
  assert(cook.shaderFailures.every(item => valid(item.diagnostic) && !excluded.has(item.detail.source) &&
    !cubeShadowCopyTypes.has(item.detail.shaderName) &&
    !pointTypes.has(item.detail.shaderName) &&
    !mobileExposureTypes.has(item.detail.shaderName) &&
    item.detail.shaderName !== iesDebugType &&
    !partialMSAATypes.has(item.detail.shaderName) &&
    item.detail.shaderName !== 'FHZBBuildCS'));
  const baselineHZBFailures = new Map(hzbBaseline.shaderFailures
    .filter(item => item.detail.shaderName === 'FHZBBuildCS').map(item => [item.detail.shader, item]));
  assert.equal(baselineHZBFailures.size, 12);
  assert([...baselineHZBFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.error.includes('SPV_EXT_shader_image_int64')));
  report.excludedHZBJobs = [...baselineHZBFailures.values()];
  report.hzbExclusionBaseline = audit(hzbBaselineFile);
  const capsuleTypes = capsuleBaseline.shaderInventory.detail.types.filter(item => item.source === capsuleSource);
  assert.deepEqual(capsuleTypes.map(item => [item.name, item.permutations]).sort(),
    [['FCapsuleShadowingCS', 15], ['FCapsuleShadowingUpsamplePS', 4],
      ['FCapsuleShadowingUpsampleVS', 1], ['FComputeLightDirectionFromVolumetricLightmapCS', 0]].sort());
  const capsuleFailures = new Map(capsuleBaseline.shaderFailures
    .filter(item => item.detail.source === capsuleSource).map(item => [item.detail.shader, item]));
  assert.equal(capsuleFailures.size, 12);
  assert([...capsuleFailures.values()].every(item => valid(item.diagnostic) &&
    (item.detail.error.includes('workgroupBarrier') || item.detail.error.includes('std::isfinite'))));
  report.excludedCapsuleJobs = [...capsuleFailures.values()];
  report.capsuleExclusionBaseline = audit(capsuleBaselineFile);
  report.capsuleShadowPolicy = {previousPermutations: 20, currentPermutations: 0,
    changedTypes: 3, runtimePassSelectionVerified: false};
  const msaaFailures = new Map(msaaBaseline.shaderFailures
    .filter(item => msaaSources.has(item.detail.source) || partialMSAATypes.has(item.detail.shaderName))
    .map(item => [item.detail.shader, item]));
  assert.equal(msaaFailures.size, 17);
  assert([...msaaFailures.values()].every(item => valid(item.diagnostic) &&
    (item.detail.error.includes('descriptor type changed') || item.detail.error.includes('InputAttachmentIndex'))));
  report.excludedMSAAJobs = [...msaaFailures.values()];
  report.msaaExclusionBaseline = audit(msaaBaselineFile);
  report.msaaResolvePolicy = {removedPermutations: 18, changedTypes: 13,
    singleSampleDepthPreserved: true, independentColorResolvePreserved: true,
    runtimePassSelectionVerified: false};
  const fogTypes = fogBaseline.shaderInventory.detail.types.filter(item =>
    fogSources.has(item.source) && item.permutations > 0);
  assert.deepEqual(fogTypes.map(item => [item.name, item.permutations]).sort(), [
    ['FVolumetricFogFinalIntegrationCS', 1], ['FVolumetricFogLightScatteringCS', 17],
    ['FWriteToBoundingSphereVS', 1], ['FVolumetricFogMaterialSetupCS', 4],
    ['FMobileLocalFogVolumeTiledRenderHalfResPS', 1], ['FMobileLocalFogVolumeTiledRenderPS', 1],
    ['FMobileLocalFogVolumeTiledRenderVS', 1], ['FLocalFogVolumeTiledCullingCS', 2],
  ].sort());
  const fogFailures = new Map(fogBaseline.shaderFailures.filter(item => fogSources.has(item.detail.source))
    .map(item => [item.detail.shader, item]));
  assert.equal(fogFailures.size, 7);
  assert([...fogFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedFogJobs = [...fogFailures.values()];
  const fogShaderNames = new Set(fogBaseline.shaderInventory.detail.types
    .filter(item => fogSources.has(item.source)).map(item => item.name));
  const oldFogJobs = new Map(), oldConversion = path.join(fogBaseline.output, 'ShaderConversion');
  for (const entry of fs.readdirSync(oldConversion, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(oldConversion, entry.name), inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!fogShaderNames.has(input.shaderName) || oldFogJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, fogFailures.has(input.shader));
    oldFogJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldFogJobs.size, 28);
  report.excludedFogConvertedJobs = [...oldFogJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedFogConvertedJobs.length, 21);
  report.fogPolicy = {removedPermutations: 28, changedTypes: 8, previousFailedJobs: 7,
    previousConvertedJobsExcluded: 21, runtimePassSelectionVerified: false,
    dummyResourceRuntimeVerified: false, volumeMaterialCookVerified: false};
  const pointFailures = new Map(pointBaseline.shaderFailures
    .filter(item => pointTypes.has(item.detail.shaderName)).map(item => [item.detail.shader, item]));
  assert.equal(pointFailures.size, 10);
  assert([...pointFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.entryPoint === 'MainOnePassPointLightPS' &&
    item.detail.error.includes('descriptor type changed')));
  report.excludedPointShadowJobs = [...pointFailures.values()];
  report.pointShadowPolicy = {removedPermutations: 10, changedTypes: 10,
    entryPoint: 'MainOnePassPointLightPS', runtimePassSelectionVerified: false,
    materialDepthCookVerified: false, ordinaryShadowRenderingVerified: false};
  const oitTypes = oitBaseline.shaderInventory.detail.types.filter(item => item.source === oitSource);
  assert.deepEqual(oitTypes.map(item => [item.name, item.permutations]).sort(), [
    ['FOITSortTriangleIndex_ScanCS', 2], ['FOITSortTriangleIndex_AllocateCS', 1],
    ['FOITSortTriangleIndex_WriteOutCS', 1], ['FOITSortTriangleIndex_Debug', 1],
  ].sort());
  const oitFailures = new Map(oitBaseline.shaderFailures
    .filter(item => item.detail.source === oitSource).map(item => [item.detail.shader, item]));
  assert.equal(oitFailures.size, 5);
  assert([...oitFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedOITJobs = [...oitFailures.values()];
  report.oitPolicy = {removedPermutations: 5, changedTypes: 4,
    sortedIndexAllocationGuarded: true, mobileAndDeferredSchedulingGuarded: true,
    runtimePassSelectionVerified: false, ordinaryTranslucencyRenderingVerified: false};
  const smaaTypes = smaaBaseline.shaderInventory.detail.types.filter(item => smaaSources.has(item.source));
  assert.deepEqual(smaaTypes.map(item => [item.name, item.permutations]).sort(), [
    ['FSMAAEdgeDetectionPS', 4], ['FSMAAEdgeDetectionVS', 1],
    ['FSMAABlendingWeightCalculationPS', 4], ['FSMAABlendingWeightCalculationVS', 4],
    ['FSMAANeighborhoodBlendingPS', 2], ['FSMAANeighborhoodBlendingVS', 1],
    ['FSMAADebugVisualizationPS', 1], ['FSMAADebugVisualizationVS', 1],
  ].sort());
  const smaaFailures = new Map(smaaBaseline.shaderFailures
    .filter(item => smaaSources.has(item.detail.source)).map(item => [item.detail.shader, item]));
  assert.equal(smaaFailures.size, 4);
  assert([...smaaFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.shaderName === 'FSMAAEdgeDetectionPS' &&
    item.detail.error.includes("'textureSample' must only be called from uniform control flow")));
  report.excludedSMAAJobs = [...smaaFailures.values()];
  const oldSMAAJobs = new Map(), smaaConversion = path.join(smaaBaseline.output, 'ShaderConversion');
  const smaaShaderNames = new Set(smaaTypes.map(item => item.name));
  for (const entry of fs.readdirSync(smaaConversion, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(smaaConversion, entry.name), inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!smaaShaderNames.has(input.shaderName) || oldSMAAJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, smaaFailures.has(input.shader));
    oldSMAAJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldSMAAJobs.size, 18);
  report.excludedSMAAConvertedJobs = [...oldSMAAJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedSMAAConvertedJobs.length, 14);
  report.smaaPolicy = {removedPermutations: 18, changedTypes: 8, previousFailedJobs: 4,
    previousConvertedJobsExcluded: 14, runtimePassSelectionVerified: false,
    overrideOutputFallbackGPUExecutionVerified: false};
  assert.deepEqual(after.settings['r.Mobile.AntiAliasing'], {host: '0', target: '0'});
  assert.deepEqual(after.settings['r.MobileHDR'], {host: '0', target: '0'});
  assert.deepEqual(mobileBaseline.shaderInventory.detail.types.filter(item => mobileExposureTypes.has(item.name))
    .map(item => [item.name, item.source, item.permutations]).sort(),
    [...mobileExposureTypes].map(name => [name, mobileSource, 1]).sort());
  const mobileExposureFailures = new Map(mobileBaseline.shaderFailures
    .filter(item => mobileExposureTypes.has(item.detail.shaderName))
    .map(item => [item.detail.shader, item]));
  assert.equal(mobileExposureFailures.size, 5);
  assert([...mobileExposureFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.source === mobileSource && mobileExposureEntries.has(item.detail.entryPoint) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedMobileExposureJobs = [...mobileExposureFailures.values()];
  report.mobileExposurePolicy = {removedPermutations: 5, changedTypes: 5,
    sharedFileOtherPermutationsPreserved: 41, runtimePassSelectionVerified: false,
    fixedExposureFallbackGPUExecutionVerified: false};
  const skyTypes = skyBaseline.shaderInventory.detail.types.filter(item => item.source === skySource);
  assert.deepEqual(skyTypes.map(item => [item.name, item.permutations]).sort(), [
    ['FRenderSkyAtmosphereVS', 0], ['FRenderSkyAtmospherePS', 0],
    ['FRenderTransmittanceLutCS', 1], ['FRenderMultiScatteredLuminanceLutCS', 2],
    ['FRenderDistantSkyLightLutCS', 2], ['FRenderSkyViewLutCS', 32],
    ['FRenderCameraAerialPerspectiveVolumeCS', 64], ['FRenderDebugSkyAtmospherePS', 1],
    ['RenderSkyAtmosphereEditorHudPS', 1],
  ].sort());
  const skyFailures = new Map(skyBaseline.shaderFailures
    .filter(item => item.detail.source === skySource).map(item => [item.detail.shader, item]));
  assert.equal(skyFailures.size, 3);
  assert([...skyFailures.values()].every(item => valid(item.diagnostic) &&
    ['FRenderDistantSkyLightLutCS', 'FRenderMultiScatteredLuminanceLutCS'].includes(item.detail.shaderName) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedSkyAtmosphereJobs = [...skyFailures.values()];
  const oldSkyJobs = new Map(), oldSkyConversion = path.join(skyBaseline.output, 'ShaderConversion');
  const skyNames = new Set(skyTypes.map(item => item.name));
  for (const entry of fs.readdirSync(oldSkyConversion, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(oldSkyConversion, entry.name), inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!skyNames.has(input.shaderName) || oldSkyJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, skyFailures.has(input.shader));
    oldSkyJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldSkyJobs.size, 103);
  report.excludedSkyAtmosphereConvertedJobs = [...oldSkyJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedSkyAtmosphereConvertedJobs.length, 100);
  report.skyAtmospherePolicy = {removedPermutations: 103, changedTypes: 7, previousFailedJobs: 3,
    previousConvertedJobsExcluded: 100, runtimePassSelectionVerified: false,
    defaultViewResourcesGPUExecutionVerified: false, sampleBufferInitSkipRuntimeVerified: false};
  assert.deepEqual(after.settings['r.SupportSkyAtmosphere'], {host: '0', target: '0'});
  const renderDebugTypes = renderDebugBaseline.shaderInventory.detail.types.filter(item => renderDebugSources.has(item.source));
  assert.deepEqual(renderDebugTypes.map(item => [item.name, item.permutations]).sort(),
    [['FVisualizeLightShapeVS', 3], ['FVisualizeLightShapePS', 1], ['FVisualizeHDRPS', 1]].sort());
  const renderDebugFailures = new Map(renderDebugBaseline.shaderFailures
    .filter(item => renderDebugSources.has(item.detail.source)).map(item => [item.detail.shader, item]));
  assert.equal(renderDebugFailures.size, 4);
  assert([...renderDebugFailures.values()].every(item => valid(item.diagnostic) &&
    (item.detail.shaderName === 'FVisualizeLightShapeVS' ?
      item.detail.error === 'Binding contract: parameter descriptor missing' :
      item.detail.shaderName === 'FVisualizeHDRPS' &&
      item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported"))));
  report.excludedRenderDebugJobs = [...renderDebugFailures.values()];
  const oldRenderDebugJobs = new Map();
  for (const entry of fs.readdirSync(path.join(renderDebugBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(renderDebugBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!renderDebugTypes.some(type => type.name === input.shaderName) || oldRenderDebugJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, renderDebugFailures.has(input.shader));
    oldRenderDebugJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldRenderDebugJobs.size, 5);
  report.excludedRenderDebugConvertedJobs = [...oldRenderDebugJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedRenderDebugConvertedJobs.length, 1);
  assert(report.excludedRenderDebugConvertedJobs[0].shader.startsWith('Global/FVisualizeLightShapePS/'));
  report.renderDebugPolicy = {removedPermutations: 5, changedTypes: 3, previousFailedJobs: 4,
    previousConvertedJobsExcluded: 1, runtimePassSelectionVerified: false,
    hdrOverrideOutputFallbackGPUExecutionVerified: false, lightShapeResourceSkipRuntimeVerified: false};
  const sparseVolumeTypes = sparseBaseline.shaderInventory.detail.types.filter(item => item.source === sparseVolumeSource);
  assert.deepEqual(sparseVolumeTypes.map(item => [item.name, item.permutations]).sort(),
    [['FSparseVolumeTextureUpdateFromSparseBufferCS', 3], ['FSparseVolumeTextureUpdatePageTableCS', 1]].sort());
  const sparseVolumeFailures = new Map(sparseBaseline.shaderFailures
    .filter(item => item.detail.source === sparseVolumeSource).map(item => [item.detail.shader, item]));
  assert.equal(sparseVolumeFailures.size, 3);
  assert([...sparseVolumeFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.shaderName === 'FSparseVolumeTextureUpdateFromSparseBufferCS' &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedSparseVolumeJobs = [...sparseVolumeFailures.values()];
  const oldSparseVolumeJobs = new Map();
  for (const entry of fs.readdirSync(path.join(sparseBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(sparseBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!sparseVolumeTypes.some(type => type.name === input.shaderName) || oldSparseVolumeJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, sparseVolumeFailures.has(input.shader));
    oldSparseVolumeJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldSparseVolumeJobs.size, 4);
  report.excludedSparseVolumeConvertedJobs = [...oldSparseVolumeJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedSparseVolumeConvertedJobs.length, 1);
  assert(report.excludedSparseVolumeConvertedJobs[0].shader.startsWith('Global/FSparseVolumeTextureUpdatePageTableCS/'));
  report.sparseVolumePolicy = {removedPermutations: 4, changedTypes: 2, previousFailedJobs: 3,
    previousConvertedJobsExcluded: 1, runtimePassSelectionVerified: false,
    uploadUnlockAndReleaseRuntimeVerified: false, streamingResourceSkipRuntimeVerified: false};
  const gpuSortTypes = gpuSortBaseline.shaderInventory.detail.types.filter(item => gpuSortSources.has(item.source));
  assert.deepEqual(gpuSortTypes.map(item => [item.name, item.permutations]).sort(),
    ['FRadixSortClearOffsetsCS', 'FRadixSortUpsweepCS', 'FRadixSortSpineCS', 'FRadixSortDownsweepCS',
      'FBitonicSortLocalSortCS', 'FBitonicSortGlobalMergeCS', 'FBitonicSortLocalMergeCS']
      .map(name => [name, 1]).sort());
  const gpuSortFailures = new Map(gpuSortBaseline.shaderFailures
    .filter(item => gpuSortSources.has(item.detail.source)).map(item => [item.detail.shader, item]));
  assert.equal(gpuSortFailures.size, 7);
  assert([...gpuSortFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedGPUSortJobs = [...gpuSortFailures.values()];
  report.gpuSortPolicy = {removedPermutations: 7, changedTypes: 7, previousFailedJobs: 7,
    previousConvertedJobsExcluded: 0, runtimePassSelectionVerified: false,
    cascadeUnsortedFallbackRuntimeVerified: false, niagaraSupported: false};
  const compositeHMDTypes = compositeBaseline.shaderInventory.detail.types.filter(item => compositeHMDSources.has(item.source));
  assert.deepEqual(compositeHMDTypes.map(item => [item.name, item.permutations]).sort(),
    [['FHMDDistortionVS', 1], ['FHMDDistortionPS', 1], ['FPopulateCompositeDepthPS', 2],
      ['FTemporalUpsampleDepthPS', 0], ['FCompositePostProcessPrimitivesPS', 2]].sort());
  const compositeHMDFailures = new Map(compositeBaseline.shaderFailures
    .filter(item => compositeHMDSources.has(item.detail.source)).map(item => [item.detail.shader, item]));
  assert.equal(compositeHMDFailures.size, 3);
  assert([...compositeHMDFailures.values()].every(item => valid(item.diagnostic) &&
    ['FPopulateCompositeDepthPS', 'FHMDDistortionPS'].includes(item.detail.shaderName)));
  report.excludedCompositeHMDJobs = [...compositeHMDFailures.values()];
  const oldCompositeHMDJobs = new Map();
  for (const entry of fs.readdirSync(path.join(compositeBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(compositeBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!compositeHMDTypes.some(type => type.name === input.shaderName) || oldCompositeHMDJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, compositeHMDFailures.has(input.shader));
    oldCompositeHMDJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldCompositeHMDJobs.size, 6);
  report.excludedCompositeHMDConvertedJobs = [...oldCompositeHMDJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedCompositeHMDConvertedJobs.length, 3);
  assert(report.excludedCompositeHMDConvertedJobs.every(item =>
    /Global\/(?:FHMDDistortionVS|FCompositePostProcessPrimitivesPS)\//.test(item.shader)));
  report.compositeHMDPolicy = {removedPermutations: 6, changedTypes: 4, previousFailedJobs: 3,
    previousConvertedJobsExcluded: 3, runtimePassSelectionVerified: false,
    hmdOverrideOutputFallbackGPUExecutionVerified: false, editorOnlyEntryCompileVerified: false};
  const landscapeTypes = landscapeBaseline.shaderInventory.detail.types.filter(item => item.source === landscapeSource);
  assert.deepEqual(landscapeTypes.map(item => [item.name, item.permutations]).sort(),
    [['FLandscapeMergeTexturesPS', 2], ['FLandscapeResampleMergedTexturePS', 3],
      ['FLandscapePackRGBAChannelsPS', 1]].sort());
  const iesTypes = landscapeBaseline.shaderInventory.detail.types.filter(item => item.source === iesSource);
  assert.deepEqual(iesTypes.map(item => [item.name, item.permutations]).sort(),
    [[iesDebugType, 1], ['FIESAtlasAddTextureCS', 1], ['FIESAtlasAddTexturePS', 0]].sort());
  for (const type of iesTypes.filter(item => item.name !== iesDebugType)) {
    assert.deepEqual(after.types.find(item => item.name === type.name), type);
  }
  const isLandscapeIES = item => item.source === landscapeSource || item.shaderName === iesDebugType;
  const landscapeIESFailures = new Map(landscapeBaseline.shaderFailures
    .filter(item => isLandscapeIES(item.detail)).map(item => [item.detail.shader, item]));
  assert.equal(landscapeIESFailures.size, 4);
  assert([...landscapeIESFailures.values()].every(item => valid(item.diagnostic) &&
    (item.detail.shaderName === iesDebugType ?
      item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported") :
      item.detail.shaderName === 'FLandscapeResampleMergedTexturePS' &&
      item.detail.error.includes("'textureSample' must only be called from uniform control flow"))));
  report.excludedLandscapeIESJobs = [...landscapeIESFailures.values()];
  const oldLandscapeIESJobs = new Map();
  for (const entry of fs.readdirSync(path.join(landscapeBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(landscapeBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!(landscapeTypes.some(type => type.name === input.shaderName) || input.shaderName === iesDebugType) ||
        oldLandscapeIESJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, landscapeIESFailures.has(input.shader));
    oldLandscapeIESJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldLandscapeIESJobs.size, 7);
  report.excludedLandscapeIESConvertedJobs = [...oldLandscapeIESJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedLandscapeIESConvertedJobs.length, 3);
  assert(report.excludedLandscapeIESConvertedJobs.every(item =>
    /Global\/FLandscape(?:MergeTexturesPS|PackRGBAChannelsPS)\//.test(item.shader)));
  report.landscapeIESPolicy = {removedPermutations: 7, changedTypes: 4, previousFailedJobs: 4,
    previousConvertedJobsExcluded: 3, runtimePassSelectionVerified: false,
    ordinaryLandscapeRenderingVerified: false, ordinaryIESGPUExecutionVerified: false};
  const occlusionTypes = occlusionBaseline.shaderInventory.detail.types.filter(item => item.source === occlusionSource);
  assert.deepEqual(occlusionTypes.map(item => [item.name, item.permutations]).sort(),
    [['FOcclusionFeedbackVS', 1], ['FOcclusionFeedbackPS', 2]].sort());
  const occlusionFailures = new Map(occlusionBaseline.shaderFailures
    .filter(item => item.detail.source === occlusionSource).map(item => [item.detail.shader, item]));
  assert.equal(occlusionFailures.size, 2);
  assert([...occlusionFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.shaderName === 'FOcclusionFeedbackPS' &&
    item.detail.error.includes('ExecutionMode EarlyFragmentTests is not supported in WGSL')));
  report.excludedOcclusionFeedbackJobs = [...occlusionFailures.values()];
  const oldOcclusionJobs = new Map();
  for (const entry of fs.readdirSync(path.join(occlusionBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(occlusionBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!occlusionTypes.some(type => type.name === input.shaderName) || oldOcclusionJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, occlusionFailures.has(input.shader));
    oldOcclusionJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldOcclusionJobs.size, 3);
  report.excludedOcclusionFeedbackConvertedJobs = [...oldOcclusionJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedOcclusionFeedbackConvertedJobs.length, 1);
  assert(report.excludedOcclusionFeedbackConvertedJobs[0].shader.startsWith('Global/FOcclusionFeedbackVS/'));
  report.occlusionFeedbackPolicy = {removedPermutations: 3, changedTypes: 2, previousFailedJobs: 2,
    previousConvertedJobsExcluded: 1, runtimePassSelectionVerified: false,
    consoleEnableOverrideRuntimeVerified: false, ordinaryOcclusionRuntimeVerified: false};
  const vtPageTableTypes = vtBaseline.shaderInventory.detail.types.filter(item => item.source === vtPageTableSource);
  assert.deepEqual(vtPageTableTypes.map(item => [item.name, item.permutations]).sort(),
    ['TPageTableUpdateVS<true>', 'TPageTableUpdateVS<false>',
      ...['R16', 'R16G16', 'R16G16B16A16', 'R32', 'R32G32', 'R32G32B32A32']
        .map(format => `TPageTableUpdatePS<PF_${format}_UINT>`)].map(name => [name, 1]).sort());
  const vtPageTableFailures = new Map(vtBaseline.shaderFailures
    .filter(item => item.detail.source === vtPageTableSource).map(item => [item.detail.shader, item]));
  assert.equal(vtPageTableFailures.size, 2);
  assert([...vtPageTableFailures.values()].every(item => valid(item.diagnostic) &&
    /^TPageTableUpdateVS<(?:true|false)>$/.test(item.detail.shaderName) &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedVTPageTableJobs = [...vtPageTableFailures.values()];
  const oldVTPageTableJobs = new Map();
  for (const entry of fs.readdirSync(path.join(vtBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(vtBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!vtPageTableTypes.some(type => type.name === input.shaderName) || oldVTPageTableJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, vtPageTableFailures.has(input.shader));
    oldVTPageTableJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldVTPageTableJobs.size, 8);
  report.excludedVTPageTableConvertedJobs = [...oldVTPageTableJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedVTPageTableConvertedJobs.length, 6);
  assert(report.excludedVTPageTableConvertedJobs.every(item => item.shader.startsWith('Global/TPageTableUpdatePS<')));
  report.vtPageTablePolicy = {removedPermutations: 8, changedTypes: 8, previousFailedJobs: 2,
    previousConvertedJobsExcluded: 6, runtimePassSelectionVerified: false,
    unsupportedAssetRejectionRuntimeVerified: false, virtualTextureAssetCookVerified: false};
  const gpuParticleTypes = particleBaseline.shaderInventory.detail.types.filter(item => gpuParticleSources.has(item.source));
  assert.deepEqual(gpuParticleTypes.filter(item => item.permutations > 0).map(item => [item.name, item.permutations]).sort(),
    ['FParticleTileVS', 'TParticleSimulationPS<PCM_None>', 'FParticleSimulationClearPS',
      'FParticleInjectionVS', 'TParticleInjectionPS<true>', 'TParticleInjectionPS<false>',
      'FParticleSimVisualizeVS', 'FParticleSimVisualizePS', 'FParticleCurveInjectionVS',
      'FParticleCurveInjectionPS'].map(name => [name, 1]).sort());
  const gpuParticleFailures = new Map(particleBaseline.shaderFailures
    .filter(item => gpuParticleSources.has(item.detail.source)).map(item => [item.detail.shader, item]));
  assert.equal(gpuParticleFailures.size, 1);
  assert([...gpuParticleFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.shaderName === 'FParticleTileVS' &&
    item.detail.error.includes("SPIR-V capability 'SampledBuffer' is not supported")));
  report.excludedGPUParticleJobs = [...gpuParticleFailures.values()];
  const oldGPUParticleJobs = new Map();
  for (const entry of fs.readdirSync(path.join(particleBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(particleBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!gpuParticleSources.has(input.source) &&
      !gpuParticleTypes.some(type => type.name === input.shaderName)) continue;
    if (oldGPUParticleJobs.has(input.shader)) continue;
    assert(gpuParticleTypes.some(type => type.name === input.shaderName && type.permutations === 1));
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, gpuParticleFailures.has(input.shader));
    oldGPUParticleJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldGPUParticleJobs.size, 10);
  report.excludedGPUParticleConvertedJobs = [...oldGPUParticleJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedGPUParticleConvertedJobs.length, 9);
  report.gpuParticlePolicy = {removedPermutations: 10, changedTypes: 10, previousFailedJobs: 1,
    previousConvertedJobsExcluded: 9, runtimePassSelectionVerified: false,
    consoleEnableOverrideRuntimeVerified: false, gpuParticleAssetCookVerified: false,
    cpuParticleRuntimeVerified: false};
  assert.deepEqual(cubeBaseline.shaderInventory.detail.types.filter(item => cubeShadowCopyTypes.has(item.name))
    .map(item => [item.name, item.permutations]).sort(), [
      ['TScreenVSForGS<true>', 1], ['TScreenVSForGS<false>', 0],
      ['FCopyShadowMapsCubeGS', 0], ['FCopyShadowMapsCubePS', 1]].sort());
  const cubeShadowCopyFailures = new Map(cubeBaseline.shaderFailures
    .filter(item => cubeShadowCopyTypes.has(item.detail.shaderName)).map(item => [item.detail.shader, item]));
  assert.equal(cubeShadowCopyFailures.size, 1);
  assert([...cubeShadowCopyFailures.values()].every(item => valid(item.diagnostic) &&
    item.detail.shaderName === 'TScreenVSForGS<true>' && item.detail.entryPoint === 'MainForGS' &&
    item.detail.error.includes("SPIR-V extension 'SPV_EXT_shader_viewport_index_layer' is not supported")));
  report.excludedCubeShadowCopyJobs = [...cubeShadowCopyFailures.values()];
  const oldCubeShadowCopyJobs = new Map();
  for (const entry of fs.readdirSync(path.join(cubeBaseline.output, 'ShaderConversion'), {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(cubeBaseline.output, 'ShaderConversion', entry.name);
    const inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (!cubeShadowCopyTypes.has(input.shaderName) || oldCubeShadowCopyJobs.has(input.shader)) continue;
    const failed = fs.existsSync(path.join(directory, 'failure.json'));
    assert.equal(failed, cubeShadowCopyFailures.has(input.shader));
    oldCubeShadowCopyJobs.set(input.shader, {shader: input.shader, failed, input: audit(inputFile),
      ...(failed ? {} : {spirv: audit(path.join(directory, 'input.spv')),
        wgsl: audit(path.join(directory, 'output.wgsl'))})});
  }
  assert.equal(oldCubeShadowCopyJobs.size, 2);
  report.excludedCubeShadowCopyConvertedJobs = [...oldCubeShadowCopyJobs.values()].filter(item => !item.failed);
  assert.equal(report.excludedCubeShadowCopyConvertedJobs.length, 1);
  assert(report.excludedCubeShadowCopyConvertedJobs[0].shader.startsWith('Global/FCopyShadowMapsCubePS/'));
  report.cubeShadowCopyPolicy = {removedPermutations: 2, changedTypes: 2, previousFailedJobs: 1,
    previousConvertedJobsExcluded: 1, runtimePassSelectionVerified: false,
    ordinaryShadowCopyGPUExecutionVerified: false};
  report.retainedShadowCopyJobs = [];
  report.retainedIESAtlasJobs = [];
  report.retainedMobilePostProcessJobs = [];
  report.retainedOrdinaryShadowJobs = [];
  report.retainedSingleSampleJobs = [];
  report.retainedHZBJobs = [];
  const observed = new Map();
  for (const entry of fs.readdirSync(conversion, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(conversion, entry.name), inputFile = path.join(directory, 'input.json');
    if (!fs.existsSync(inputFile)) continue;
    const input = read(inputFile);
    if (retainedShadowCopyTypes.has(input.shaderName)) {
      const type = before.types.find(item => item.name === input.shaderName);
      const entryPoint = input.shaderName === 'FScreenVS' ? 'Main' :
        input.shaderName === 'FCopyShadowMaps2DPS' ? 'Copy2DDepthPS' : 'Scrolling2DDepthPS';
      assert(input.shader.endsWith(`${type.source}|${entryPoint}`));
      assert(!fs.existsSync(path.join(directory, 'failure.json')));
      if (!report.retainedShadowCopyJobs.some(item => item.shader === input.shader)) {
        report.retainedShadowCopyJobs.push({shader: input.shader, name: input.shaderName, input: audit(inputFile),
          spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(path.join(directory, 'output.wgsl'))});
      }
    }
    if (input.shaderName === 'FIESAtlasAddTextureCS') {
      assert(input.shader.endsWith(`${iesSource}|MainCS`));
      assert(!fs.existsSync(path.join(directory, 'failure.json')));
      if (!report.retainedIESAtlasJobs.some(item => item.shader === input.shader)) {
        report.retainedIESAtlasJobs.push({shader: input.shader, input: audit(inputFile),
          spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(path.join(directory, 'output.wgsl'))});
      }
    }
    if (before.types.some(type => type.name === input.shaderName && type.source === mobileSource) &&
        !mobileExposureTypes.has(input.shaderName)) {
      assert(!fs.existsSync(path.join(directory, 'failure.json')));
      assert(input.shader.includes(`${mobileSource}|`));
      assert(!mobileExposureEntries.has(input.shader.split('|').at(-1)));
      if (!report.retainedMobilePostProcessJobs.some(item => item.shader === input.shader)) {
        report.retainedMobilePostProcessJobs.push({shader: input.shader, name: input.shaderName,
          input: audit(inputFile), spirv: audit(path.join(directory, 'input.spv')),
          wgsl: audit(path.join(directory, 'output.wgsl'))});
      }
    }
    if (before.types.some(type => type.name === input.shaderName && type.source === pointSource) &&
        !pointTypes.has(input.shaderName)) {
      assert(!fs.existsSync(path.join(directory, 'failure.json')));
      assert(input.shader.endsWith(`${pointSource}|Main`));
      if (!report.retainedOrdinaryShadowJobs.some(item => item.shader === input.shader)) {
        report.retainedOrdinaryShadowJobs.push({shader: input.shader, name: input.shaderName,
          input: audit(inputFile), spirv: audit(path.join(directory, 'input.spv')),
          wgsl: audit(path.join(directory, 'output.wgsl'))});
      }
    }
    assert(!baselineHZBFailures.has(input.shader), input.shader);
    assert(!capsuleFailures.has(input.shader) && !msaaFailures.has(input.shader) &&
      !fogFailures.has(input.shader), input.shader);
    if (partialMSAATypes.has(input.shaderName)) {
      assert(!fs.existsSync(path.join(directory, 'failure.json')));
      const bindings = input.metadata.spirvBindings;
      assert(bindings.every(item => !item.textureMultisampled && item.descriptorType !== 10));
      const textureName = input.shaderName === 'FCopyDepthPS' ? 'DepthTexture' : 'ColorTexture';
      assert(bindings.some(item => item.name === textureName && item.descriptorType === 2 &&
        item.textureDimension === 1 && item.textureArrayed === false && item.textureMultisampled === false));
      if (!report.retainedSingleSampleJobs.some(item => item.shader === input.shader)) {
        report.retainedSingleSampleJobs.push({shader: input.shader, name: input.shaderName,
          input: audit(inputFile), spirv: audit(path.join(directory, 'input.spv')),
          wgsl: audit(path.join(directory, 'output.wgsl'))});
      }
    }
    if (!['FHZBBuildCS', 'FHZBBuildPS'].includes(input.shaderName)) continue;
    assert(!fs.existsSync(path.join(directory, 'failure.json')));
    if (!observed.has(input.shader)) {
      observed.set(input.shader, input.shaderName);
      report.retainedHZBJobs.push({shader: input.shader, input: audit(inputFile),
        spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(path.join(directory, 'output.wgsl'))});
    }
  }
  assert.equal([...observed.values()].filter(name => name === 'FHZBBuildCS').length, 48);
  assert.equal([...observed.values()].filter(name => name === 'FHZBBuildPS').length, 2);
  assert.deepEqual(report.retainedSingleSampleJobs.map(item => item.name).sort(), [...partialMSAATypes].sort());
  assert.equal(report.retainedOrdinaryShadowJobs.length, 15);
  assert.equal(report.retainedMobilePostProcessJobs.length, 41);
  assert.equal(report.retainedIESAtlasJobs.length, 1);
  assert.deepEqual(report.retainedShadowCopyJobs.map(item => item.name).sort(), [...retainedShadowCopyTypes].sort());
  report.nativeCookPolicyVerified = true;
  report.registeredTypes = after.registeredTypes;
  report.unchangedTypes = unchangedTypes;
  report.permutationsBefore = before.permutations;
  report.permutationsAfter = after.permutations;
  report.removedPermutations = removedPermutations;
  report.gpuSceneEnabled = after.gpuSceneEnabled;
  report.changedTypes = report.excludedTypes.filter(item =>
    item.previousPermutations !== item.currentPermutations).length;
  report.unchangedPermutationTypes = after.registeredTypes - report.changedTypes;
  const previousFailures = new Map(baseline.shaderFailures.map(item => [item.detail.shader, item.detail]));
  const currentFailures = new Map(cook.shaderFailures.filter(item => item.detail.shader.startsWith('Global/'))
    .map(item => [item.detail.shader, item.detail]));
  report.removedDiagnosticSources = ['/Engine/Private/Tools/GPUDebugCrashUtils.usf',
    '/Engine/Private/ShaderPrintDraw.usf', '/Engine/Private/ShaderPrintDrawPrimitive.usf'];
  report.previouslyFailedDiagnosticJobs = [...previousFailures.values()]
    .filter(item => report.removedDiagnosticSources.includes(item.source)).length;
  report.previousExcludedFailedJobs = [...previousFailures.values()]
    .filter(item => excluded.has(item.source) || partialMSAATypes.has(item.shaderName) ||
      cubeShadowCopyTypes.has(item.shaderName) ||
      pointTypes.has(item.shaderName) || mobileExposureTypes.has(item.shaderName) || item.shaderName === iesDebugType).length;
  report.previousOtherFailedJobsNotRecorded = [...previousFailures]
    .filter(([name, item]) => !excluded.has(item.source) && !partialMSAATypes.has(item.shaderName) &&
      !cubeShadowCopyTypes.has(item.shaderName) &&
      !pointTypes.has(item.shaderName) && !mobileExposureTypes.has(item.shaderName) &&
      item.shaderName !== iesDebugType &&
      !currentFailures.has(name)).length;
  const textureUpdateReportFile = path.join(results, 'web-texture-update-cook-regression-results.json');
  const textureUpdates = read(textureUpdateReportFile);
  assert(textureUpdates.pass && textureUpdates.conversionVerified &&
    textureUpdates.shaderGPUExecutionVerified && valid(textureUpdates.cook) &&
    textureUpdates.cook.sha256 === sha(cookFile));
  const bufferReportFile = path.join(results, 'web-buffer-cook-regression-results.json');
  const buffers = read(bufferReportFile);
  assert(buffers.pass && buffers.shaderGPUExecutionVerified && buffers.indirectDispatchGPUExecutionVerified &&
    buffers.indirectShaderInventoryUnchanged && valid(buffers.cook) && buffers.cook.sha256 === sha(cookFile) &&
    valid(buffers.indirectBaseline) && buffers.indirectBaseline.sha256 === sha(indirectBaselineFile) &&
    buffers.indirectRecoveredJobs.length === 4 &&
    buffers.recoveredJobs.every(item => valid(item.input) && valid(item.spirv) && valid(item.wgsl)));
  const recovered = new Set(buffers.indirectRecoveredJobs);
  assert.deepEqual([...buffers.otherPreviouslyFailedJobsNotRecorded].sort(),
    [...pointFailures.keys(), ...oitFailures.keys(), ...smaaFailures.keys(),
      ...mobileExposureFailures.keys(), ...skyFailures.keys(), ...renderDebugFailures.keys(),
      ...sparseVolumeFailures.keys(), ...gpuSortFailures.keys(), ...compositeHMDFailures.keys(),
      ...landscapeIESFailures.keys(), ...occlusionFailures.keys(), ...vtPageTableFailures.keys(),
      ...gpuParticleFailures.keys(), ...cubeShadowCopyFailures.keys(), ...finiteRecovered].sort());
  for (const [name, item] of previousFailures) {
    if (!currentFailures.has(name)) assert(finiteRecovered.has(name), name);
  }
  report.currentNewlyRecordedFailedJobs = [...currentFailures.keys()]
    .filter(name => !previousFailures.has(name)).length;
  assert.equal(report.previousOtherFailedJobsNotRecorded, 2);
  assert.equal(report.previousExcludedFailedJobs, 0);
  report.previousRecoveredFailedJobs = finiteRecovered.size;
  report.previousUnexplainedFailedJobsNotRecorded = 0;
  assert.equal(report.currentNewlyRecordedFailedJobs, 0,
    'Finite capture/shadow fixes must not introduce new failing jobs');
  assert.equal(report.removedPermutations, 1);
  assert.equal(report.changedTypes, 1);
  report.indirectRecoveredJobs = [...recovered];
  report.indirectDispatchGPUExecutionVerified = true;
  report.shaderInventoryUnchangedThisRound = false;
  report.volumetricFogDepthGeneratorExcluded = true;
  assert.equal(report.previouslyFailedDiagnosticJobs, 0);
  report.recordedDistinctFailedJobs = currentFailures.size;
  report.materialFailureDiagnosticsOutsideGlobalInventory = cook.shaderFailures
    .filter(item => !item.detail.shader.startsWith('Global/')).length;
  report.excludedShaderAttempts = 0;

  assert(link.pass && link.linkInputs.every(valid) && link.products.every(valid) &&
    link.sourceFiles.every(valid) && valid(link.log) && valid(link.linkResponse));
  const sources = ['RenderCore/Private/Shader.cpp', 'RenderCore/Private/RenderUtils.cpp',
    'Engine/Public/FXSystem.h', 'Engine/Private/Particles/ParticleGpuSimulation.cpp',
    'Engine/Private/Particles/ParticleCurveTexture.cpp', 'Engine/Private/VectorFieldVisualization.cpp',
    'Landscape/Private/Landscape.cpp', 'Renderer/Private/IESTextureManager.cpp',
    'Renderer/Private/SceneOcclusion.cpp', 'Renderer/Private/SceneVisibility.cpp', 'Renderer/Private/RendererScene.cpp',
    'Renderer/Private/VT/VirtualTextureSpace.cpp',
    'Engine/Private/SparseVolumeTexture/SparseVolumeTextureUpload.cpp',
    'Engine/Private/GPUSort.cpp', 'Engine/Private/GPUBitonicSort.cpp', 'Engine/Private/GPUSortManager.cpp',
    'RenderCore/Private/GPUDebugCrashUtils.cpp', 'Renderer/Private/ShaderPrint.cpp',
    'Renderer/Private/SceneTextureReductions.cpp',
    'Renderer/Private/OIT/OIT.cpp',
    'Renderer/Private/PostProcess/SubpixelMorphologicalAA.cpp', 'Renderer/Private/PostProcess/PostProcessing.cpp',
    'Renderer/Private/PostProcess/PostProcessMobile.cpp',
    'Renderer/Private/SkyAtmosphereRendering.cpp',
    'Renderer/Private/VisualizeLightShape.cpp', 'Renderer/Private/PostProcess/PostProcessVisualizeHDR.cpp',
    'Renderer/Private/PostProcess/PostProcessCompositePrimitivesCommon.cpp', 'Renderer/Private/PostProcess/PostProcessCompositePrimitivesCommon.h',
    'Renderer/Private/PostProcess/PostProcessCompositeDebugPrimitives.cpp', 'Renderer/Private/PostProcess/PostProcessCompositeEditorPrimitives.cpp',
    'Renderer/Private/PostProcess/PostProcessHMD.cpp',
    'Renderer/Private/ShadowRendering.cpp', 'Renderer/Private/ShadowSetup.cpp',
    'Renderer/Private/ShadowDepthRendering.cpp',
    'Renderer/Private/CapsuleShadowRendering.cpp', 'Renderer/Private/CapsuleShadowRendering.h',
    'RenderCore/Private/ResolveShader.cpp', 'Renderer/Private/DepthCopy.cpp', 'Renderer/Private/DepthCopy.h',
    'Renderer/Private/SceneRendering.cpp', 'Renderer/Private/PostProcess/PostProcessTonemap.cpp',
    'Renderer/Public/HdrCustomResolveShaders.h',
    'Renderer/Private/LocalFogVolumeRendering.cpp', 'Renderer/Private/VolumetricFog.cpp',
    'Renderer/Private/VolumetricFogLightFunction.cpp', 'Renderer/Private/VolumetricFogVoxelization.cpp',
    'RenderCore/Public/WebShaderPlatform.h', 'Engine/Private/SkeletalRenderGPUSkin.cpp',
    'Renderer/Private/GenerateConservativeDepthBuffer.cpp',
    'Renderer/Private/LightGridInjection.cpp', 'Renderer/Private/MobileFogRendering.cpp'];
  for (const relative of sources) {
    const target = path.join(root, 'reference-engine/Engine/Source/Runtime', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    assert.equal(sha(target), sha(copied));
    for (const file of [target, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === file && valid(item)));
      report.sourceFiles.push(audit(file));
    }
  }
  const fogCompile = read(fogCompileFile);
  assert(fogCompile.pass === false && fogCompile.exitCode === 1 && valid(fogCompile.log) &&
    fs.readFileSync(fogCompile.log.file, 'utf8').includes('undefined symbol: AddGenerateConservativeDepthBufferPass'));
  const expected = ['Module.RenderCore.3.cpp', 'Module.Renderer.10.cpp', 'Module.Renderer.37.cpp'];
  for (const name of expected) {
    const historical = fogCompile.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      oitCompile.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      pointLink.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
  }
  report.fogCompileAttempt = audit(fogCompileFile);
  const depthObject = link.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.4.cpp');
  assert(depthObject?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(depthObject[key])));
  assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(depthObject.product.file) &&
    item.sha256 === depthObject.product.sha256));
  for (const name of ['GenerateConservativeDepthBuffer.cpp', 'GenerateConservativeDepthBuffer.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private', name);
    const original = name.endsWith('.cpp') ?
      path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private', name) : stock;
    assert.equal(sha(original), sha(copied));
    for (const file of [original, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.sourceFiles.push(audit(file));
    }
  }
  const conservativeDepth = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/GenerateConservativeDepthBuffer.cpp'), 'utf8').replace(/\r\n/g, '\n');
  const stockConservativeDepth = fs.readFileSync(
    'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/GenerateConservativeDepthBuffer.cpp', 'utf8').replace(/\r\n/g, '\n');
  assert.equal(conservativeDepth.replace('#include "WebShaderPlatform.h"\n', '')
    .replace('\tstatic bool ShouldCompilePermutation(const FGlobalShaderPermutationParameters& Parameters)\n' +
      '\t{\n\t\treturn UE::WebGPU::SupportsVolumetricFog(Parameters.Platform);\n\t}\n\n', '')
    .replace('View.HZB && UE::WebGPU::SupportsVolumetricFog(View.GetShaderPlatform())', 'View.HZB'),
  stockConservativeDepth);
  const priorLink = read(priorLinkFile);
  report.retainedCapsuleCompileObjects = ['Module.Renderer.1.cpp', 'Module.Renderer.31.cpp'].map(name => {
    const historical = priorLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      oitCompile.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      pointLink.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const msaaLink = read(msaaLinkFile);
  report.retainedMSAACompileObjects = ['Module.Renderer.2.cpp', 'Module.Renderer.7.cpp',
    'Module.Renderer.22.cpp', 'Module.Renderer.28.cpp'].map(name => {
    const historical = msaaLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      compositeLink.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      mobileLink.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      smaaLink.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  report.wasmPolicyCompileLinkVerified = true;
  report.capsulePreparationAndPassPolicyCompileVerified = true;
  report.msaaResolvePredicatesAndPassPolicyCompileVerified = true;
  report.fogPredicatesAndPassPolicyCompileVerified = true;
  for (const name of ['Module.RenderCore.3.cpp', 'Module.Renderer.30.cpp', 'Module.Renderer.31.cpp']) {
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      materialPreviousLink.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      oitCompile.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      pointLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
  }
  report.pointShadowPreparationAndPassPolicyCompileVerified = true;
  for (const name of ['Module.RenderCore.3.cpp', 'Module.Renderer.19.cpp']) {
    const historical = oitCompile.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
  }
  report.oitCompileAttempt = audit(oitCompileFile);
  report.oitConsumerSources = [];
  for (const name of ['PrimitiveSceneInfo.cpp', 'MobileShadingRenderer.cpp', 'DeferredShadingRenderer.cpp']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private', name);
    assert.equal(sha(stock), sha(copied));
    const source = fs.readFileSync(copied, 'utf8');
    assert(source.includes('OIT::IsSortedTrianglesEnabled('));
    assert(source.includes(name === 'PrimitiveSceneInfo.cpp' ?
      'Scene->OITSceneData.Allocate(' : 'OIT::AddSortTrianglesPass('));
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.oitConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.oitPreparationAndPassPolicyCompileVerified = true;
  report.smaaCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.21.cpp',
    'Module.Renderer.23.cpp', 'Module.Renderer.28.cpp'].map(name => {
    const historical = smaaLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      compositeLink.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      renderDebugLink.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const smaaSource = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/SubpixelMorphologicalAA.cpp'), 'utf8');
  assert.equal((smaaSource.match(/return UE::WebGPU::SupportsSMAA\(Parameters.Platform\);/g) || []).length, 8);
  const smaaEntry = smaaSource.slice(smaaSource.indexOf('FScreenPassTexture AddSMAAPasses('));
  assert(smaaEntry.indexOf('!UE::WebGPU::SupportsSMAA(') < smaaEntry.indexOf('GraphBuilder.CreateTexture('));
  assert(smaaEntry.includes('Inputs.OverrideOutput.IsValid()') &&
    smaaEntry.includes('AddDrawTexturePass(GraphBuilder, View, Inputs.SceneColor, Inputs.OverrideOutput,') &&
    smaaEntry.includes('return Inputs.OverrideOutput;') && smaaEntry.includes('return Inputs.SceneColor;'));
  const postProcessing = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessing.cpp'), 'utf8');
  assert.equal((postProcessing.match(/PassSequence\.SetEnabled\(EPass::SMAA, (?:View\.)?AntiAliasingMethod == AAM_SMAA && UE::WebGPU::SupportsSMAA\(View.GetShaderPlatform\(\)\)\);/g) || []).length, 2);
  const sceneRendering = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp'), 'utf8');
  assert(/AntiAliasingMethod == AAM_SMAA\s*&& UE::WebGPU::SupportsSMAA\(ViewInfo->GetShaderPlatform\(\)\)/.test(sceneRendering));
  report.smaaPreparationAndPassPolicyCompileVerified = true;
  report.smaaCompileAttempt = audit(smaaLinkFile);
  report.mobileExposureCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.22.cpp'].map(name => {
    const historical = mobileLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const mobile = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMobile.cpp'), 'utf8');
  assert.equal((mobile.match(/return IsMobilePlatform\(Parameters.Platform\) && UE::WebGPU::SupportsMobileEyeAdaptation\(Parameters.Platform\);/g) || []).length, 4);
  assert(/bool IsMobileEyeAdaptationEnabled\([^]*?return UE::WebGPU::SupportsMobileEyeAdaptation\(View.GetShaderPlatform\(\)\)/.test(mobile));
  const setupEntry = mobile.slice(mobile.indexOf('FMobileEyeAdaptationSetupOutputs AddMobileEyeAdaptationSetupPass('));
  assert(/^\s*if \(!UE::WebGPU::SupportsMobileEyeAdaptation\(View.GetShaderPlatform\(\)\)\)\s*\{\s*return \{\};\s*\}/
    .test(setupEntry.slice(setupEntry.indexOf('\n{') + 2)));
  const exposureEntry = mobile.slice(mobile.indexOf('void AddMobileEyeAdaptationPass('));
  assert(/^\s*if \(!UE::WebGPU::SupportsMobileEyeAdaptation\(View.GetShaderPlatform\(\)\)\)\s*\{\s*return;\s*\}/
    .test(exposureEntry.slice(exposureEntry.indexOf('\n{') + 2)));
  assert(postProcessing.includes('const bool bUseEyeAdaptation = IsMobileEyeAdaptationEnabled(View);') &&
    postProcessing.includes('TonemapperInputs.EyeAdaptationBuffer = PassSequence.IsEnabled(EPass::EyeAdaptation) ? LastEyeAdaptationBuffer : nullptr;'));
  const tonemapSource = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessTonemap.cpp'), 'utf8');
  assert(tonemapSource.includes('if (!bEyeAdaptation)') &&
    tonemapSource.includes('const float DefaultEyeAdaptation = GetEyeAdaptationFixedExposure(View);') &&
    tonemapSource.includes('TEXT("DefaultEyeAdaptationBuffer")'));
  report.mobileExposureConsumerSources = [];
  for (const name of ['PostProcessEyeAdaptation.cpp', 'PostProcessMobile.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/PostProcess', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/PostProcess', name);
    assert.equal(sha(stock), sha(copied));
    if (name === 'PostProcessEyeAdaptation.cpp') {
      const source = fs.readFileSync(copied, 'utf8');
      assert(source.includes('const bool bEnableAutoExposure = !bMobilePlatform || IsMobileEyeAdaptationEnabled(*this);') &&
        source.includes('PreExposure = FixedExposure;'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.mobileExposureConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.mobileExposurePreparationAndPassPolicyCompileVerified = true;
  report.mobileExposureCompileAttempt = audit(mobileLinkFile);
  report.skyAtmosphereCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.33.cpp'].map(name => {
    const historical = skyLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  report.skyAtmosphereCompileAttempt = audit(skyLinkFile);
  const sky = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/SkyAtmosphereRendering.cpp'), 'utf8');
  const skySection = signature => {
    const begin = sky.indexOf(signature);
    assert(begin >= 0, signature);
    const end = sky.indexOf('\n}', begin);
    assert(end > begin, signature);
    return sky.slice(begin, end + 2);
  };
  for (const type of skyTypes) {
    const declaration = skySection(`class ${type.name} : public FGlobalShader`);
    assert(declaration.includes('ShouldCompilePermutation(') &&
      declaration.includes('UE::WebGPU::SupportsSkyAtmosphere(Parameters.Platform)'));
  }
  assert(skySection('bool ShouldRenderSkyAtmosphere(')
    .includes('return UE::WebGPU::SupportsSkyAtmosphere(ShaderPlatform)'));
  const samplingBuffer = skySection('class FUniformSphereSamplesBuffer : public FRenderResource');
  assert(samplingBuffer.includes('!UE::WebGPU::SupportsSkyAtmosphere(GMaxRHIShaderPlatform)') &&
    samplingBuffer.indexOf('!UE::WebGPU::SupportsSkyAtmosphere(') <
      samplingBuffer.indexOf('UniformSphereSamplesBuffer.InitializeWithData('));
  for (const name of ['InitSkyAtmosphereForScene', 'InitSkyAtmosphereForView']) {
    assert(skySection(`void ${name}(`)
      .includes('if (Scene && UE::WebGPU::SupportsSkyAtmosphere(Scene->GetShaderPlatform()))'));
  }
  for (const name of ['RenderSkyAtmosphereLookUpTables', 'RenderSkyAtmosphereInternal', 'RenderSkyAtmosphere']) {
    const entry = skySection(`void FSceneRenderer::${name}(`);
    const opening = entry.slice(entry.indexOf('\n{') + 2);
    assert(/^\s*(?:PendingRDGResources.SceneRenderer = this;\s*)?if \(!UE::WebGPU::SupportsSkyAtmosphere\(Scene->GetShaderPlatform\(\)\)\)\s*\{\s*return;\s*\}/.test(opening));
  }
  const lutEntry = skySection('void FSceneRenderer::RenderSkyAtmosphereLookUpTables(');
  assert(lutEntry.indexOf('PendingRDGResources.SceneRenderer = this;') <
    lutEntry.indexOf('!UE::WebGPU::SupportsSkyAtmosphere('));
  const commit = skySection('void FSkyAtmospherePendingRDGResources::CommitToSceneAndViewUniformBuffers(');
  assert(commit.indexOf('!UE::WebGPU::SupportsSkyAtmosphere(') <
    commit.indexOf('FSkyAtmosphereRenderSceneInfo& SkyInfo'));
  assert(skySection('bool FSceneRenderer::ShouldRenderSkyAtmosphereEditorNotifications(')
    .includes('UE::WebGPU::SupportsSkyAtmosphere(View.GetShaderPlatform())'));
  assert(skySection('void FSceneRenderer::RenderSkyAtmosphereEditorNotifications(')
    .includes('if (View.bSceneHasSkyMaterial && UE::WebGPU::SupportsSkyAtmosphere(View.GetShaderPlatform()))'));
  const debugEntry = skySection('FScreenPassTexture AddSkyAtmosphereDebugPasses(');
  assert(debugEntry.indexOf('return ScreenPassSceneColor;') < debugEntry.indexOf('#if WITH_EDITOR'));
  assert(sceneRendering.includes('ViewUniformShaderParameters.SkyAtmospherePresentInScene = 0.0f;') &&
    sceneRendering.includes('ViewUniformShaderParameters.SkyAtmosphereApplyCameraAerialPerspectiveVolume = 0.0f;') &&
    sceneRendering.includes('ViewUniformShaderParameters.DistantSkyLightLutBufferSRV = GBlackFloat4StructuredBufferWithSRV->ShaderResourceViewRHI.GetReference();') &&
    sceneRendering.includes('ViewUniformShaderParameters.MobileDistantSkyLightLutBufferSRV = GBlackFloat4VertexBufferWithSRV->ShaderResourceViewRHI.GetReference();'));
  report.skyAtmosphereConsumerSources = [];
  for (const name of ['MobileShadingRenderer.cpp', 'DeferredShadingRenderer.cpp', 'SceneVisibility.cpp',
    'ReflectionEnvironmentRealTimeCapture.cpp', 'SkyAtmosphereRendering.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private', name);
    if (name !== 'SceneVisibility.cpp') assert.equal(sha(stock), sha(copied));
    else assert.equal(sha(copied), sha(path.join(root,
      'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp')));
    const source = fs.readFileSync(copied, 'utf8');
    if (name === 'ReflectionEnvironmentRealTimeCapture.cpp') {
      assert(source.includes('bool bShouldRenderSkyAtmosphere') &&
        source.includes('SceneRenderer.RenderSkyAtmosphereInternal('));
    } else if (name === 'SkyAtmosphereRendering.h') {
      assert(source.includes('FSceneRenderer* SceneRenderer = nullptr;'));
    } else {
      assert(source.includes('ShouldRenderSkyAtmosphere(Scene, ViewFamily.EngineShowFlags)'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.skyAtmosphereConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.skyAtmospherePreparationAndPassPolicyCompileVerified = true;
  report.renderDebugCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.21.cpp',
    'Module.Renderer.23.cpp', 'Module.Renderer.36.cpp'].map(name => {
    const historical = renderDebugLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      compositeLink.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  report.renderDebugCompileAttempt = audit(renderDebugLinkFile);
  const lightShape = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/VisualizeLightShape.cpp'), 'utf8');
  assert.equal((lightShape.match(/return UE::WebGPU::SupportsLightShapeVisualization\(Parameters.Platform\);/g) || []).length, 2);
  assert(lightShape.includes('if (!UE::WebGPU::SupportsLightShapeVisualization(View.GetShaderPlatform()) || !View.ViewState)'));
  assert.equal((lightShape.match(/if \(!UE::WebGPU::SupportsLightShapeVisualization\(GMaxRHIShaderPlatform\)\)/g) || []).length, 2);
  for (const signature of ['static void RenderLightShapeVisualizationView(',
    'void FDeferredShadingSceneRenderer::RenderLightShapeVisualization(']) {
    const entry = lightShape.slice(lightShape.indexOf(signature));
    assert(entry.startsWith(signature));
    assert(/^\s*if \(!UE::WebGPU::SupportsLightShapeVisualization\((?:View.GetShaderPlatform\(\)|Scene->GetShaderPlatform\(\))\)\)\s*\{\s*return;\s*\}/
      .test(entry.slice(entry.indexOf('\n{') + 2)));
  }
  const lightGrid = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/LightGridInjection.cpp'), 'utf8');
  assert(lightGrid.includes('const bool bVisualizeLightShape = VisualizeLightShape::UpdateLastToggleTime(View);') &&
    lightGrid.includes('if (bVisualizeLightShape && VisualizeLightShapeSortKeys.Num() > 0)'));
  assert.equal((postProcessing.match(/const bool bVisualizeHDR = UE::WebGPU::SupportsHDRVisualization\(View.GetShaderPlatform\(\)\)/g) || []).length, 2);
  const hdr = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessVisualizeHDR.cpp'), 'utf8');
  assert(hdr.includes('return UE::WebGPU::SupportsHDRVisualization(Parameters.Platform);') &&
    hdr.includes('return UE::WebGPU::SupportsHDRVisualization(View.GetShaderPlatform())'));
  const hdrEntry = hdr.slice(hdr.indexOf('FScreenPassTexture AddVisualizeHDRPass('));
  assert(hdrEntry.indexOf('!UE::WebGPU::SupportsHDRVisualization(') >= 0 &&
    hdrEntry.indexOf('!UE::WebGPU::SupportsHDRVisualization(') < hdrEntry.indexOf('check(Inputs.SceneColorBeforeTonemap.IsValid());'));
  assert(hdrEntry.includes('AddDrawTexturePass(GraphBuilder, View, Inputs.SceneColor, Inputs.OverrideOutput, View.GetMultiViewCount());') &&
    hdrEntry.includes('return Inputs.OverrideOutput;') && hdrEntry.includes('return Inputs.SceneColor;'));
  report.renderDebugConsumerSources = [];
  for (const name of ['VisualizeLightShape.h', 'PostProcess/PostProcessVisualizeHDR.h', 'DeferredShadingRenderer.cpp']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private', name);
    assert.equal(sha(stock), sha(copied));
    if (name === 'DeferredShadingRenderer.cpp') {
      assert(fs.readFileSync(copied, 'utf8').includes('RenderLightShapeVisualization(GraphBuilder, SceneTextures, TranslucencyResourceMap);'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.renderDebugConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.renderDebugPreparationAndPassPolicyCompileVerified = true;
  report.sparseVolumeCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Engine.51.cpp'].map(name => {
    const historical = sparseLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const renderUtils = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp'), 'utf8');
  assert(/bool DoesPlatformSupportSparseVolumeTextures\(EShaderPlatform Platform\)\s*\{\s*return UE::WebGPU::SupportsSparseVolumeTextures\(Platform\)\s*&& IsFeatureLevelSupported\(Platform, ERHIFeatureLevel::SM5\);/.test(renderUtils));
  assert(renderUtils.includes('const bool bIsSVTSupportedOnPlatform = DoesPlatformSupportSparseVolumeTextures(Platform);') &&
    renderUtils.includes('return bIsSVTEnabled && bIsSVTSupportedOnPlatform;'));
  const sparseUpload = fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Engine/Private/SparseVolumeTexture/SparseVolumeTextureUpload.cpp'), 'utf8');
  assert.equal((sparseUpload.match(/return UE::WebGPU::SupportsSparseVolumeTextures\(Parameters.Platform\);/g) || []).length, 2);
  for (const [signature, count, unlock, shader] of [
    ['void FTileUploader::ResourceUploadTo(', 'NumWrittenTiles', 'RHICmdList.UnlockBuffer(OccupancyBitsUploadBuffer->GetRHI());',
      'GetShader<FSparseVolumeTextureUpdateFromSparseBufferCS>'],
    ['void FPageTableUpdater::Apply(', 'NumWrittenUpdates', 'GraphBuilder.RHICmdList.UnlockBuffer(UpdatesUploadBuffer->GetRHI());',
      'GetShader<FSparseVolumeTextureUpdatePageTableCS>'],
  ]) {
    const begin = sparseUpload.indexOf(signature), end = sparseUpload.indexOf('\n}', begin);
    assert(begin >= 0 && end > begin);
    const entry = sparseUpload.slice(begin, end + 2);
    const guard = `if (${count} > 0 && UE::WebGPU::SupportsSparseVolumeTextures(GMaxRHIShaderPlatform))`;
    assert(entry.indexOf(unlock) >= 0 && entry.indexOf(unlock) < entry.indexOf(guard) &&
      entry.indexOf(guard) < entry.indexOf(shader) && entry.indexOf(shader) < entry.lastIndexOf('Release();'));
    assert(/\n\tRelease\(\);\s*\}$/.test(entry));
  }
  report.sparseVolumeConsumerSources = [];
  for (const name of ['SparseVolumeTextureStreamingManager.cpp', 'SparseVolumeTextureUpload.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Engine/Private/SparseVolumeTexture', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Engine/Private/SparseVolumeTexture', name);
    assert.equal(sha(stock), sha(copied));
    if (name === 'SparseVolumeTextureStreamingManager.cpp') {
      const source = fs.readFileSync(copied, 'utf8');
      assert.equal((source.match(/if \(!UseSparseVolumeTextures\(GMaxRHIShaderPlatform\)/g) || []).length, 9);
      for (const method of ['InitRHI', 'ReleaseRHI', 'Add_GameThread', 'Remove_GameThread',
        'Request_GameThread', 'Update_GameThread', 'Request', 'BeginAsyncUpdate', 'EndAsyncUpdate']) {
        const begin = source.indexOf(`void FStreamingManager::${method}(`);
        const end = source.indexOf('\n}', begin);
        assert(begin >= 0 && end > begin &&
          source.slice(begin, end).includes('if (!UseSparseVolumeTextures(GMaxRHIShaderPlatform)'));
      }
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.sparseVolumeConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.sparseVolumePreparationAndPassPolicyCompileVerified = true;
  report.gpuSortCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Engine.25.cpp'].map(name => {
    const historical = gpuSortLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const sortSource = relative => fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Engine/Private', relative), 'utf8');
  const radix = sortSource('GPUSort.cpp'), bitonic = sortSource('GPUBitonicSort.cpp');
  const sortManager = sortSource('GPUSortManager.cpp');
  const section = (source, signature) => {
    const begin = source.indexOf(signature), end = source.indexOf('\n}', begin);
    assert(begin >= 0 && end > begin);
    return source.slice(begin, end + 2);
  };
  assert.equal((radix.match(/return UE::WebGPU::SupportsGPUSorting\(Parameters.Platform\);/g) || []).length, 4);
  assert.equal((radix.match(/if \(!UE::WebGPU::SupportsGPUSorting\(GMaxRHIShaderPlatform\)\)/g) || []).length, 2);
  for (const resource of ['FSortOffsetBuffers', 'FRadixSortParametersBuffer']) {
    const source = radix.slice(radix.indexOf(`class ${resource} :`));
    assert(/void InitRHI\(FRHICommandListBase& RHICmdList\) override\s*\{\s*if \(!UE::WebGPU::SupportsGPUSorting\(GMaxRHIShaderPlatform\)\)\s*\{\s*return;\s*\}/.test(source));
  }
  assert.equal((bitonic.match(/if \(!UE::WebGPU::SupportsGPUSorting\(Parameters.Platform\)\)/g) || []).length, 2);
  assert(bitonic.includes('return UE::WebGPU::SupportsGPUSorting(Parameters.Platform);'));
  const addTask = section(sortManager, 'bool FGPUSortManager::AddTask(');
  assert(/if \(!FXConsoleVariables::bAllowGPUSorting \|\|\s*!UE::WebGPU::SupportsGPUSorting\(GShaderPlatformForFeatureLevel\[FeatureLevel\]\)\)\s*\{\s*return false;\s*\}/.test(addTask));
  assert(addTask.indexOf('!UE::WebGPU::SupportsGPUSorting(') < addTask.indexOf('LLM_SCOPE('));
  for (const [source, signature] of [[radix, 'int32 SortGPUBuffers('], [bitonic, 'int32 BitonicSortGPUBuffers(']]) {
    const entry = section(source, signature);
    assert(entry.indexOf('!UE::WebGPU::SupportsGPUSorting(') < entry.indexOf('GetGlobalShaderMap('));
    assert(/UE_LOG\(\w+, Fatal, TEXT\("GPU sorting is unavailable on this shader platform\."\)\);\s*return INDEX_NONE;/.test(entry));
  }
  const sortTest = section(radix, 'static bool RunGPUSortTest(');
  assert(/^\s*if \(!UE::WebGPU::SupportsGPUSorting\(GShaderPlatformForFeatureLevel\[FeatureLevel\]\)\)\s*\{\s*return false;\s*\}/.test(sortTest.slice(sortTest.indexOf('\n{') + 2)));
  for (const [signature, notification] of [
    ['void FGPUSortManager::OnPreRender(', 'PostPreRenderEvent.Broadcast(RHICmdList);'],
    ['void FGPUSortManager::OnPostRenderOpaque(', 'PostPostRenderEvent.Broadcast(RHICmdList);']]) {
    const entry = section(sortManager, signature);
    assert(entry.includes(notification) && !entry.includes('SupportsGPUSorting'));
  }
  report.gpuSortConsumerSources = [];
  for (const relative of ['Public/GPUSort.h', 'Public/GPUBitonicSort.h', 'Public/GPUSortManager.h',
    'Private/Particles/ParticleGpuSimulation.cpp']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Engine', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Engine', relative);
    if (relative.endsWith('ParticleGpuSimulation.cpp')) {
      assert.equal(sha(copied), sha(path.join(root, 'reference-engine/Engine/Source/Runtime/Engine', relative)));
    } else assert.equal(sha(stock), sha(copied));
    if (relative.endsWith('ParticleGpuSimulation.cpp')) {
      const source = fs.readFileSync(copied, 'utf8');
      const consumer = section(source, 'bool FFXSystem::AddSortedGPUSimulation(');
      assert(consumer.includes('GPUSortManager->AddTask(') &&
        /else\s*\{\s*return false;\s*\}\s*\}$/.test(consumer));
      assert(source.includes('FGPUSpriteMeshDataUserData* MeshBatchUserData = nullptr;') &&
        source.includes('if (FXSystem->AddSortedGPUSimulation(') &&
        source.includes('VertexFactory.SetUnsortedParticleIndicesSRV(Simulation->VertexBuffer.VertexBufferSRV);'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.gpuSortConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  const projectFile = path.join(root, 'tests/ue-web-smoke/UEWebSmoke.uproject');
  assert.equal(read(projectFile).DisableEnginePluginsByDefault, true);
  const linkResponse = fs.readFileSync(link.linkResponse.file, 'utf8');
  assert(!/\bNiagara\b/i.test(linkResponse));
  report.sourceFiles.push(audit(projectFile));
  report.gpuSortPreparationAndPassPolicyCompileVerified = true;
  report.compositeHMDCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.21.cpp',
    'Module.Renderer.28.cpp'].map(name => {
    const historical = compositeLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const postSource = relative => fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess', relative), 'utf8');
  const compositeCommon = postSource('PostProcessCompositePrimitivesCommon.cpp');
  const compositeHeader = postSource('PostProcessCompositePrimitivesCommon.h');
  const compositeDebug = postSource('PostProcessCompositeDebugPrimitives.cpp');
  const compositeEditor = postSource('PostProcessCompositeEditorPrimitives.cpp');
  const hmd = postSource('PostProcessHMD.cpp');
  assert(compositeCommon.includes('return UE::WebGPU::SupportsCompositePrimitives(Parameters.Platform) && SupportsGen4TAA(Parameters.Platform);') &&
    compositeCommon.includes('if (!UE::WebGPU::SupportsCompositePrimitives(Parameters.Platform))'));
  assert(compositeHeader.includes('return UE::WebGPU::SupportsCompositePrimitives(Platform) && IsPCPlatform(Platform);') &&
    compositeHeader.includes('return UE::WebGPU::SupportsCompositePrimitives(Platform);'));
  for (const [source, signature] of [
    [compositeDebug, 'bool IsDebugPrimitivePassEnabled('],
    [sceneRendering, 'bool FSceneRenderer::ShouldCompositeEditorPrimitives(']]) {
    const entry = section(source, signature);
    assert(/if \(!UE::WebGPU::SupportsCompositePrimitives\(View.GetShaderPlatform\(\)\)\)\s*\{\s*return false;\s*\}/.test(entry));
  }
  for (const [source, signature, next] of [
    [compositeDebug, 'FScreenPassTexture AddDebugPrimitivePass(', 'check(Inputs.SceneColor.IsValid());'],
    [compositeEditor, 'FScreenPassTexture AddEditorPrimitivePass(', 'InitializeEditorPrimitivesTextures('],
    [compositeCommon, 'void TemporalUpscaleDepthPass(', 'GraphBuilder.CreateTexture('],
    [compositeCommon, 'void PopulateDepthPass(', 'GraphBuilder.AllocParameters<']]) {
    const entry = section(source, signature), guard = entry.indexOf('!UE::WebGPU::SupportsCompositePrimitives(');
    assert(guard >= 0 && guard < entry.indexOf(next));
    assert(/UE_LOG\(LogRenderer, Fatal, TEXT\("Composite (?:debug primitives|editor primitives|primitive depth passes) are unavailable on this shader platform\."\)\);/.test(entry));
  }
  assert.equal((hmd.match(/return UE::WebGPU::SupportsHMDDistortion\(Parameters.Platform\);/g) || []).length, 2);
  assert(/void InitRHI\(FRHICommandListBase& RHICmdList\) override\s*\{\s*if \(!UE::WebGPU::SupportsHMDDistortion\(GMaxRHIShaderPlatform\)\)\s*\{\s*return;\s*\}/.test(hmd));
  const defaultHMD = section(hmd, 'FScreenPassTexture AddDefaultHMDDistortionPass(');
  assert(defaultHMD.indexOf('!UE::WebGPU::SupportsHMDDistortion(') < defaultHMD.indexOf('GEngine->XRSystem'));
  assert(defaultHMD.includes('AddDrawTexturePass(GraphBuilder, View, Inputs.SceneColor, Inputs.OverrideOutput, View.GetMultiViewCount());') &&
    defaultHMD.includes('return Inputs.OverrideOutput;') && defaultHMD.includes('return Inputs.SceneColor;'));
  const hmdEntry = section(hmd, 'FScreenPassTexture AddHMDDistortionPass(');
  assert(/^\s*if \(!UE::WebGPU::SupportsHMDDistortion\(View.GetShaderPlatform\(\)\)\)\s*\{\s*return AddDefaultHMDDistortionPass\(GraphBuilder, View, Inputs\);\s*\}/
    .test(hmdEntry.slice(hmdEntry.indexOf('\n{') + 2)));
  assert.equal((postProcessing.match(/PassSequence\.SetEnabled\(EPass::HMDDistortion, UE::WebGPU::SupportsHMDDistortion\(View.GetShaderPlatform\(\)\)/g) || []).length, 2);
  assert.equal((postProcessing.match(/PassSequence\.SetEnabled\(EPass::DebugPrimitive, IsDebugPrimitivePassEnabled\(View\)/g) || []).length, 3);
  assert.equal((postProcessing.match(/PassSequence\.SetEnabled\(EPass::EditorPrimitive, FSceneRenderer::ShouldCompositeEditorPrimitives\(View\)\);/g) || []).length, 2);
  report.compositeHMDConsumerSources = [];
  for (const relative of ['Private/PostProcess/PostProcessCompositeDebugPrimitives.h',
    'Private/PostProcess/PostProcessCompositeEditorPrimitives.h', 'Public/PostProcess/PostProcessHMD.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer', relative);
    assert.equal(sha(stock), sha(copied));
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.compositeHMDConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  const mobileConsumer = fs.readFileSync(path.join(root,
    '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp'), 'utf8');
  assert(mobileConsumer.includes('if ((!IsMobileHDR() || bTonemapSubpass) && IsDebugPrimitivePassEnabled(View))'));
  report.compositeHMDPreparationAndPassPolicyCompileVerified = true;
  report.landscapeIESCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.8.cpp',
    'Module.Landscape.1.cpp'].map(name => {
    const historical = landscapeLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const runtimeSource = relative => fs.readFileSync(path.join(root,
    'reference-engine/Engine/Source/Runtime', relative), 'utf8').replace(/\r\n/g, '\n');
  const landscape = runtimeSource('Landscape/Private/Landscape.cpp');
  const ies = runtimeSource('Renderer/Private/IESTextureManager.cpp');
  const policyHeader = runtimeSource('RenderCore/Public/WebShaderPlatform.h');
  const shaderPolicy = runtimeSource('RenderCore/Private/Shader.cpp');
  for (const capability of ['SupportsLandscapeTextureCapture', 'SupportsIESAtlasDebug']) {
    assert(section(policyHeader, `inline bool ${capability}(`).includes('return !IsShaderPlatform(Platform);'));
  }
  assert(policyHeader.includes('"/Engine/Private/Landscape/LandscapeMergeTexturesPS.usf"'));
  assert(!policyHeader.includes(iesSource), 'IES atlas updates share the debug source and entry point');
  const centralPredicate = section(shaderPolicy, 'static bool ShouldCompileWebShaderPermutation(');
  const iesGuard = centralPredicate.indexOf('FCString::Strcmp(Type.GetName(), TEXT("FIESAtlasDebugInfoCS")) == 0');
  assert(iesGuard >= 0 && iesGuard < centralPredicate.indexOf('#if WITH_EDITOR'));
  assert(centralPredicate.includes('FCString::Strcmp(Type.GetShaderFilename(), TEXT("/Engine/Private/IESAtlas.usf")) == 0') &&
    centralPredicate.includes('return UE::WebGPU::SupportsIESAtlasDebug(Parameters.Platform);'));
  assert.equal((shaderPolicy.match(/&& ShouldCompileWebShaderPermutation\(\*this, Parameters\)/g) || []).length, 2);
  assert.equal((landscape.match(/return UE::WebGPU::SupportsLandscapeTextureCapture\(InParameters.Platform\)/g) || []).length, 3);
  const landscapeEntry = section(landscape, 'bool ALandscape::RenderMergedTextureInternal(');
  assert(/^\s*if \(!UE::WebGPU::SupportsLandscapeTextureCapture\(GMaxRHIShaderPlatform\)\)\s*\{\s*UE_LOG\(LogLandscape, Warning,[^\n]+\s*return false;\s*\}/
    .test(landscapeEntry.slice(landscapeEntry.indexOf('\n{') + 2)));
  assert(landscapeEntry.indexOf('return false;') < landscapeEntry.indexOf('GetLandscapeInfo()') &&
    landscapeEntry.indexOf('return false;') < landscapeEntry.indexOf('ENQUEUE_RENDER_COMMAND'));
  for (const name of ['RenderHeightmap', 'RenderWeightmap', 'RenderWeightmaps']) {
    assert(section(landscape, `bool ALandscape::${name}(`).includes('return RenderMergedTextureInternal('));
  }
  const mergedRender = landscape.slice(landscape.indexOf('namespace UE::Landscape::Private::RenderMergedTexture_RenderThread'));
  const mergedEntry = section(mergedRender, '\tvoid RenderMergedTexture(');
  assert(mergedEntry.indexOf('!UE::WebGPU::SupportsLandscapeTextureCapture(') >= 0 &&
    mergedEntry.indexOf('!UE::WebGPU::SupportsLandscapeTextureCapture(') < mergedEntry.indexOf('GraphBuilder.CreateTexture('));
  assert.equal((landscape.match(/UE_LOG\(LogLandscape, Fatal, TEXT\("Landscape texture capture is unavailable on this shader platform\."\)\);/g) || []).length, 4);
  for (const name of ['MergeTexture', 'ResampleMergedTexture', 'PackRGBAChannels']) {
    const begin = landscape.indexOf(`\tstatic void ${name}(`);
    const end = landscape.indexOf('\n\t}', begin);
    assert(begin >= 0 && end > begin);
    const helper = landscape.slice(begin, end);
    assert(helper.indexOf('!UE::WebGPU::SupportsLandscapeTextureCapture(') >= 0 &&
      helper.indexOf('!UE::WebGPU::SupportsLandscapeTextureCapture(') < helper.indexOf('GetGlobalShaderMap('));
  }
  assert(ies.includes('return UE::WebGPU::SupportsIESAtlasDebug(Parameters.Platform) && ShaderPrint::IsSupported(Parameters.Platform);'));
  const iesPrivateEntry = section(ies, 'static FRDGTextureRef AddIESDebugPass(');
  assert(iesPrivateEntry.indexOf('return nullptr;') >= 0 &&
    iesPrivateEntry.indexOf('return nullptr;') < iesPrivateEntry.indexOf('ShaderPrint::SetEnabled(true);'));
  assert(/^\s*if \(!UE::WebGPU::SupportsIESAtlasDebug\(View.GetShaderPlatform\(\)\)\)\s*\{\s*return;\s*\}/
    .test(section(ies, 'void AddDebugPass(').split('\n{')[1]));
  const stockIES = fs.readFileSync('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/IESTextureManager.cpp', 'utf8').replace(/\r\n/g, '\n');
  for (const name of ['FIESAtlasAddTextureCS', 'FIESAtlasAddTexturePS']) {
    assert.equal(section(ies, `class ${name} :`), section(stockIES, `class ${name} :`));
  }
  assert.equal(section(ies, 'void UpdateAtlasTexture('), section(stockIES, 'void UpdateAtlasTexture('));
  assert(postProcessing.includes('IESAtlas::AddDebugPass('));
  const hostLandscape = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Landscape');
  assert.equal(fs.realpathSync(hostLandscape).toLowerCase(), path.resolve(hostLandscape).toLowerCase());
  assert(!fs.lstatSync(hostLandscape).isSymbolicLink());
  report.landscapeIESConsumerSources = [];
  for (const relative of ['Landscape/Classes/Landscape.h', 'Renderer/Private/IESTextureManager.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    assert.equal(sha(stock), sha(copied));
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.landscapeIESConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.landscapeIESPreparationAndPassPolicyCompileVerified = true;
  report.occlusionFeedbackCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.26.cpp',
    'Module.Renderer.27.cpp', 'Module.Renderer.29.cpp'].map(name => {
    const historical = occlusionLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const occlusion = runtimeSource('Renderer/Private/SceneOcclusion.cpp');
  const visibility = runtimeSource('Renderer/Private/SceneVisibility.cpp');
  const rendererScene = runtimeSource('Renderer/Private/RendererScene.cpp');
  const stockRendererSource = relative => fs.readFileSync(path.join(
    'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', relative), 'utf8').replace(/\r\n/g, '\n');
  assert(section(policyHeader, 'inline bool SupportsOcclusionFeedback(')
    .includes('return !IsShaderPlatform(Platform);'));
  assert(policyHeader.includes('"/Engine/Private/OcclusionFeedbackShaders.usf"'));
  assert.equal((occlusion.match(/return UE::WebGPU::SupportsOcclusionFeedback\(Parameters.Platform\) && IsMobilePlatform\(Parameters.Platform\);/g) || []).length, 2);
  for (const [signature, next, platform] of [
    ['void FOcclusionFeedback::InitRHI(', 'new FRHIGPUBufferReadback(', 'GMaxRHIShaderPlatform'],
    ['void FOcclusionFeedback::SubmitOcclusionDraws(', 'GetUnitCubeIndexBuffer()', 'View.GetShaderPlatform()']]) {
    const entry = section(occlusion, signature);
    assert(entry.indexOf(`!UE::WebGPU::SupportsOcclusionFeedback(${platform})`) >= 0 &&
      entry.indexOf(`!UE::WebGPU::SupportsOcclusionFeedback(${platform})`) < entry.indexOf(next));
    assert(entry.includes('UE_LOG(LogRenderer, Fatal, TEXT("Occlusion feedback is unavailable on this shader platform."));'));
  }
  const sceneConstructor = section(rendererScene, 'FSceneViewState::FSceneViewState(');
  assert(/if \(FeatureLevel == ERHIFeatureLevel::ES3_1\s*&& UE::WebGPU::SupportsOcclusionFeedback\(GShaderPlatformForFeatureLevel\[FeatureLevel\]\)\)/.test(sceneConstructor));
  assert(sceneConstructor.indexOf('SupportsOcclusionFeedback(') < sceneConstructor.indexOf('BeginInitResource(&OcclusionFeedback);'));
  assert.equal((rendererScene.match(/BeginInitResource\(&OcclusionFeedback\)/g) || []).length, 1);
  const unmap = section(visibility, 'void FGPUOcclusion::Unmap(');
  assert(/const bool bEnableOcclusionFeedback = GOcclusionFeedback_Enable != 0\s*&& UE::WebGPU::SupportsOcclusionFeedback\(View.GetShaderPlatform\(\)\);/.test(unmap));
  assert(/if \(!bEnableOcclusionFeedback && ViewState.OcclusionFeedback.IsInitialized\(\)\)\s*\{\s*ViewState.OcclusionFeedback.ReleaseResource\(\);\s*\}/.test(unmap));
  assert(/else if \(bEnableOcclusionFeedback && !ViewState.OcclusionFeedback.IsInitialized\(\)\)\s*\{\s*ViewState.OcclusionFeedback.InitResource\(RHICmdListImmediate\);\s*\}/.test(unmap));
  assert.equal((visibility.match(/OcclusionFeedback.InitResource\(/g) || []).length, 1);
  const stockOcclusion = stockRendererSource('SceneOcclusion.cpp');
  const stockVisibility = stockRendererSource('SceneVisibility.cpp');
  for (const method of ['ReleaseRHI', 'BeginOcclusionScope', 'EndOcclusionScope',
    'AdvanceFrame', 'ReadbackResults', 'AddPrimitive']) {
    assert.equal(section(occlusion, `void FOcclusionFeedback::${method}(`),
      section(stockOcclusion, `void FOcclusionFeedback::${method}(`));
  }
  assert.equal(section(visibility, 'void FGPUOcclusion::Map('),
    section(stockVisibility, 'void FGPUOcclusion::Map('));
  assert(visibility.includes('bUseOcclusionFeedback(View.FeatureLevel == ERHIFeatureLevel::ES3_1 && OcclusionFeedback.IsInitialized())') &&
    visibility.includes('else if (OcclusionState.bHZBOcclusion)') &&
    visibility.includes('// Read the occlusion query results.'));
  report.occlusionFeedbackConsumerSources = [];
  for (const name of ['SceneViewOcclusionHistory.h', 'SceneVisibilityPrivate.h',
    'MobileShadingRenderer.cpp', 'MobileBasePassRendering.cpp']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private', name);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private', name);
    assert.equal(sha(stock), sha(copied));
    const source = fs.readFileSync(copied, 'utf8');
    if (name === 'MobileShadingRenderer.cpp') {
      assert.equal((source.match(/View.ShouldRenderView\(\) && View.ViewState && View.ViewState->OcclusionFeedback.IsInitialized\(\)/g) || []).length, 2);
    } else if (name === 'MobileBasePassRendering.cpp') {
      assert(source.includes('View.ViewState ? View.ViewState->OcclusionFeedback.GetGPUFeedbackBuffer() : nullptr'));
    } else if (name === 'SceneViewOcclusionHistory.h') {
      assert(source.includes('FRDGBuffer* GPUFeedbackBuffer{};'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.occlusionFeedbackConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.occlusionFeedbackPreparationAndPassPolicyCompileVerified = true;
  report.vtPageTableCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.38.cpp'].map(name => {
    const historical = vtLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const vtSpace = runtimeSource('Renderer/Private/VT/VirtualTextureSpace.cpp');
  assert(section(policyHeader, 'inline bool SupportsVirtualTexturing(')
    .includes('return !IsShaderPlatform(Platform);'));
  assert(policyHeader.includes('"/Engine/Private/PageTableUpdate.usf"'));
  assert.equal((vtSpace.match(/return UE::WebGPU::SupportsVirtualTexturing\(Parameters.Platform\);/g) || []).length, 2);
  const shaderVTQuery = section(renderUtils, 'RENDERCORE_API bool UseVirtualTexturing(const FStaticShaderPlatform InShaderPlatform)');
  assert(shaderVTQuery.includes('return UE::WebGPU::SupportsVirtualTexturing(InShaderPlatform) && PerTargetCVar.Get(InShaderPlatform) != 0;'));
  const targetVTQuery = section(renderUtils, 'RENDERCORE_API bool UseVirtualTexturing(const ITargetPlatformSettings* InTargetPlatform)');
  assert(/if \(FName\(InTargetPlatform->IniPlatformName\(\)\) == FName\(TEXT\("Web"\)\)\)\s*\{\s*return false;\s*\}/.test(targetVTQuery));
  assert(targetVTQuery.indexOf('return false;') < targetVTQuery.indexOf('PerTargetCVar.Get('));
  assert.deepEqual(after.settings['r.VirtualTextures'], {host: '0', target: '0'});
  for (const [signature, next] of [
    ['void FVirtualTextureSpace::InitRHI(', 'RHICmdList.CreateTextureReference('],
    ['void FVirtualTextureSpace::AllocateTextures(', 'GraphBuilder.CreateTexture('],
    ['bool FVirtualTextureSpace::BeginUpdates(', 'static TArray<FPageTableUpdate>'],
    ['void FVirtualTextureSpace::ApplyUpdates(', 'GetGlobalShaderMap(']]) {
    const entry = section(vtSpace, signature);
    assert(entry.indexOf('!UE::WebGPU::SupportsVirtualTexturing(GMaxRHIShaderPlatform)') >= 0 &&
      entry.indexOf('!UE::WebGPU::SupportsVirtualTexturing(') < entry.indexOf(next));
    assert(entry.includes('UE_LOG(LogVirtualTextureSpace, Fatal, TEXT("Virtual texture page tables are unavailable on this shader platform."));'));
  }
  const stockVTSpace = stockRendererSource('VT/VirtualTextureSpace.cpp');
  for (const method of ['ReleaseRHI', 'EndUpdates']) {
    assert.equal(section(vtSpace, `void FVirtualTextureSpace::${method}(`),
      section(stockVTSpace, `void FVirtualTextureSpace::${method}(`));
  }
  const vtMobile = stockRendererSource('MobileShadingRenderer.cpp');
  const vtDeferred = stockRendererSource('DeferredShadingRenderer.cpp');
  assert(vtMobile.includes('bUseVirtualTexturing(UseVirtualTexturing(ShaderPlatform)') &&
    vtMobile.includes('if (bUseVirtualTexturing)') &&
    vtMobile.includes('FVirtualTextureSystem::Get().BeginUpdate('));
  assert(vtDeferred.includes('const bool bUseVirtualTexturing = UseVirtualTexturing(ShaderPlatform);') &&
    vtDeferred.includes('if (bUseVirtualTexturing && RendererOutput != ERendererOutput::DepthPrepassOnly)'));
  report.vtPageTableConsumerSources = [];
  for (const relative of ['Renderer/Private/VT/VirtualTextureSpace.h',
    'Renderer/Private/VT/VirtualTextureSystem.cpp', 'Renderer/Private/VT/RuntimeVirtualTextureSceneExtension.cpp',
    'RenderCore/Public/RenderUtils.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    assert.equal(sha(stock), sha(copied));
    const source = fs.readFileSync(copied, 'utf8');
    if (relative.endsWith('RuntimeVirtualTextureSceneExtension.cpp')) {
      assert(source.includes('return UseVirtualTexturing(InScene.GetShaderPlatform());'));
    } else if (relative.endsWith('VirtualTextureSystem.cpp')) {
      assert(source.includes('Space->InitResource(RHICmdList);') &&
        source.includes('Space.IsValid() && Space->BeginUpdates(this, GraphBuilder, Context)') &&
        source.includes('Context.Space->ApplyUpdates(GraphBuilder, Context);') &&
        source.includes('Context.Space->EndUpdates(GraphBuilder, Context, ExternalAccessQueue);'));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.vtPageTableConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.vtPageTablePreparationAndPassPolicyCompileVerified = true;
  report.gpuParticleCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Engine.36.cpp',
    'Module.Engine.37.cpp', 'Module.Engine.57.cpp'].map(name => {
    const historical = particleLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(historical?.exitCode === 0 && ['source', 'response', 'log'].every(key => valid(historical[key])));
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) || historical;
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const fxHeader = runtimeSource('Engine/Public/FXSystem.h');
  const particleSimulation = runtimeSource('Engine/Private/Particles/ParticleGpuSimulation.cpp');
  const particleCurves = runtimeSource('Engine/Private/Particles/ParticleCurveTexture.cpp');
  const vectorVisualization = runtimeSource('Engine/Private/VectorFieldVisualization.cpp');
  const stockEngineSource = relative => fs.readFileSync(path.join(
    'H:/UE_5.8/Engine/Source/Runtime/Engine', relative), 'utf8').replace(/\r\n/g, '\n');
  assert(section(policyHeader, 'inline bool SupportsGPUParticles(')
    .includes('return !IsShaderPlatform(Platform);'));
  for (const source of gpuParticleSources) assert(policyHeader.includes(`"${source}"`));
  assert(section(fxHeader, 'inline bool SupportsGPUParticles(')
    .includes('return UE::WebGPU::SupportsGPUParticles(Platform);'));
  const rhiParticleQuery = section(fxHeader, 'inline bool RHISupportsGPUParticles(');
  assert(rhiParticleQuery.includes('return SupportsGPUParticles(GMaxRHIShaderPlatform)') &&
    rhiParticleQuery.indexOf('SupportsGPUParticles(') < rhiParticleQuery.indexOf('FXConsoleVariables::bAllowGPUParticles'));
  const particlePSO = section(particleSimulation, 'void ParticleGPUSimulationGlobalPSOCollector(');
  assert(particlePSO.indexOf('!SupportsGPUParticles(ShaderPlatform)') >= 0 &&
    particlePSO.indexOf('return;') < particlePSO.indexOf('GetGlobalShaderMap('));
  for (const [signature, next, platform] of [
    ['void FFXSystem::SimulateGPUParticles(', 'ParticleSimulationResources->GetCurrentStateTextures()', 'GetShaderPlatform()'],
    ['FParticleEmitterInstance* FFXSystem::CreateGPUSpriteEmitterInstance(', 'new FGPUSpriteParticleEmitterInstance', 'GetShaderPlatform()'],
    ['void BeginUpdateGPUSpriteResources(', 'ClearGPUSpriteResourceData(', 'GMaxRHIShaderPlatform']]) {
    const entry = section(particleSimulation, signature);
    assert(entry.indexOf(`!SupportsGPUParticles(${platform})`) >= 0 &&
      entry.indexOf('!SupportsGPUParticles(') < entry.indexOf(next));
    assert(entry.includes('UE_LOG(LogParticles, Fatal, TEXT("GPU particles are unavailable on this shader platform."));'));
  }
  const stockParticleSimulation = stockEngineSource('Private/Particles/ParticleGpuSimulation.cpp');
  for (const method of ['InitGPUSimulation', 'InitGPUResources', 'DestroyGPUSimulation', 'ReleaseGPUResources']) {
    assert.equal(section(particleSimulation, `void FFXSystem::${method}(`),
      section(stockParticleSimulation, `void FFXSystem::${method}(`));
  }
  for (const method of ['BeginCreateGPUSpriteResources', 'BeginReleaseGPUSpriteResources']) {
    const signature = method === 'BeginCreateGPUSpriteResources' ?
      'FGPUSpriteResources* BeginCreateGPUSpriteResources(' : 'void BeginReleaseGPUSpriteResources(';
    assert.equal(section(particleSimulation, signature), section(stockParticleSimulation, signature));
  }
  const curveInit = section(particleCurves, 'void FParticleCurveTexture::InitRHI(');
  assert(curveInit.indexOf('!SupportsGPUParticles(GMaxRHIShaderPlatform)') >= 0 &&
    curveInit.indexOf('return;') < curveInit.indexOf('FRHITextureCreateDesc::Create2D('));
  const curveAdd = section(particleCurves, 'FTexelAllocation FParticleCurveTexture::AddCurve(');
  assert(curveAdd.indexOf('!SupportsGPUParticles(GMaxRHIShaderPlatform)') >= 0 &&
    curveAdd.indexOf('return FTexelAllocation();') < curveAdd.indexOf('TexelAllocator.Allocate('));
  const curveInjection = section(particleCurves, 'static void InjectCurves(');
  assert(curveInjection.indexOf('!SupportsGPUParticles(GMaxRHIShaderPlatform)') >= 0 &&
    curveInjection.indexOf('return;') < curveInjection.indexOf('RHICmdList.BeginRenderPass('));
  assert(curveInjection.includes('UE_LOG(LogParticles, Fatal, TEXT("GPU particle curves are unavailable on this shader platform."));'));
  for (const method of ['ReleaseRHI', 'RemoveCurve', 'SubmitPendingCurves']) {
    assert.equal(section(particleCurves, `void FParticleCurveTexture::${method}(`),
      section(stockEngineSource('Private/Particles/ParticleCurveTexture.cpp'), `void FParticleCurveTexture::${method}(`));
  }
  const vectorMesh = section(vectorVisualization, 'void GetVectorFieldMesh(');
  assert(vectorMesh.indexOf('!SupportsGPUParticles(GMaxRHIShaderPlatform)') >= 0 &&
    vectorMesh.indexOf('return;') < vectorMesh.indexOf('FVectorFieldResource* Resource'));
  assert.equal(section(vectorVisualization, 'void DrawVectorFieldBounds('),
    section(stockEngineSource('Private/VectorFieldVisualization.cpp'), 'void DrawVectorFieldBounds('));
  report.gpuParticleConsumerSources = [];
  for (const relative of ['Private/Particles/FXSystem.cpp', 'Private/Particles/ParticleModules.cpp',
    'Private/Particles/ParticleCurveTexture.h', 'Private/Particles/FXSystemPrivate.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime/Engine', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Engine', relative);
    assert.equal(sha(stock), sha(copied));
    const source = fs.readFileSync(copied, 'utf8').replace(/\r\n/g, '\n');
    if (relative.endsWith('FXSystem.cpp')) {
      for (const method of ['Tick', 'PreInitViews', 'PreRender', 'PostRenderOpaque']) {
        assert(section(source, `void FFXSystem::${method}(`).includes('RHISupportsGPUParticles()'));
      }
    } else if (relative.endsWith('ParticleModules.cpp')) {
      const create = section(source, 'FParticleEmitterInstance* UParticleModuleTypeDataGpu::CreateInstance(');
      assert(create.includes('InComponent.GetScene() && RHISupportsGPUParticles()') &&
        create.indexOf('RHISupportsGPUParticles()') < create.indexOf('CreateGPUSpriteEmitterInstance('));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.gpuParticleConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.gpuParticlePreparationAndPassPolicyCompileVerified = true;
  report.cubeShadowCopyCompileObjects = ['Module.RenderCore.3.cpp', 'Module.Renderer.30.cpp'].map(name => {
    const object = link.recompiledObjects.find(item => path.basename(item.source.file) === name) ||
      materialPreviousLink.recompiledObjects.find(item => path.basename(item.source.file) === name);
    assert(object?.exitCode === 0 && ['source', 'product', 'response', 'log'].every(key => valid(object[key])));
    assert(link.linkInputs.some(item => path.resolve(item.file) === path.resolve(object.product.file) &&
      item.sha256 === object.product.sha256));
    return object;
  });
  const shadowDepth = runtimeSource('Renderer/Private/ShadowDepthRendering.cpp');
  const stockShadowDepth = stockRendererSource('ShadowDepthRendering.cpp');
  const layeredVertex = section(shadowDepth, 'class TScreenVSForGS : public FScreenVS');
  assert(layeredVertex.indexOf('!UE::WebGPU::SupportsOnePassPointLightShadows(Parameters.Platform)') >= 0 &&
    layeredVertex.indexOf('return false;') < layeredVertex.indexOf('IsMobilePlatform(Parameters.Platform)'));
  assert(layeredVertex.includes('return bUsingVertexLayers;'));
  for (const name of ['FCopyShadowMapsCubeGS', 'FCopyShadowMapsCubePS']) {
    assert(section(shadowDepth, `class ${name} : public FGlobalShader`)
      .includes('UE::WebGPU::SupportsOnePassPointLightShadows(Parameters.Platform)'));
  }
  const entryPolicy = section(policyHeader, 'inline bool ShouldCompileShader(')
    .split('if (FCString::Strcmp(Filename, TEXT("/Engine/Private/ParticleSimulationShader.usf"))')[0];
  for (const text of ['if (EntryPoint', '"/Engine/Private/ScreenVertexShader.usf"',
    '"MainForGS"', '"/Engine/Private/CopyShadowMaps.usf"', '"CopyCubeDepthGS"', '"CopyCubeDepthPS"',
    'return SupportsOnePassPointLightShadows(Platform);']) assert(entryPolicy.includes(text), text);
  assert(!entryPolicy.includes('TEXT("Main")') && !entryPolicy.includes('TEXT("Copy2DDepthPS")') &&
    !entryPolicy.includes('TEXT("Scrolling2DDepthPS")'));
  const copyEntry = section(shadowDepth, 'void FProjectedShadowInfo::CopyCachedShadowMap(');
  const copyGuard = '\tif (bOnePassPointLightShadow && !UE::WebGPU::SupportsOnePassPointLightShadows(View.GetShaderPlatform()))\n' +
    '\t{\n\t\tUE_LOG(LogRenderer, Fatal, TEXT("Cube shadow cache copies are unavailable on this shader platform."));\n' +
    '\t\treturn;\n\t}\n\n';
  assert(copyEntry.includes(copyGuard) && copyEntry.indexOf(copyGuard) < copyEntry.indexOf('GetCachedShadowMapDataRef('));
  assert(copyEntry.indexOf(copyGuard) < copyEntry.indexOf('GraphBuilder.RegisterExternalTexture('));
  assert.equal(copyEntry.replace(copyGuard, ''), section(stockShadowDepth, 'void FProjectedShadowInfo::CopyCachedShadowMap('));
  for (const name of ['FCopyShadowMaps2DPS', 'FScrollingShadowMaps2DPS']) {
    assert.equal(section(shadowDepth, `class ${name} : public FGlobalShader`),
      section(stockShadowDepth, `class ${name} : public FGlobalShader`));
  }
  report.cubeShadowCopyConsumerSources = [];
  for (const relative of ['Engine/Public/ScreenRendering.h', 'Engine/Private/ScreenRendering.cpp',
    'Renderer/Private/ShadowRendering.h']) {
    const stock = path.join('H:/UE_5.8/Engine/Source/Runtime', relative);
    const copied = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    assert.equal(sha(stock), sha(copied));
    const source = fs.readFileSync(copied, 'utf8');
    if (relative.endsWith('ScreenRendering.cpp')) {
      assert(source.includes('IMPLEMENT_SHADER_TYPE(,FScreenVS,TEXT("/Engine/Private/ScreenVertexShader.usf"),TEXT("Main"),SF_Vertex);'));
    } else if (relative.endsWith('ShadowRendering.h')) {
      assert(source.includes('void CopyCachedShadowMap('));
    }
    for (const file of [stock, copied]) {
      assert(link.sourceFiles.some(item => path.resolve(item.file) === path.resolve(file) && valid(item)));
      report.cubeShadowCopyConsumerSources.push(audit(file));
      report.sourceFiles.push(audit(file));
    }
  }
  report.cubeShadowCopyPreparationAndPassPolicyCompileVerified = true;
  report.nativeModuleLoadVerified = true;
  report.webgpuShaderCookVerified = cook.pass;
  report.inputs = [baselineFile, cubeBaselineFile, finiteFile, particleBaselineFile, particleLinkFile, vtBaselineFile, vtLinkFile, occlusionBaselineFile, occlusionLinkFile, landscapeBaselineFile, landscapeLinkFile, compositeBaselineFile, compositeLinkFile, gpuSortBaselineFile, gpuSortLinkFile, sparseBaselineFile, sparseLinkFile, renderDebugBaselineFile, renderDebugLinkFile, skyBaselineFile, skyLinkFile, mobileBaselineFile, mobileLinkFile, smaaBaselineFile, smaaLinkFile, oitBaselineFile, pointBaselineFile, pointLinkFile, oitCompileFile, indirectBaselineFile, previousLinkFile, fogBaselineFile,
    msaaBaselineFile, hzbBaselineFile, capsuleBaselineFile,
    cookFile, buildFile, linkFile, materialPreviousLinkFile, priorLinkFile, msaaLinkFile, fogCompileFile,
    textureUpdateReportFile, bufferReportFile].map(audit);
  report.pass = true;
  report.boundary = 'Global eligibility changes only for the unused volumetric-fog depth generator: 839 to 838 permutations, with all 1510 registered types and 16 settings retained. Prior numerical fixes remain freshly compiled and GPU tested. Material vertex-factory exclusions have separate Cook and native callback evidence. Historical feature exclusions retain their artifacts. Current native and WASM build/link hashes are verified. Optional runtime pass selection remains unverified. Native Engine/Renderer remain installed binaries. ES31 is Cook-only; browser remains SM5; full normal UBT build is unverified.';
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(results, 'web-minimal-shader-policy-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, nativeCookPolicyVerified: report.nativeCookPolicyVerified,
    wasmPolicyCompileLinkVerified: report.wasmPolicyCompileLinkVerified,
    removedPermutations: report.removedPermutations, permutationsAfter: report.permutationsAfter,
    recordedDistinctFailedJobs: report.recordedDistinctFailedJobs, failure: report.failure}, null, 2));
}
