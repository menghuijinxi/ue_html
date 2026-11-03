'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const [probeFile, gpuFile, rhiFile, outputFile] = process.argv.slice(2).map(value => path.resolve(value));
assert(probeFile && gpuFile && rhiFile && outputFile, 'Expected shader probe, browser GPU, RHI and output reports');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const shaders = read(probeFile), gpu = read(gpuFile), rhi = read(rhiFile);
assert(shaders.pass && shaders.cases.length >= 158 && shaders.cases.every(item => item.pass));
assert(gpu.pass && gpu.modules.length === shaders.cases.length && gpu.execution.length === 6);
assert(gpu.modules.every(item => !item.errors.length && item.sourceFiles.every(valid)));
assert(gpu.sourceFiles.every(valid) && gpu.runtimeStorageBindings === 89);
assert(rhi.pass && !rhi.errors.length && rhi.pipelines === 9 &&
  rhi.cases.length === 10 && rhi.cases.every(item => item.pass && item.clearPass) &&
  [4, 18, 49].every(format => rhi.cases.some(item => item.format === format)));
assert(rhi.volumeCases?.length === 1 && rhi.volumeCases[0].format === 57 &&
  rhi.volumeCases[0].checkedTexels === 64 && rhi.volumeCases[0].pass);
const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
const build = read(buildFile);
assert(build.pass && build.products.every(valid) && build.sourceFiles.every(valid));
const report = {
  date: new Date().toISOString(),
  stage: 'software-lumen-storage-formats',
  completeLumenScene: false,
  rendererOverrides: [],
  shaders: {selection: 'First allowed permutation per Lumen/shared stochastic-lighting shader type',
    total: shaders.cases.length, passed: shaders.cases.length},
  browserGPU: {modules: gpu.modules.length, runtimeStorageBindings: gpu.runtimeStorageBindings,
    device: gpu.device, execution: gpu.execution},
  nativeRHI: {pipelines: rhi.pipelines, cases: rhi.cases, volumeCases: rhi.volumeCases,
    boundary: 'Actual RHI with fixed shader/metadata fixture; float bytes exact, UNORM tolerance one quantization unit'},
  wasm: {pass: build.pass, wasmValidated: build.wasmValidated, products: build.products},
  memoryBoundary: 'No texture widening, extra texture allocation or copy pass from runtime format specialization. ' +
    'WGSL source and per-format pipelines add CPU/driver memory; full-scene FPS/VRAM remain unmeasured.',
  sourceReports: [probeFile, gpuFile, rhiFile, buildFile].map(audit),
  boundary: 'Full Cook/package/browser scene acceptance is recorded separately; this report does not claim it.',
};
fs.mkdirSync(path.dirname(outputFile), {recursive: true});
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output: outputFile, shaders: report.shaders.total,
  gpuExecutions: gpu.execution.length, rhiCases: rhi.cases.length, completeLumenScene: false}));
