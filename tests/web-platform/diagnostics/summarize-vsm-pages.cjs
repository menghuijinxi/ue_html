'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process'), sharp = require('sharp');
const {audit} = require('../content-file-metadata.cjs'), {readPage} = require('../web-pipeline-prewarm-package.cjs');
const base = path.resolve(__dirname, '..'), root = path.resolve(base, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8').replace(/^\uFEFF/, ''));
const folder = 'villa-vsm-pages-final-20261112', benchmarkFile = 'results/villa-vsm-pages-final-abba-20261112/result.json';
const nativeFile = 'build/vsm-pages-coherent-final-20261112/lumen-storage-rhi.json';
const verificationFile = 'results/villa-vsm-pages-final-release-20261112/result.json';
const gpuFiles = ['results/vsm-pages-final-off-gpu-20261112/result.json', 'results/vsm-pages-final-on-gpu-20261112/result.json'];
const benchmark = read(benchmarkFile), native = read(nativeFile), verification = read(verificationFile);
const gpu = gpuFiles.map(read), packageFile = 'results/web-project-triplex-virtual-distance-fields-threads-package-results.json';
const packaged = read(packageFile), page = readPage(path.join(base, 'build', folder));
assert(benchmark.pass && native.pass && verification.pass && packaged.pass);
assert.deepEqual(benchmark.order, [0, 3, 3, 0]);
assert.equal(benchmark.setting, 'r.WebGPU.VSMPageOptimization');
assert.deepEqual(native.errors, []);
assert(native.textureAtomicCases.every(c => c.pass && c.immutableHeaderUniform &&
  c.packedDifferentResourceHeaders && c.uniformLimitFallback && c.deferredComputeUAVBarrier &&
  c.mirrorToTextureCopies === c.layers * (c.layers === 1 ? 5 : 6) &&
  (c.layers === 1 || c.cachedTextureWriter)));
const cachedWriterBefore = read('build/vsm-pages-cached-writer-baseline-20261112/lumen-storage-rhi.json');
assert(!cachedWriterBefore.pass && !cachedWriterBefore.errors.length);
assert(cachedWriterBefore.textureAtomicCases.filter(c => c.layers > 1).every(c => !c.pass));
assert(verification.runs.every(r => r.pass && !r.errors.length && r.distance > 10 && r.yaw > 5));
assert.deepEqual(verification.runs.map(r => r.dpr), [1.5, 1]);
assert(packaged.releaseDefaults.releaseReady && packaged.releaseDefaults.prewarm.selection === 'automatic-reuse');
assert.equal(path.basename(packaged.output), folder);
assert(page.assets.pipelinePrewarm && !page.args.includes('-WebPSOPrecacheTest'));
const ini = Buffer.from(read('build/' + folder + '/config-files.json')
  .find(c => c.path === '/Engine/Platforms/Web/Config/WebEngine.ini').data, 'base64').toString();
for (const [name, value] of [['r.WebGPU.VSMPageOptimization', 3], ['r.WebGPU.IndirectDrawReuse', 2],
  ['r.Shadow.Virtual.SMRT.AdaptiveRayCount', 1]])
  assert.equal(ini.split(/\r?\n/).filter(line => line.startsWith(name + '=')).at(-1), name + '=' + value);
const performance = benchmark.comparisons.map(comparison => {
  const modes = comparison.modes.map(result => {
    const phases = benchmark.runs.filter(r => r.mode === result.mode).map(r => r.phases.find(p => p.name === comparison.name));
    const frames = phases.reduce((n, p) => n + p.after.rhi.sampleFrame - p.before.rhi.sampleFrame, 0);
    assert(frames > 1000);
    const counters = Object.fromEntries(['atomicCopiesToTexture', 'atomicCopiesToBuffer', 'atomicCopyBytes'].map(key =>
      [key + 'PerFrame', phases.reduce((n, p) => n + p.after.rhi[key] - p.before.rhi[key], 0) / frames]));
    const rhiMs = phases.reduce((n, p) => n + p.after.stages.rhiWorkMilliseconds - p.before.stages.rhiWorkMilliseconds, 0) /
      phases.reduce((n, p) => n + p.after.frames - p.before.frames, 0);
    return {mode: result.mode, fps: result.fps, low1Fps: result.low1Fps, p99Ms: result.p99Ms, rhiMs,
      counters, mirrorMiBPerFrame: counters.atomicCopyBytesPerFrame / 1048576};
  });
  const before = modes.find(m => m.mode === 0), after = modes.find(m => m.mode === 3);
  assert(after.mirrorMiBPerFrame < before.mirrorMiBPerFrame);
  return {name: comparison.name, before, after, fpsChangePercent: (after.fps / before.fps - 1) * 100,
    low1ChangePercent: (after.low1Fps / before.low1Fps - 1) * 100,
    copyBytesSavedPercent: (1 - after.mirrorMiBPerFrame / before.mirrorMiBPerFrame) * 100};
});
const target = 'main_00008674_0be2b746';
const gpuResults = gpu.map((report, index) => {
  assert(report.pass && !report.errors.length && !report.gpuValidationErrors.length);
  assert.equal(report.overrides['r.WebGPU.VSMPageOptimization'], index ? 3 : 0);
  assert.equal(report.package.sha256, benchmark.package.sha256);
  const catalog = read(path.join(path.dirname(gpuFiles[index]), 'compute-shaders.json'));
  const code = catalog[target]; assert(code && code.includes('OutPageReceiverMasks'));
  const headerLoads = [...code.matchAll(/atomicLoad\(&\(OutPageReceiverMasks\.\w+\[[0-3]u\]\)\)/g)].length;
  assert.equal(headerLoads, index ? 0 : 6);
  assert.equal(code.includes('WebTextureHeaders'), !!index);
  return {mode: index ? 3 : 0, shader: 'FGeneratePageFlagsFromPixelsCS', entry: target, headerLoads,
    phases: report.phases.map(phase => {
      const samples = phase.gpuFrames.map(f => f.capture.entries.filter(e => e.pipeline === target)
        .reduce((n, e) => n + e.gpuMs, 0));
      assert(samples.length >= 6 && samples.every(ms => ms > 0));
      return {name: phase.name, gpuMs: samples.reduce((a, b) => a + b, 0) / samples.length, samples};
    })};
});
const relativeAudit = file => ({...audit(path.resolve(base, file)),
  file: path.relative(root, path.resolve(base, file)).replaceAll('\\', '/')});
(async () => {
  const comparisons = [];
  for (const [a, b, kind] of [[1, 2, 'before-after'], [2, 3, 'repeat-on'], [1, 4, 'repeat-off']]) {
    const prefix = 'results/villa-vsm-pages-final-abba-20261112/';
    const files = [a, b].map(n => prefix + 'run-' + n + '-standing.png');
    const images = await Promise.all(files.map(f => sharp(path.join(base, f)).removeAlpha().raw()
      .toBuffer({resolveWithObject: true})));
    assert.deepEqual(images[0].info, images[1].info);
    const {width, height, channels} = images[0].info;
    let sum = 0, changed = 0, pixels = 0;
    for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
      if (x < 620 && y < 600) continue; // Exclude the live performance HUD.
      const offset = (y * width + x) * channels; let maximum = 0;
      for (let c = 0; c < 3; ++c) {
        const difference = Math.abs(images[0].data[offset + c] - images[1].data[offset + c]);
        sum += difference; maximum = Math.max(maximum, difference);
      }
      ++pixels; changed += maximum > 12;
    }
    comparisons.push({kind, files: files.map(relativeAudit), pixels, rgbMeanAbsoluteDifference: sum / (pixels * 3),
      changedFractionAbove12: changed / pixels});
  }
  assert(comparisons[0].rgbMeanAbsoluteDifference < 3);
  const sourceFiles = [benchmarkFile, nativeFile, verificationFile, packageFile, ...gpuFiles,
    ...gpuFiles.map(f => path.join(path.dirname(f), 'compute-shaders.json')),
    'results/vsm-pages-smoke-retry-20261112/result.json',
    'results/villa-vsm-pages-abba-gpu-20261112/result.json',
    'results/villa-vsm-pages-abba-20261112/result.json',
    'results/villa-startup-vsm-pages-20261112/result.json',
    'results/villa-startup-vsm-pages-packed-20261112/result.json',
    'results/villa-startup-vsm-pages-final-20261112/result.json',
    'results/villa-startup-vsm-pages-final-20261112/0-corpus.json',
    'build/vsm-pages-cached-writer-baseline-20261112/lumen-storage-rhi.json',
    'results/web-engine-full-thread-build-results.json',
    'results/vsm-pages-packed-native-build-20261112.log',
    'results/vsm-pages-coherent-final-build-20261112.log',
    'build/' + folder + '/asset-versions.json', 'build/' + folder + '/pipeline-prewarm.json',
    '../../UE58_WEB_VSM_PAGE_MARKING_SYNC.md',
    '../../UE58_WEB_VSM_REMAINING_OPTIMIZATIONS.md',
    'diagnostics/summarize-vsm-pages.cjs', 'diagnostics/probe-vsm-pages-smoke.cjs',
    'diagnostics/probe-vsm-remaining-costs.cjs', 'benchmark-villa-indirect-reuse.cjs',
    'verify-villa-indirect-release.cjs', 'verify-web-release-defaults.cjs', 'web-accepted-defaults.cjs',
    ...['WebGPUTextureAtomicHeaders.h', 'WebGPUShaderDeclarations.h', 'WebGPUDynamicRHI.h',
      'WebGPUDynamicRHI.cpp', 'WebGPUTransitions.cpp', 'WebGPUTextureAtomicProbe.h', 'WebGPULumenStorageProbe.h']
      .map(f => '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/' + f)];
  const assets = read('build/' + folder + '/asset-versions.json');
  const evidence = {date: '2026-11-12', pass: true, releaseReady: true, folder,
    url: 'http://127.0.0.1:8765/build/' + folder + '/index.html',
    referenceEngineCommit: execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'],
      {encoding: 'utf8'}).trim(),
    setting: {'r.WebGPU.VSMPageOptimization': 3}, sameQuality: true,
    wasm: assets['UEWebEngineThreads.wasm'].sha256, content: assets['content.bin'].sha256,
    performance, pageMarkingGPU: gpuResults, visualComparison: comparisons,
    native: {pass: native.pass, cases: Object.values(native).filter(Array.isArray).reduce((n, a) => n + a.length, 0),
      checkedAtomicValues: native.textureAtomicCases.reduce((n, c) => n + c.checkedValues, 0)},
    files: sourceFiles.map(relativeAudit),
    boundary: 'RHI submission intervals, not display presentation times. ABBA has no per-draw or profiler instrumentation; NVIDIA state sampled outside measurement windows. Mirror counters use their actual 30-frame publication ranges. GPU dispatch timing splits compute passes and is diagnostic only. Static screenshots cover one view; free movement is separately checked. One device-loss capture and one abnormal ~3 FPS baseline are retained and excluded, with no claim that their triggers are fixed.'};
  const output = 'evidence/vsm-pages-20261112.json';
  if (process.argv.includes('--record')) fs.writeFileSync(path.join(base, output), JSON.stringify(evidence, null, 2) + '\n');
  else assert.deepEqual(read(output), evidence);
  console.log(JSON.stringify({pass: true, performance, pageMarkingGPU: gpuResults, visualComparison: comparisons}, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
