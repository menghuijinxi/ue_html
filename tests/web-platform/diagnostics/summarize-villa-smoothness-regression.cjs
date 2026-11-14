'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('../content-file-metadata.cjs');
const {readPage} = require('../web-pipeline-prewarm-package.cjs');
const {verifyDesktopRelease} = require('../web-release-defaults.cjs');
const {settings} = require('../web-accepted-defaults.cjs');
const base = path.resolve(__dirname, '..');
const input = relative => {
  const file = path.join(base, relative), value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return {value, audit: audit(file)};
};
const measured = [
  'villa-release-regression-native-20261112',
  'villa-release-regression-isolate-20261112',
  'villa-release-regression-fresh-baab-20261112',
].map(name => {
  const data = input('results/' + name + '/result.json'); assert(data.value.pass);
  for (const run of data.value.runs) {
    assert.deepEqual(run.errors, []);
    for (const phase of run.phases) {
      assert.equal(phase.before.prewarm.counts.misses, phase.after.prewarm.counts.misses);
      assert.deepEqual(phase.capture.creations, []);
      if (phase.kind === 'input') assert(phase.yawTravel > 50 && phase.after.player.active);
    }
  }
  return {name, report: data.audit, runs: data.value.runs.map(run => ({
    name: run.name, index: run.index, gpuBefore: run.gpuBefore,
    phases: run.phases.map(phase => ({kind: phase.kind, ...phase.summary,
      gpuCompletion: phase.gpuCompletionSummary, gpu: phase.gpu, yawTravel: phase.yawTravel})),
  }))};
});
const first = measured[0].runs;
assert(first[0].phases.find(phase => phase.kind === 'input').low1 >
  first[1].phases.find(phase => phase.kind === 'input').low1);
const qa = input('results/villa-smoothness-live-v3-20261112/result.json');
assert(qa.value.pass); assert.deepEqual(qa.value.errors, []);
assert.deepEqual(qa.value.states.slice(0, 4).map(state => state.page.mode), ['small', 'large', 'old', 'small']);
for (const state of qa.value.states.filter(state => state.page.mode !== 'old')) {
  const expected = state.page.mode === 'small' ? 256 : 1024;
  assert(state.tsrGroups[expected] > 0 && !state.tsrGroups[expected === 256 ? 1024 : 256]);
}
const release = input('results/villa-tsr-small-20261112-package.json');
assert(release.value.pass && release.value.release.releaseReady);
for (const product of release.value.products) assert.equal(audit(product.file).sha256, product.sha256);
verifyDesktopRelease(release.value.output, release.value.release);
const page = readPage(release.value.output), configs = JSON.parse(fs.readFileSync(
  path.join(release.value.output, 'config-files.json')));
const ini = Buffer.from(configs.find(item =>
  item.path === '/Engine/Platforms/Web/Config/WebEngine.ini').data, 'base64').toString();
assert.equal(ini.match(/^r\.WebGPU\.TSRLargeTiles=\d+$/gm).at(-1), 'r.WebGPU.TSRLargeTiles=0');
assert.equal(settings['r.WebGPU.TSRLargeTiles'], 0);
assert(!page.args.includes('-WebPSOPrecacheTest'));
const engineSource = path.resolve(base,
  '../../reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp');
assert(fs.readFileSync(engineSource, 'utf8').includes('TEXT("r.WebGPU.TSRLargeTiles"), 0,'));
const sources = ['diagnostics/benchmark-villa-release-regression.cjs',
  'diagnostics/summarize-villa-smoothness-regression.cjs', 'web-accepted-defaults.cjs',
  'verify-web-release-defaults.cjs', 'package-villa-tsr-smoothness.cjs',
  'villa-smoothness-live.html', 'villa-smoothness-live.js', 'verify-villa-smoothness-live.cjs']
  .map(file => audit(path.join(base, file)));
const evidence = {date: new Date().toISOString(), pass: true, performanceAccepted: false,
  regressionReproducedInFirstPair: true, causeIsolated: false, completeStutterFixProven: false,
  referenceEngineCommit: execFileSync('git', ['rev-parse', 'HEAD'],
    {cwd: path.resolve(base, '../../reference-engine'), encoding: 'utf8'}).trim(),
  defaultTSRLargeTiles: 0, retainedDefaults: {'r.WebGPU.IndirectDrawReuse': 2,
    'r.WebGPU.VSMPageOptimization': 3, 'r.Shadow.Virtual.SMRT.AdaptiveRayCount': 1},
  page: 'http://127.0.0.1:8765/villa-smoothness-live.html',
  release: release.audit, runtime: release.value.products.filter(product =>
    /UEWebEngineThreads\.wasm$|content\.bin$|config-files\.json$|asset-versions\.json$/.test(product.file)),
  qa: qa.audit, input: qa.value.checks.filter(check => check.mode),
  sources: [...sources, audit(engineSource)], measurements: measured,
  retainedInvalidDiagnostics: ['villa-release-regression-repro-20261112',
    'villa-smoothness-live-20261112', 'villa-smoothness-live-v2-20261112'],
  boundary: 'Restores the previously used tile size as default after user smoothness rejection. ' +
    'Cross-version samples are highly variable in both releases, so no stable speedup or complete stutter fix is claimed. ' +
    'Functional acceptance covers actual TSR selection, native input, pose continuity, fixed dimensions and prewarm. ' +
    'RHI submission and GPU completion callbacks do not measure physical display or input latency.'};
const output = assertProjectOutput(path.join(base, 'evidence/villa-smoothness-regression-20261112.json'));
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, performanceAccepted: false, output, engine: evidence.referenceEngineCommit}));
