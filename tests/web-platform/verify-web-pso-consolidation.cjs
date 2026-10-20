const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r', '');
const report = {date: new Date().toISOString(), pass: false,
  synchronousPSOConsolidationVerified: false, gpuSceneLightExclusionVerified: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false, reports: [], sources: [audit(__filename)]};
const load = name => {
  const file = path.join(results, name + '.json');
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-pso-sync-20261020');
  const beforeGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(beforeGPU.length === 2 && beforeGPU.every(run => run.frames === 0 &&
    run.startupBlocker === 'pipeline-cache-consolidation-guard' &&
    run.errors.some(error => error.includes('RHIAsyncCacheConsolidation') &&
      error.includes('FlushResources'))));
  const firstAB = load('web-pso-consolidation-probe-results-before-gpu-scene-lights-20261020');
  assert(firstAB.pass && firstAB.runs.length === 4 &&
    firstAB.runs.filter(run => run.asyncConsolidation === 0).every(run =>
      !run.consolidationGuardHit &&
      run.consoleLog.some(line => line.includes('GPUScene.LightData')) &&
      run.errors.some(error => error.includes('FGPUScene::UpdateGPULights') &&
        error.includes('UWorld::FinishDestroy'))));
  report.beforeFixRecordsAreHistorical = true;
  const probe = load('web-pso-consolidation-probe-results');
  assert(probe.pass && probe.asyncGuardReproduced && probe.synchronousConsolidationPassedGuard &&
    probe.sourceFiles.every(valid) && valid(probe.buildReport) &&
    valid(probe.stageReport) && valid(probe.configBundle));
  assert(probe.runs.length === 4 && probe.runs.every(run => run.pass));
  const build = load('web-engine-webgpu-link-results');
  const runtime = load('web-engine-webgpu-es31-results');
  assert(build.pass && !build.fullNormalUBTBuildVerified && build.sourceFiles.every(valid) &&
    build.linkInputs.every(valid) && build.products.every(valid) && valid(build.log));
  assert(runtime.synchronousPSOConsolidationConfigured && runtime.gameEngineInitializedVerified &&
    runtime.minimalMapLoadedVerified &&
    runtime.sourceFiles.every(valid) && runtime.configFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  for (const relative of [
    'RHI/Private/PipelineStateCache.cpp', 'Core/Private/HAL/ThreadingBase.cpp',
    'Core/Private/Async/Fundamental/Scheduler.cpp'
  ]) {
    const overlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    const installed = path.join('H:/UE_5.8/Engine/Source/Runtime', relative);
    assert(valid(firstAB.sourceFiles.find(item => item.file === overlay)),
      `Keep the existing engine implementation: ${relative}`);
    report.sources.push(audit(overlay));
    if (relative.startsWith('RHI/')) {
      assert.equal(sha(overlay), sha(installed), 'PSO cache guards must match the installed engine');
      report.sources.push(audit(installed));
    }
  }
  const cache = text(path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/RHI/Private/PipelineStateCache.cpp'));
  assert(cache.includes('#define PIPELINESTATECACHE_VERIFYTHREADSAFE (!UE_BUILD_SHIPPING && !UE_BUILD_TEST)') &&
    cache.includes('return IsInParallelRHIThread() || !GEnablePSOAsyncCacheConsolidation;') &&
    cache.includes('if (Result != 0)') &&
    cache.includes('Consolidate was hit while Get/SetPSO was running') &&
    cache.includes('ConsolidateThreadedCaches();'));
  const renderer = path.join(root, 'reference-engine/Engine/Source/Runtime/Renderer/Private/RendererScene.cpp');
  const rendererOverlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/RendererScene.cpp');
  assert.equal(sha(renderer), sha(rendererOverlay));
  assert(text(renderer).includes('if (UE::WebGPU::SupportsGPUScene(GetShaderPlatform()))\n\t{\n' +
    '\t\tGPUScene.OnPostLightSceneInfoUpdate(GraphBuilder, ChangeSetAlloc.PostUpdateChangeSet);\n\t}'));
  const helper = path.join(root, 'reference-engine/Engine/Source/Runtime/RenderCore/Public/WebShaderPlatform.h');
  assert(text(helper).includes('inline bool SupportsGPUScene(EShaderPlatform Platform)\n{\n\treturn !IsShaderPlatform(Platform);\n}'));
  report.sources.push(audit(renderer), audit(rendererOverlay), audit(helper));
  assert(build.sourceFiles.some(item => item.file === renderer && valid(item)) &&
    build.sourceFiles.some(item => item.file === rendererOverlay && valid(item)));
  const compiled = build.recompiledObjects.find(item =>
    path.basename(item.source.file) === 'Module.Renderer.26.cpp');
  assert(compiled && compiled.exitCode === 0 &&
    ['response', 'source', 'product', 'log'].every(key => valid(compiled[key])) &&
    text(compiled.source.file).includes('RendererScene.cpp') &&
    build.linkInputs.some(item => item.file === compiled.product.file &&
      item.sha256 === compiled.product.sha256));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(gpu.length === 2 && gpu.every(run => run.gameEngineInitialized &&
    run.gpuValidationErrors.length === 0 && run.engineQueueCompletion.pass &&
    run.consoleLog.some(line => line.includes('P3_WEB GPUScene light uploads omitted')) &&
    !run.consoleLog.some(line => line.includes('GPUScene.LightData') ||
      line.includes('Consolidate was hit while Get/SetPSO was running'))));
  report.synchronousPSOConsolidationVerified = true;
  report.gpuSceneLightExclusionVerified = true;
  report.engineLoopBrowserTickVerified = runtime.engineLoopBrowserTickVerified;
  report.browserRuns = gpu.map(run => ({browser: run.browser, frames: run.frames,
    gameEngineInitialized: run.gameEngineInitialized, startupBlocker: run.startupBlocker}));
  report.pass = true;
  report.boundary = 'The same real WASM and Cook/Stage reproduce the original guard with async consolidation=1 and pass it with async consolidation=0 in Chrome and Edge. The actual engine sources keep both atomic operations, task scheduling/tagging and PSO guards unchanged; Web selects the existing synchronous cache path. The nested counter explanation follows from those source semantics plus the controlled browser comparison, not direct measurement of private cache counters. The Web GPUScene capability excludes its separate light-upload call during scene updates, including temporary-world teardown. Native platforms still take the original call. The current runtime report separately determines ticks and later startup failures. This does not verify a rendered project scene or a fresh full normal Web UBT build.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-pso-consolidation-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass,
    synchronousPSOConsolidationVerified: report.synchronousPSOConsolidationVerified,
    gpuSceneLightExclusionVerified: report.gpuSceneLightExclusionVerified,
    engineLoopBrowserTickVerified: report.engineLoopBrowserTickVerified,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
