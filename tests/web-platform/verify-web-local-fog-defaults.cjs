const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, localFogDefaultsExcluded: false,
  completeUEScene: false, reports: [], sources: [audit(__filename)]};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-local-fog-defaults-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.minimalMapLoaded && run.frames === 0 &&
    run.startupBlocker.includes('ExternalPooledTexture.IsValid()') &&
    run.errors.some(error => error.includes('SetDummyLocalFogVolumeForView') &&
      error.includes('GetZeroUIntArrayDummy'))));
  report.beforeFixRecordsAreHistorical = true;
  const cook = load('web-engine-webgpu-es31-cook-results');
  assert(cook.pass && cook.sourceFiles.every(valid) && cook.products.every(valid) &&
    cook.hostProducts.every(valid) && valid(cook.shaderInventory.artifact));
  assert.deepEqual(cook.shaderInventory.detail.settings['r.SupportLocalFogVolumes'], {host: '0', target: '0'});
  const fogTypes = cook.shaderInventory.detail.types.filter(type => /LocalFogVolume/.test(type.name));
  assert(fogTypes.length === 6 && fogTypes.every(type => type.permutations === 0));
  report.excludedShaderTypes = fogTypes.map(type => type.name);
  const runtime = load('web-engine-webgpu-es31-results');
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(runtime.minimalMapLoadedVerified && runtime.sourceFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport) && gpu.length === 2);
  for (const run of gpu) {
    assert(!run.errors.some(error => error.includes('SetDummyLocalFogVolumeForView') &&
      error.includes('GetZeroUIntArrayDummy')), 'The actual Engine must pass the old local-fog default failure');
    assert(run.textureUploads.pass && run.engineQueueCompletion.pass &&
      run.gpuValidationErrors.length === 0 && run.minimalMapLoaded);
    assert(run.consoleLog.some(line => line.includes('Set CVar [[r.SupportLocalFogVolumes:0]]')));
  }
  const beforeBasePass = load('web-engine-webgpu-es31-results-before-basepass-array-defaults-20261020');
  assert(beforeBasePass.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.startupBlocker.startsWith('WebGPU texture creation unsupported: dimension=1') &&
    run.errors.some(error => error.includes('GetDBufferParameters') &&
      error.includes('SetupMobileBasePassUniformParameters'))));
  assert(gpu.every(run => !run.errors.some(error => error.includes('GetDBufferParameters') &&
    error.includes('SetupMobileBasePassUniformParameters'))),
  'The actual Engine must pass the unused BasePass DBuffer array defaults');
  assert(gpu.every(run => run.materialPolicy.dbuffer === false));
  const beforeReflection = load('web-engine-webgpu-es31-results-before-basepass-reflection-defaults-20261020');
  assert(beforeReflection.browserRuns.filter(run => run.rhi === 'webgpu').every(run =>
    run.minimalMapLoaded && run.errors.some(error => error.includes('GetCubeBlackDummy') &&
      error.includes('SetupReflectionUniformParameters') && error.includes('SetupMobileBasePassUniformParameters'))));
  assert(gpu.every(run => !run.errors.some(error => error.includes('GetCubeBlackDummy') &&
    error.includes('SetupReflectionUniformParameters') && error.includes('SetupMobileBasePassUniformParameters'))),
  'The actual Engine must pass the unused BasePass reflection cube default');
  const source = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/LocalFogVolumeRendering.cpp');
  const overlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/LocalFogVolumeRendering.cpp');
  const prior = load('web-engine-webgpu-link-results-before-local-fog-defaults-20261020');
  const priorSource = prior.sourceFiles.find(item => item.file === source);
  const text = fs.readFileSync(source, 'utf8');
  const branches = /^#if PLATFORM_WEB\r?\n([\s\S]*?)^#else\r?\n([\s\S]*?)^#endif\r?\n/gm;
  const matches = [...text.matchAll(branches)];
  assert.equal(matches.length, 2);
  assert(matches[0][1].includes('UniformParametersStruct = FLocalFogVolumeUniformParameters();') &&
    matches[1][1].includes('View.LocalFogVolumeViewData = FLocalFogVolumeViewData{};') &&
    matches[1][1].includes('DepthBoundStartDistance = FLT_MAX;'));
  assert(matches.every(match => !/Create(?:Texture|Buffer|SRV|UAV|VertexBuffer)|GetZeroUIntArrayDummy/.test(match[1]) &&
    match[2].includes('GetZeroUIntArrayDummy')));
  assert(priorSource);
  assert.equal(crypto.createHash('sha256').update(text.replace(branches, '$2')).digest('hex'),
    priorSource.sha256, 'Removing only the two Web branches must restore the exact previous source');
  assert.equal(sha(source), sha(overlay));
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && build.sourceFiles.every(valid) && build.linkInputs.every(valid) &&
    build.products.every(valid) && valid(build.log));
  const compilation = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.10.cpp');
  assert(compilation && compilation.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(compilation[key])) &&
    fs.readFileSync(compilation.source.file, 'utf8').includes('LocalFogVolumeRendering.cpp') &&
    build.linkInputs.some(item => item.file === compilation.product.file &&
      item.sha256 === compilation.product.sha256));
  const basePass = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/MobileBasePassRendering.cpp');
  const basePassOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/MobileBasePassRendering.cpp');
  const basePassInstalled = 'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/MobileBasePassRendering.cpp';
  const basePassText = fs.readFileSync(basePass, 'utf8').replaceAll('\r', '');
  const basePassBranches = [...basePassText.matchAll(branches)];
  assert.equal(basePassBranches.length, 4);
  assert(basePassBranches[0][1].includes('check(!IsUsingDBuffers(View.GetShaderPlatform()));') &&
    basePassBranches[0][1].includes('BasePassParameters.DBuffer = FDBufferParameters();') &&
    basePassBranches[1][1].includes('BasePassParameters.ScreenSpaceShadowMaskTextureArray = nullptr;') &&
    basePassBranches[2][1].includes('BasePassParameters.ReflectionsParameters = FReflectionUniformParameters();') &&
    basePassBranches[3][1].includes('BasePassParameters.QuadOverdraw = nullptr;') &&
    basePassBranches[3][1].includes('BasePassParameters.RWOcclusionBufferUAV = nullptr;'));
  assert.equal(basePassText.replace(branches, '$2'),
    fs.readFileSync(basePassInstalled, 'utf8').replaceAll('\r', ''));
  assert.equal(basePassText, fs.readFileSync(basePassOverlay, 'utf8').replaceAll('\r', ''));
  const ddpi = path.join(root, 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini');
  const ddpiText = fs.readFileSync(ddpi, 'utf8');
  assert.equal((ddpiText.match(/^bSupportsMobileMultiView=false\r?$/gm) || []).length, 2);
  const shadowSource = 'H:/UE_5.8/Engine/Shaders/Private/MobileLightingCommon.ush';
  assert(/#if MOBILE_MULTI_VIEW\s*\n\s*return Texture2DArraySample\(MobileBasePass.ScreenSpaceShadowMaskTextureArray/
    .test(fs.readFileSync(shadowSource, 'utf8')));
  const baseCompile = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.16.cpp');
  assert(baseCompile && baseCompile.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(baseCompile[key])) &&
    fs.readFileSync(baseCompile.source.file, 'utf8').includes('MobileBasePassRendering.cpp') &&
    build.linkInputs.some(item => item.file === baseCompile.product.file &&
      item.sha256 === baseCompile.product.sha256));
  report.sources.push(...[basePass, basePassOverlay, basePassInstalled, ddpi, shadowSource].map(audit));
  const engine = path.join(root, '.tools/ue58-web-build-host/Engine');
  const consumers = ['Source/Runtime/Renderer/Private/LocalFogVolumeRendering.h',
    'Source/Runtime/Renderer/Private/MobileBasePassRendering.cpp',
    'Source/Runtime/Renderer/Private/MobileFogRendering.cpp',
    'Source/Runtime/Renderer/Private/MobileShadingRenderer.cpp'];
  const header = fs.readFileSync(path.join(engine, consumers[0]), 'utf8');
  assert(header.includes('uint32 GPUInstanceCount = 0;') &&
    header.includes('bUseHalfResLocalFogVolume = false;'));
  assert.equal((text.match(/!UE::WebGPU::SupportsLocalFogVolumes\(View.GetShaderPlatform\(\)\)/g) || []).length, 4);
  const platform = path.join(root, 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h');
  const capability = fs.readFileSync(platform, 'utf8');
  assert(capability.includes('inline bool SupportsLocalFogVolumes(EShaderPlatform Platform)\n{\n\treturn !IsShaderPlatform(Platform);'));
  report.sources.push(...[source, overlay, platform, ...consumers.map(file => path.join(engine, file))].map(audit));
  report.localFogDefaultsExcluded = true;
  report.basePassArrayDefaultsExcluded = true;
  report.basePassOptionalDefaultsExcluded = true;
  report.renderCurveDefaultBlocked = gpu.every(run =>
    run.startupBlocker?.startsWith('WebGPU BufferSRV unsupported:') &&
    run.errors.some(error => error.includes('GetDefaultRenderCurveSceneParameters') &&
      error.includes('GetDefaultByteAddressBuffer') && error.includes('FExtensibleUniformBufferBase')));
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.browserRuns = gpu.map(run => ({browser: run.browser, frames: run.frames,
    depthTextures: run.canvas.depthTextures.length, depthPasses: run.canvas.depthPasses.length,
    startupBlocker: run.startupBlocker}));
  report.pass = true;
  report.boundary = 'Both Web dummy-parameter entry points initialize zero instances and null resources without '
    + 'allocating local-fog arrays or buffers. Existing platform guards reject local-fog shader permutations and '
    + 'draws; the per-view half-resolution path remains disabled. Removing the two branches restores the exact '
    + 'prior source, preserving desktop behavior and earlier policy changes. The actual changed unity is compiled '
    + 'and linked, and both real browser engines pass the prior default-array registration failure. This does not '
    + 'allocate DBuffer resources when the actual material policy disables DBuffer; a check retains that boundary. '
    + 'The unused shadow-array default is null while the ordinary 2D shadow texture remains. Both Web shader platforms '
    + 'disable mobile multiview, and only that shader branch samples the array. The original BasePass body is preserved '
    + 'outside the four Web branches and its actual unity is linked. Unused reflection parameters are zero and '
    + 'debug-overdraw/occlusion-feedback default UAVs are null. This does not '
    + 'implement local fog, arrays or indirect drawing. Later failures and completed ticks remain runtime evidence; '
    + 'no rendered mesh, HTML UI or fresh full normal Web UBT build is implied.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-local-fog-defaults-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, localFogDefaultsExcluded: report.localFogDefaultsExcluded,
    basePassArrayDefaultsExcluded: report.basePassArrayDefaultsExcluded,
    basePassOptionalDefaultsExcluded: report.basePassOptionalDefaultsExcluded,
    renderCurveDefaultBlocked: report.renderCurveDefaultBlocked,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
