const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r', '');
const report = {date: new Date().toISOString(), pass: false, debugVolumeDefaultsExcluded: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false, sourceFiles: [audit(__filename)],
  reports: [], browserRuns: []};
try {
  const load = name => {
    const file = path.join(results, name + '.json');
    report.reports.push(audit(file));
    return read(file);
  };
  const relative = 'Engine/Source/Runtime/Experimental/GeometryCollectionEngine/Private/GeometryCollection/GeometryCollectionRenderLevelSetActor.cpp';
  const target = path.join(root, 'reference-engine', relative);
  const overlay = path.join(root, '.tools/ue58-web-build-host', relative);
  const installed = path.join('H:/UE_5.8', relative);
  const original = text(installed), patched = text(target);
  assert.equal(sha(installed), 'f0a52d2713655e3f108fef1b08bd9d90aefeb8790914310fb193a2d48dca2626');
  assert.equal(text(overlay), patched);
  const guarded = /^#if PLATFORM_WEB\n([\s\S]*?)^#else\n([\s\S]*?)^#endif\n/gm;
  const blocks = [...patched.matchAll(guarded)];
  assert.equal(blocks.length, 1);
  assert.equal(patched.replace(guarded, '$2'), original,
    'Removing the Web branch must restore the entire desktop implementation exactly');
  for (const assignment of ['TargetVolumeTexture = nullptr;', 'RayMarchMaterial = nullptr;',
    'Enabled = false;', 'PostProcessComponent->bEnabled = false;'])
    assert(blocks[0][1].includes(assignment));
  assert(!blocks[0][1].includes('LoadObject'));
  assert(blocks[0][2].includes('/Engine/EngineDebugMaterials/VolumeToRender') &&
    blocks[0][2].includes('/Engine/EngineDebugMaterials/M_VolumeRenderSphereTracePP'));
  report.sourceFiles.push(...[target, overlay, installed,
    path.join(root, 'tests/web-platform/prepare-web-core-host.ps1'),
    path.join(root, 'tests/web-platform/probe-web-engine-webgpu.cjs')].map(audit));

  const repro = load('web-engine-webgpu-es31-results-debug-volume-repro-20261020');
  const before = repro.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(before.length, 2);
  assert(before.every(run => !run.pass && run.frames === 0 &&
    run.consoleLog.some(line => line.includes('P3_TEXTURE_CREATE name=VolumeToRender dimension=2 format=10 extent=10x10')) &&
    run.errors.some(error => error.includes('UVolumeTexture::PostLoad()') &&
      error.includes('AGeometryCollectionRenderLevelSetActor::AGeometryCollectionRenderLevelSetActor') &&
      error.includes('ProcessNewlyLoadedUObjects'))));
  report.previousFailure = 'Class-default construction loads the level-set volume debug assets during PreInit';
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && build.sourceFiles.every(valid) && build.products.every(valid) &&
    build.linkInputs.every(valid) && valid(build.log) && !build.fullNormalUBTBuildVerified);
  for (const file of [target, overlay, installed])
    assert(build.sourceFiles.some(item => item.file === file && valid(item)));
  assert(build.recompiledObjects.some(item => item.exitCode === 0 &&
    item.source.file.endsWith('Module.GeometryCollectionEngine.2.cpp') &&
    ['source', 'response', 'product', 'log'].every(key => valid(item[key])) &&
    text(item.source.file).includes('GeometryCollectionRenderLevelSetActor.cpp')));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.es31LibraryIntegrationVerified && runtime.materialPolicyMatched &&
    runtime.sourceFiles.every(valid) && runtime.configFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.stagedContentVerified && run.gpuValidationErrors.length === 0);
    const marker = run.consoleLog.findIndex(line => line.includes('P3_WEB level-set debug defaults omitted'));
    const ready = run.consoleLog.findIndex(line => line.includes('Running DelayedAutoRegister Phase ObjectSystemReady'));
    assert(marker >= 0 && ready > marker);
    assert(!run.consoleLog.some(line => line.includes('P3_TEXTURE_CREATE name=VolumeToRender')));
    assert(run.contentFiles.some(item => item.path === '/Engine/Content/EngineDebugMaterials/VolumeToRender.uasset'),
      'The runtime exclusion must be tested with the original volume asset still mounted');
    assert(run.textureUploads.pass && run.textureUploads.mips.some(mip =>
      mip.name === 'BlackDummy' && mip.expectedSHA256 === mip.actualSHA256 && mip.checkedBytes === 4));
    report.browserRuns.push({browser: run.browser, version: run.version, objectSystemReady: true,
      debugDefaultsOmitted: true, frames: run.frames, startupBlocker: run.startupBlocker});
  }
  const nullRuns = runtime.browserRuns.filter(run => run.rhi === 'null');
  assert.equal(nullRuns.length, 2);
  assert(nullRuns.every(run => run.pass && run.frames >= 9 && run.fileCacheVerified));
  report.debugVolumeDefaultsExcluded = true;
  report.pass = true;
  report.boundary = 'The saved before-fix browser records identify the level-set debug actor CDO as the loader; they are historical records, not a rerun of the previous binary. Current Web-only constructor initialization skips its two default debug assets and disables the debug post-process component. Both actual browser engines pass ObjectSystemReady and ordinary system texture initialization while the original assets remain mounted. The desktop source and installed source hash are unchanged. This check imposes no later blocker; subsequent system-default progress has a separate report. No new 3D/array support, complete normal Web UBT build, shader-payload execution, Engine frame or scene is verified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-debug-defaults-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, debugVolumeDefaultsExcluded: report.debugVolumeDefaultsExcluded,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
