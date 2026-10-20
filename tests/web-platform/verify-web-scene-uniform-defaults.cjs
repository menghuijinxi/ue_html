const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, completeUEScene: false,
  sources: [audit(__filename)], reports: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-scene-uniform-defaults-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.minimalMapLoaded && run.frames === 0 &&
    run.errors.some(error => error.includes('GetDefaultSkinningParameters') &&
      error.includes('GetDefaultByteAddressBuffer') && error.includes('FExtensibleUniformBufferBase'))));
  const files = [
    ['Skinning/SkinningSceneExtension.cpp', 'OutParameters = FSkinningSceneParameters();', 'Module.Renderer.32.cpp'],
    ['GPUScene.cpp', 'GPUScene = FGPUSceneResourceParameters();', 'Module.Renderer.5.cpp'],
    ['ViewData.cpp', 'OutParameters = RendererViewData::FParameters();', 'Module.Renderer.35.cpp'],
    ['VirtualShadowMaps/VirtualShadowMapCacheManager.cpp', 'OutParameters = FVirtualShadowMapInvalidationSceneUniforms();', 'Module.Renderer.36.cpp']
  ];
  const link = load('web-engine-webgpu-link-results');
  assert(link.pass && link.sourceFiles.every(valid) && link.linkInputs.every(valid) && link.products.every(valid));
  for (const [relative, statement, unity] of files) {
    const suffix = `Engine/Source/Runtime/Renderer/Private/${relative}`;
    const source = path.join(root, 'reference-engine', suffix);
    const overlay = path.join(root, '.tools/ue58-web-build-host', suffix);
    const installed = path.join('H:/UE_5.8', suffix);
    const text = fs.readFileSync(source, 'utf8').replaceAll('\r', '');
    const branch = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/gm;
    const matches = [...text.matchAll(branch)];
    assert(matches.length === 1 && matches[0][1].trim() === statement);
    assert.equal(text.replace(branch, '$2'),
      fs.readFileSync(installed, 'utf8').replaceAll('\r', '').replace(/\n?$/, '\n'));
    assert.equal(text, fs.readFileSync(overlay, 'utf8').replaceAll('\r', ''));
    assert(text.includes('IMPLEMENT_SCENE_UB_STRUCT'));
    const compilation = link.recompiledObjects.find(item => path.basename(item.source.file) === unity);
    assert(compilation && compilation.exitCode === 0 &&
      ['source', 'response', 'product', 'log'].every(key => valid(compilation[key])) &&
      fs.readFileSync(compilation.source.file, 'utf8').includes(relative) &&
      link.linkInputs.some(item => item.file === compilation.product.file && item.sha256 === compilation.product.sha256));
    report.sources.push(...[source, overlay, installed].map(audit));
  }
  const platform = path.join(root, 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h');
  assert(fs.readFileSync(platform, 'utf8').includes('SupportsSkinningScene'));
  const config = path.join(root, 'reference-engine/Engine/Platforms/Web/Config/WebEngine.ini');
  const ini = fs.readFileSync(config, 'utf8');
  assert(ini.includes('r.GPUSkin.UseSceneExtension=0') && ini.includes('r.Mobile.SupportGPUScene=0'));
  report.sources.push(...[platform, config].map(audit));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.minimalMapLoadedVerified && valid(runtime.buildReport) && runtime.sourceFiles.every(valid));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(gpu.length === 2 && gpu.every(run => run.minimalMapLoaded &&
    !run.errors.some(error => /GetDefaultSkinningParameters|ConstructDefault\(FGPUScene|GetSceneUBDefaultParameters/.test(error))));
  report.sceneUniformDefaultsExcluded = true;
  report.engineInitReturnedVerified = runtime.engineInitReturnedVerified;
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.browserRuns = gpu.map(run => ({browser: run.browser, frames: run.frames,
    startupBlocker: run.startupBlocker, depthTextures: run.canvas.depthTextures.length,
    depthPasses: run.canvas.depthPasses.length}));
  report.pass = true;
  report.boundary = 'Only unused Web scene-uniform defaults for skinning, GPUScene, ViewData and VSM '
    + 'are zeroed. Registrations, original desktop bodies and existing feature gates remain. The actual '
    + 'changed unities are linked and both browser engines must pass the recorded skinning Raw Buffer '
    + 'failure. Runtime, rendered geometry and first-frame acceptance remain independent.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-scene-uniform-defaults-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, sceneUniformDefaultsExcluded: report.sceneUniformDefaultsExcluded,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
