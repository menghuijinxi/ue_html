'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs'), {readPage} = require('./web-pipeline-prewarm-package.cjs');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/^\uFEFF/, ''));
const folder = 'villa-vsm-indirect-20261112';
const benchmarkFile = 'results/villa-indirect-reuse-abba-tabs-20261112/result.json';
const gpuFile = 'results/indirect-template-gpu-wide-20261112.json';
const nativeFile = 'build/indirect-binding-rhi-v2-20261112/lumen-storage-rhi.json';
const verificationFile = 'results/villa-indirect-release-20261112/result.json';
const benchmark = read(benchmarkFile), gpu = read(gpuFile), native = read(nativeFile), verification = read(verificationFile);
for (const result of [benchmark, gpu, native, verification]) assert(result.pass);
assert.deepEqual(benchmark.order, [0, 2, 2, 0]); assert.equal(benchmark.runs.length, 4);
assert.deepEqual(gpu.gpu.indexFormats, [16, 32]); assert.equal(gpu.gpu.retained, 0);
assert(native.volatilePassVersions && native.rasterCases.length === 3);
assert(native.rasterCases.every(item => item.pass && item.indirectBindingReuseAndResourceMutation));
assert.deepEqual(native.errors, []);
assert.deepEqual(verification.runs.map(run => run.dpr), [1.5, 1]);
assert(verification.runs.every(run => run.pass && !run.errors.length && run.distance > 10 && run.yaw > 5));
const page = readPage(path.join(__dirname, 'build', folder));
assert(page.assets.pipelinePrewarm && !page.args.includes('-WebPSOPrecacheTest'));
const configs = read('build/' + folder + '/config-files.json');
const ini = Buffer.from(configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini').data, 'base64').toString();
assert.equal([...ini.matchAll(/^r\.WebGPU\.IndirectDrawReuse=(\d+)\r?$/gm)].at(-1)[1], '2');
assert.equal([...ini.matchAll(/^r\.Shadow\.Virtual\.SMRT\.AdaptiveRayCount=(\d+)\r?$/gm)].at(-1)[1], '1');
const comparisons = benchmark.comparisons.map(item => {
  const off = item.modes.find(mode => mode.mode === 0), on = item.modes.find(mode => mode.mode === 2);
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const rhi = mode => mean(mode.runs.map(run => run.rhiMs));
  return {name: item.name, off, on, rhiOffMs: rhi(off), rhiOnMs: rhi(on),
    rhiSavedPercent: 100 * (1 - rhi(on) / rhi(off)),
    averageFpsChangePercent: 100 * (on.fps / off.fps - 1),
    low1FpsChangePercent: 100 * (on.low1Fps / off.low1Fps - 1)};
});
const relativeAudit = file => ({...audit(path.resolve(__dirname, file)),
  file: path.relative(root, path.resolve(__dirname, file)).replaceAll('\\', '/')});
const files = [benchmarkFile, gpuFile, nativeFile, verificationFile,
  'results/villa-startup-vsm-indirect-20261112/result.json',
  'results/villa-startup-vsm-indirect-20261112/0-corpus.json',
  'results/web-project-triplex-virtual-distance-fields-threads-package-results.json',
  'results/web-engine-full-thread-build-results.json',
  'results/indirect-binding-native-build-20261112.log',
  'build/' + folder + '/asset-versions.json', 'build/' + folder + '/pipeline-prewarm.json',
  '../../UE58_WEB_INDIRECT_DRAW_REUSE.md',
  'benchmark-villa-indirect-reuse.cjs', 'verify-indirect-templates.cjs', 'verify-villa-indirect-release.cjs',
  'diagnostics/probe-indirect-reuse.cjs', 'draw-api-webgpu.cpp', 'web-accepted-defaults.cjs',
  'verify-web-release-defaults.cjs',
  '../../reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js',
  ...['WebGPUCommandStream.h', 'WebGPUDynamicRHI.cpp', 'WebGPUDynamicRHI.h',
    'WebGPUUAVRasterProbe.h', 'WebGPULumenStorageProbe.h'].map(name =>
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/' + name)].map(relativeAudit);
const assets = read('build/' + folder + '/asset-versions.json');
const evidence = {date: '2026-11-12', pass: true, releaseReady: true, folder,
  referenceEngineCommit: execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'],
    {encoding: 'utf8'}).trim(),
  url: 'http://127.0.0.1:8765/build/' + folder + '/index.html',
  setting: {'r.WebGPU.IndirectDrawReuse': 2}, sameQuality: true,
  wasm: assets['UEWebEngineThreads.wasm'].sha256, content: assets['content.bin'].sha256,
  gpu: gpu.gpu, native: {pass: native.pass, rasterCases: native.rasterCases,
    volatilePassVersions: native.volatilePassVersions, errors: native.errors},
  browser: benchmark.browser, performance: comparisons, files,
  boundary: 'Stable reduction in RHI CPU submission work in this ABBA; overall FPS essentially unchanged and turning 1% low did not improve. No reduction in draw count, resolution or sampling. Geometry transport templates, not cross-frame reuse of GPU results or full render bundles. GPU load and longer-term stability remain separate concerns.'};
const output = path.join(__dirname, 'evidence/indirect-reuse-20261112.json');
if (process.argv.includes('--record')) fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
else assert.deepEqual(read('evidence/indirect-reuse-20261112.json'), evidence);
console.log(JSON.stringify({pass: true, url: evidence.url, performance: comparisons.map(item =>
  ({name: item.name, rhiSavedPercent: item.rhiSavedPercent,
    averageFpsChangePercent: item.averageFpsChangePercent, low1FpsChangePercent: item.low1FpsChangePercent}))}));
