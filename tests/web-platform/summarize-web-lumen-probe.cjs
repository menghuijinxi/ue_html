'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const [probePath, permutationsPath, gpuPath, outputPath] = process.argv.slice(2).map(value => path.resolve(value));
assert(probePath && permutationsPath && gpuPath && outputPath,
  'Expected full probe, targeted permutations, GPU report and output paths');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const probe = read(probePath), permutations = read(permutationsPath), gpu = read(gpuPath);
const cases = require('./lumen-tests/policy-cases.json');
const settings = spawnSync(process.execPath, [path.join(__dirname, 'verify-web-lumen-settings.cjs')], {encoding: 'utf8'});
assert.equal(settings.status, 0, settings.stderr);
const settingsReport = JSON.parse(settings.stdout);
assert.equal(probe.policies.length, cases.length);
assert(probe.policies.every(item => item.pass));
assert(permutations.pass && gpu.pass);
const failureCases = probe.shaders.cases.filter(item => !item.pass);
const report = {
  date: new Date().toISOString(),
  stage: 'initial-software-lumen-compatibility',
  completeLumenScene: false,
  fullProbePassed: probe.pass,
  hostCondition: gpu.hostCondition,
  projectRendererOverrides: [],
  settingsValidation: {pass: settingsReport.pass, checks: settingsReport.cases},
  policies: probe.policies.map((item, index) => ({name: cases[index].name, ...item})),
  shaders: {
    selection: 'First allowed permutation per registered Lumen global shader type',
    total: probe.shaders.cases.length,
    passed: probe.shaders.cases.length - failureCases.length,
    failed: failureCases.length,
    failures: failureCases,
  },
  targetedPermutations: permutations.shaders,
  browserGPU: {
    pass: gpu.pass, moduleCount: gpu.modules.length, device: gpu.device,
    execution: gpu.execution, boundary: gpu.boundary,
  },
  builds: {},
  sourceReports: [probePath, permutationsPath, gpuPath].map(audit),
  boundary: 'No full Lumen Cook, Surface Cache/GI scene, runtime resource release, scene FPS or peak VRAM acceptance.',
};
for (const name of ['native-rendercore', 'native-renderer', 'web-engine-full-thread']) {
  const file = path.join(__dirname, `results/${name}-build-results.json`);
  const build = read(file);
  assert(build.pass, `Build failed: ${name}`);
  report.builds[name] = {
    pass: build.pass, installedInputsUnmodified: build.installedInputsUnmodified,
    disableHostOptimization: build.disableHostOptimization,
    wasmValidated: build.wasmValidated, products: build.products,
    sourceReport: audit(file),
  };
}
fs.mkdirSync(path.dirname(outputPath), {recursive: true});
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output: outputPath, policies: report.policies.length,
  shaders: {total: report.shaders.total, passed: report.shaders.passed, failed: report.shaders.failed},
  targetedPermutations: permutations.shaders.cases.length, browserGPU: gpu.pass,
  completeLumenScene: false}));
