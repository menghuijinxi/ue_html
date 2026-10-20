const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, renderCurveDefaultsExcluded: false,
  completeUEScene: false, reports: [], sources: [audit(__filename)]};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-render-curve-defaults-20261020');
  const blocked = run => run.errors.some(error => error.includes('GetDefaultRenderCurveSceneParameters') &&
    error.includes('GetDefaultByteAddressBuffer') && error.includes('FExtensibleUniformBufferBase'));
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.minimalMapLoaded && run.frames === 0 &&
    run.startupBlocker.startsWith('WebGPU BufferSRV unsupported:') && blocked(run)));
  report.beforeFixRecordsAreHistorical = true;
  const relative = 'Source/Runtime/Renderer/Private/HairStrands/RenderCurveSceneExtension.cpp';
  const source = path.join(root, 'reference-engine/Engine', relative);
  const overlay = path.join(root, '.tools/ue58-web-build-host/Engine', relative);
  const installed = path.join('H:/UE_5.8/Engine', relative);
  const text = fs.readFileSync(source, 'utf8').replaceAll('\r', '');
  const branches = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/gm;
  const matches = [...text.matchAll(branches)];
  assert.equal(matches.length, 2, 'Web must disable the extension and its unused default resource creation');
  assert(matches[0][1].trim() === 'return false;' &&
    matches[0][2].includes('IsRenderCurveEnabled()') && matches[0][2].includes('IsHairStrandsEnabled('));
  assert(matches[1][1].trim() === 'OutParameters = FRenderCurveSceneParameters();' &&
    matches[1][2].includes('GetRenderCurveSceneParameters(GraphBuilder, nullptr, OutParameters);'));
  assert.equal(text.replace(branches, '$2'),
    fs.readFileSync(installed, 'utf8').replaceAll('\r', '').replace(/\n?$/, '\n'));
  assert.equal(text, fs.readFileSync(overlay, 'utf8').replaceAll('\r', ''));
  assert(text.includes('IMPLEMENT_SCENE_EXTENSION(FRenderCurveSceneExtension);') &&
    text.includes('IMPLEMENT_SCENE_UB_STRUCT(FRenderCurveSceneParameters, RenderCurve, GetDefaultRenderCurveSceneParameters);') &&
    text.includes('return InternalIsEnabled(InScene);') &&
    text.includes('SetEnabled(InternalIsEnabled(InScene));'));
  const raster = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/HairStrands/RenderCurveRaster.cpp');
  assert(/TEXT\("r.RenderCurve"\),\s*0,/.test(fs.readFileSync(raster, 'utf8')));
  report.sources.push(...[source, overlay, installed, raster].map(audit));
  const beforeNanite = load('web-engine-webgpu-es31-results-before-nanite-defaults-20261020');
  const naniteBlocked = run => run.errors.some(error => error.includes('Nanite::GetDefaultMaterialsParameters') &&
    error.includes('GetDefaultByteAddressBuffer') && error.includes('FExtensibleUniformBufferBase'));
  const oldNaniteGPU = beforeNanite.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldNaniteGPU.length === 2 && oldNaniteGPU.every(run =>
    run.minimalMapLoaded && run.frames === 0 && naniteBlocked(run) && !blocked(run)));
  const naniteFiles = ['NaniteMaterialsSceneExtension.cpp', 'NaniteOwnershipVisibilitySceneExtension.cpp'];
  const naniteStructs = ['FNaniteMaterialsParameters', 'FNaniteOwnershipVisibilityParameters'];
  const naniteSources = naniteFiles.map(file =>
    path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/Nanite', file));
  for (const [index, naniteSource] of naniteSources.entries()) {
    const naniteOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/Nanite', naniteFiles[index]);
    const naniteInstalled = path.join('H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/Nanite', naniteFiles[index]);
    const naniteText = fs.readFileSync(naniteSource, 'utf8').replaceAll('\r', '');
    const naniteBranches = [...naniteText.matchAll(branches)];
    assert(naniteBranches.length === 1 &&
      naniteBranches[0][1].trim() === `OutParameters = ${naniteStructs[index]}();`);
    assert.equal(naniteText.replace(branches, '$2'),
      fs.readFileSync(naniteInstalled, 'utf8').replaceAll('\r', '').replace(/\n?$/, '\n'));
    assert.equal(naniteText, fs.readFileSync(naniteOverlay, 'utf8').replaceAll('\r', ''));
    assert(naniteText.includes('return DoesRuntimeSupportNanite(') &&
      naniteText.includes(`IMPLEMENT_SCENE_UB_STRUCT(${naniteStructs[index]},`));
    report.sources.push(...[naniteSource, naniteOverlay, naniteInstalled].map(audit));
  }
  const ddpi = path.join(root, 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini');
  assert.equal((fs.readFileSync(ddpi, 'utf8').match(/^bSupportsNanite=false\r?$/gm) || []).length, 2);
  const renderUtils = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/RenderCore/Private/RenderUtils.cpp');
  const utilsText = fs.readFileSync(renderUtils, 'utf8');
  assert(utilsText.includes('GetSupportsNanite(Platform)') &&
    utilsText.includes('bValidPlatform && bSupportGPUScene && bSupportNanite') &&
    utilsText.includes('const bool bSupportedPlatform = DoesPlatformSupportNanite(ShaderPlatform, bCheckForProjectSetting);'));
  report.sources.push(...[ddpi, renderUtils].map(audit));
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && build.sourceFiles.every(valid) && build.linkInputs.every(valid) &&
    build.products.every(valid) && valid(build.log));
  assert([source, overlay].every(file => build.sourceFiles.some(item => item.file === file && valid(item))));
  const compilation = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.7.cpp');
  assert(compilation && compilation.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(compilation[key])) &&
    fs.readFileSync(compilation.source.file, 'utf8').includes('HairStrands/RenderCurveSceneExtension.cpp') &&
    build.linkInputs.some(item => item.file === compilation.product.file && item.sha256 === compilation.product.sha256));
  const naniteCompile = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Renderer.18.cpp');
  assert(naniteCompile && naniteCompile.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(naniteCompile[key])) &&
    naniteFiles.every(file => fs.readFileSync(naniteCompile.source.file, 'utf8').includes(`Nanite/${file}`)) &&
    build.linkInputs.some(item => item.file === naniteCompile.product.file && item.sha256 === naniteCompile.product.sha256));
  assert(naniteSources.every(file => build.sourceFiles.some(item => item.file === file && valid(item))));
  const materialCompile = build.recompiledObjects.find(item => path.basename(item.source.file) === 'Module.Engine.32.cpp');
  assert(materialCompile && materialCompile.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(materialCompile[key])) &&
    fs.readFileSync(materialCompile.source.file, 'utf8').includes('Materials/MaterialShared.cpp') &&
    build.linkInputs.some(item => item.file === materialCompile.product.file && item.sha256 === materialCompile.product.sha256));
  const runtime = load('web-engine-webgpu-es31-results');
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(runtime.minimalMapLoadedVerified && runtime.sourceFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport) && gpu.length === 2);
  for (const run of gpu) {
    assert(!blocked(run), 'The actual browser Engine must pass the old RenderCurve default Raw Buffer failure');
    assert(!naniteBlocked(run) && !run.errors.some(error => error.includes('GetDefaultOwnershipVisibilityParameters')),
      'The actual browser Engine must pass the disabled Nanite default callbacks');
    assert(run.minimalMapLoaded && run.textureUploads.pass && run.engineQueueCompletion.pass &&
      run.gpuValidationErrors.length === 0);
  }
  report.renderCurveDefaultsExcluded = true;
  report.naniteDefaultsExcluded = true;
  report.renderCurveDefaultBlocked = gpu.some(blocked);
  report.skinningDefaultBlocked = gpu.every(run => run.frames === 0 &&
    run.startupBlocker?.startsWith('WebGPU BufferSRV unsupported:') &&
    run.errors.some(error => error.includes('GetDefaultSkinningParameters') &&
      error.includes('GetDefaultByteAddressBuffer') && error.includes('FExtensibleUniformBufferBase')));
  report.engineInitReturnedVerified = runtime.engineInitReturnedVerified;
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.browserRuns = gpu.map(run => ({browser: run.browser, frames: run.frames,
    depthTextures: run.canvas.depthTextures.length, depthPasses: run.canvas.depthPasses.length,
    startupBlocker: run.startupBlocker}));
  report.pass = true;
  report.boundary = 'Web retains the extension and scene-uniform registrations but disables curve-extension '
    + 'creation and zeroes its default parameters without creating Raw Buffer SRVs. Removing the two Web '
    + 'branches restores the complete installed source. The changed real unity is recompiled and linked, '
    + 'and both browser engines pass the recorded old failure. Nanite material and ownership defaults are '
    + 'zeroed while both Web shader-platform capabilities reject Nanite and existing extension creation '
    + 'checks remain. Their real unity is linked and the recorded material Raw Buffer failure is passed. '
    + 'No curve/hair/Nanite/Raw or Structured Buffer feature, rendered '
    + 'mesh, first frame or fresh full normal Web UBT build is implied.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-render-curve-defaults-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, renderCurveDefaultsExcluded: report.renderCurveDefaultsExcluded,
    naniteDefaultsExcluded: report.naniteDefaultsExcluded,
    skinningDefaultBlocked: report.skinningDefaultBlocked,
    renderCurveDefaultBlocked: report.renderCurveDefaultBlocked, browserRuns: report.browserRuns,
    failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
