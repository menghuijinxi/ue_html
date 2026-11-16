'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..'), root = path.resolve(base, '../..');
const [suiteTag, routeTag, liveTag, outputTag] = process.argv.slice(2);
const candidateOnly = process.argv.includes('--candidate-only');
assert([suiteTag, routeTag, liveTag, outputTag].every(value => value && /^[a-z0-9-]+$/.test(value)));
const load = (directory, name) => JSON.parse(fs.readFileSync(path.join(base, directory, name + '.json')));
const source = (directory, name) => {
  const item = audit(path.join(base, directory, name + '.json'));
  return {...item, file: path.relative(root, item.file).replaceAll('\\', '/')};
};
const suite = load('build/' + suiteTag, 'suite'), route = load('results', routeTag);
const live = load('results', liveTag), run = route.runs.find(item => item.mode === 'automatic');
const buildName = 'web-engine-full-thread-build-results', build = load('results', buildName);
const compilation = build.compileExecution &&
  JSON.parse(fs.readFileSync(build.compileExecution.file));
assert(suite.diagnosticOnly && suite.variants.automatic.captureFree);
assert(route.pass && run.pass && live.pass);
const suiteHash = source('build/' + suiteTag, 'suite').sha256;
assert.equal(route.suite.sha256, suiteHash);
assert.equal(live.suite.sha256, suiteHash);
assert.equal(live.initialMode, 'automatic');
if (!candidateOnly) {
  assert(build.pass && build.wasmValidated && build.buildSucceeded);
  assert.equal(build.products.find(item => item.file.endsWith('UEWebEngineThreads.wasm')).sha256,
    run.package['UEWebEngineThreads.wasm'].sha256);
}
for (const item of build.sourceFiles) assert.equal(audit(item.file).sha256, item.sha256,
  'The recorded build source must still match: ' + item.file);
assert.deepEqual(run.recordedRequests, []);
assert.deepEqual(run.newCalls, []);
assert.equal(run.startup.rhi.asyncPrecacheFailed, 0);
assert.equal(run.startup.rhi.asyncPrecacheRequested, run.startup.rhi.asyncPrecacheCompleted);
assert(!run.startup.prewarm?.adopted);
const selected = run.collectorLog.map(line => {
  const match = line.match(/WEB_GLOBAL_PSO: (.*) selected=(\d+)/);
  assert(match);
  return {shader: match[1], selected: Number(match[2])};
});
const report = {
  date: new Date().toISOString(), pass: true, diagnosticOnly: true,
  formalReleaseApproved: false, defaultsChanged: false,
  testedPackageMatchesLatestSource: !candidateOnly,
  latestBuild: {pass: build.pass, buildSucceeded: build.buildSucceeded,
    standaloneCompilationPassed: !!compilation?.pass,
    compiledUnits: compilation?.results?.filter(item => item.code === 0).length || 0,
    linkFailedForSpace: !build.buildSucceeded &&
      fs.readFileSync(build.log.file, 'utf8').includes('no space on device'),
    failure: build.failure || null, log: build.log},
  sources: [source('build/' + suiteTag, 'suite'), source('results', routeTag),
    source('results', liveTag), source('results', buildName)],
  package: run.package, automaticPrecacheWithoutRecordedCorpus: true,
  cameraWarmupBeforeCoverageCheck: false, route: run.route,
  startup: {milliseconds: run.startup.ms, downloadedBytes: run.before.io.downloadedBytes,
    rhi: run.startup.rhi, view: run.startup.view, settings: run.startup.settings},
  routeNewCalls: run.newCalls, gpuErrors: run.after.capture.errors,
  selectedGlobalShaderTypes: selected.length,
  selectedGlobalPermutations: selected.reduce((sum, item) => sum + item.selected, 0),
  selectedFamilies: selected.filter(item =>
    /TSR|ScreenProbeTemporalReprojection|UpscaleCS|VirtualShadowMapProjection|Radiosity/.test(item.shader)),
  live: {distance: live.distance, yaw: live.yaw, forcedMainThreadGC: live.forcedGC || 0,
    forcedWorkerGC: live.forcedWorkerGC || 0,
    exportURL: live.exportURL, layouts: live.layouts.map(item => item.viewport),
    retainedPoseOnSwitch: true, fixedOutputAtDPR: 1.5},
  limitations: [
    ...(candidateOnly ? [
      'Candidate-only evidence: this tested package predates the latest source changes. The latest source build did not produce a linked, verified runtime; do not attribute candidate results to the latest source.'
    ] : []),
    'Warm resource and browser/driver caches retained; timing is one functional run, not an FPS ranking or a statistical speed guarantee.',
    'The exported route is sampled at eleven poses after initial-scene readiness; no claim that all maps, dynamic settings or future features are covered.',
    'Runtime-format compute PSOs still require actual UAV formats at dispatch and can be rejected by speculative collection.',
    'Initial requests can overlap before their native cache entry completes; async call totals may vary slightly between runs.',
    'External WebGPU Instance loss in an earlier candidate and one browser target crash remain unresolved; successful subsequent launches do not prove a fix.',
    'Ordinary releases still use the recorded-prewarm release gate; this explicit automatic diagnostic does not change release defaults.'
  ],
};
const output = assertProjectOutput(path.join(base, 'evidence', outputTag + '.json'));
assert(!fs.existsSync(output), 'Preserve existing evidence');
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, startupMs: report.startup.milliseconds,
  automatic: report.startup.rhi.asyncPrecacheCompleted, newCalls: report.routeNewCalls.length}));
