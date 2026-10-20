const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r', '');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, ltcDefaultsExcluded: false,
  reports: [], sources: [audit(__filename)], browserRuns: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const relative = 'Engine/Source/Runtime/Renderer/Private/SystemTextures.cpp';
  const installed = path.join('H:/UE_5.8', relative);
  const target = path.join(root, 'reference-engine', relative);
  const overlay = path.join(root, '.tools/ue58-web-build-host', relative);
  assert.equal(sha(installed), 'e558424819663bcc4c8cced3408c9a170325585cd9efa3f1d1f5e9bf99014b16');
  assert.equal(text(target), text(overlay));
  const body = source => source.slice(source.indexOf('void FSystemTextures::InitializeEngineDependentTextures('),
    source.indexOf('void FSystemTextures::ReleaseRHI()'));
  const implementation = body(text(target));
  const guard = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/m.exec(implementation);
  assert(guard);
  assert.equal(implementation.replace(guard[0], guard[2]), body(text(installed)),
    'The complete desktop LTC initializer must remain unchanged');
  assert(guard[1].includes('bEngineDependentTexturesInitialized = true;') &&
    guard[1].includes('P3_WEB rect-light and sheen LTC defaults omitted'));
  assert(!/CreateTexture\(|GetCPUCopy\(|PF_G16R16F/.test(guard[1]));
  report.sources.push(...[installed, target, overlay].map(audit));
  const scene = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/SceneRendering.cpp');
  const sceneText = text(scene);
  assert(sceneText.includes('if (GSystemTextures.GGXLTCMat.IsValid() && GSystemTextures.GGXLTCAmp.IsValid())') &&
    sceneText.includes('if (GSystemTextures.SheenLTC.IsValid())'));
  for (const name of ['GGXLTCMatTexture', 'GGXLTCAmpTexture', 'SheenLTCTexture'])
    assert(new RegExp(`ViewUniformShaderParameters\\.${name}\\s*= OrBlack2DIfNull\\(ViewUniformShaderParameters\\.${name}\\);`)
      .test(sceneText));
  report.sources.push(audit(scene));
  const before = load('web-engine-webgpu-es31-results-before-ltc-defaults-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(oldGPU.length, 2);
  assert(oldGPU.every(run => run.canvas.configurations.length > 0 &&
    run.consoleLog.some(line => line.includes('P3_TEXTURE_CREATE name=GGX.LTCAmp dimension=0 format=15')) &&
    run.errors.some(error => error.includes('FSystemTextures::InitializeEngineDependentTextures'))));
  report.beforeFixRecordsAreHistorical = true;
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && build.sourceFiles.every(valid) && build.products.every(valid) &&
    build.linkInputs.every(valid) && !build.fullNormalUBTBuildVerified);
  const compilation = build.recompiledObjects.find(item =>
    path.basename(item.product.file) === 'Module.Renderer.34.cpp.o');
  assert(compilation && compilation.exitCode === 0 &&
    ['source', 'response', 'product', 'log'].every(key => valid(compilation[key])) &&
    build.linkInputs.some(item => item.file === compilation.product.file &&
      item.sha256 === compilation.product.sha256));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.es31LibraryIntegrationVerified && runtime.canvasViewportConfiguredVerified &&
    runtime.sourceFiles.every(valid) && valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.stagedContentVerified && run.textureUploads.pass && !run.gpuValidationErrors.length);
    assert.equal(run.consoleLog.filter(line =>
      line.includes('P3_WEB rect-light and sheen LTC defaults omitted')).length, 1);
    assert(!run.consoleLog.some(line => /P3_TEXTURE_CREATE name=(?:GGX\.LTCMat|GGX\.LTCAmp|Sheen\.LTC) /.test(line)));
    for (const name of ['GGX_LTCMat', 'GGX_LTCAmp', 'Sheen_LTC'])
      for (const extension of ['uasset', 'uexp'])
        assert(run.contentFiles.some(item => item.path.endsWith(`/LTC/${name}.${extension}`)),
          'Keep original LTC assets mounted while testing the initializer exclusion');
    assert(!run.textureUploads.mips.some(mip => /^(?:GGX\.LTCMat|GGX\.LTCAmp|Sheen\.LTC)$/.test(mip.name)));
    report.browserRuns.push({browser: run.browser, version: run.version, ltcDefaultsExcluded: true,
      textures: run.textureUploads.textures, mips: run.textureUploads.mips.length,
      checkedBytes: run.textureUploads.checkedBytes, acquisitions: run.canvas.acquisitions.length,
      frames: run.frames, startupBlocker: run.startupBlocker});
  }
  const nullRuns = runtime.browserRuns.filter(run => run.rhi === 'null');
  assert.equal(nullRuns.length, 2);
  assert(nullRuns.every(run => run.pass && run.frames >= 9 && run.fileCacheVerified));
  report.ltcDefaultsExcluded = true;
  report.pass = true;
  report.boundary = 'The current minimal Web platform excludes initialization of unused rect-light/BSDF GGX and sheen LTC textures. The full desktop initializer and installed source are preserved. Existing source-level validity checks and black-2D view defaults are audited; this does not claim that an actual scene has exercised that fallback or that lit/rect-light materials are supported. Both actual browser engines pass the former initializer failure with all six original LTC asset files still mounted. No RG16F support, compressed shader execution, browser presentation or Engine frame is implied.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-ltc-defaults-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, ltcDefaultsExcluded: report.ltcDefaultsExcluded,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
