'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const files = [];
function read(relative) {
  const file = path.join(__dirname, relative); files.push(audit(file));
  return JSON.parse(fs.readFileSync(file));
}
const baseline = read('results/villa-startup-20261109-baseline/result.json');
const chrome = read('results/villa-startup-20261109-prewarm-v2-plain/result.json');
const edge = read('results/villa-startup-20261109-prewarm-v2-edge/result.json');
const release = read('results/villa-startup-20261109-prewarm-v3-plain/result.json');
const failure = read('results/villa-startup-20261109-target-capture/result.json');
const comparison = read('results/villa-engine-comparison-20261109-prewarm-v3-final/result.json');
const packageReport = read('results/villa-prewarm-20261109-v3-package.json');
const current = read('build/villa-prewarm-20261109-v3/asset-versions.json');
const measured = read('build/villa-prewarm-20261109-v2/asset-versions.json');
const previous = read('build/villa-ue59-comparison-20261109-v4/asset-versions.json');
assert(baseline.pass && chrome.pass && edge.pass && release.pass && comparison.pass && packageReport.pass);
assert.equal(chrome.runs.length, 3); assert.equal(edge.runs.length, 3);
assert(chrome.plain && edge.plain && !chrome.affinity && !edge.affinity);
assert(release.plain && !release.affinity && release.runs.length === 3);
assert.equal(current['pipeline-prewarm.json'].sha256, measured['pipeline-prewarm.json'].sha256);
for (const name of ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'content.bin', 'config-files.json'])
  assert.equal(current[name].sha256, previous[name].sha256, name);
for (const item of packageReport.products)
  assert.equal(audit(item.file).sha256, item.sha256, item.file);
const summarize = report => report.runs.map(run => ({
  engine: run.engine, index: run.index, elapsedMs: run.elapsedMs, pass: run.pass,
  errorCount: run.errors.length, canvas: run.last.canvas,
  pipelines: run.last.worker?.calls,
  prewarm: run.last.prewarm, finalPrewarm: run.motion?.at(-1).prewarm,
  motionSeconds: report.motionSeconds, maxTravelCm: run.maxTravelCm, maxTurnDegrees: run.maxTurnDegrees
}));
for (const report of [chrome, edge, release]) for (const run of report.runs) {
  assert(run.pass && !run.errors.length);
  assert(run.maxTravelCm > 50 && run.maxTurnDegrees > 10);
  assert.equal(run.motion.at(-1).prewarm.counts.misses, 0);
  assert.equal(run.motion.at(-1).prewarm.counts.ready, 301);
}
const crashInspection = read('evidence/villa-startup-crash-inspection-20261109.json');
for (const name of ['web-engine-host.js', 'web-engine-worker.js', 'web-pipeline-prewarm.js',
  'package-villa-prewarm.cjs', 'probe-villa-startup.cjs', 'web-startup-probe.js', 'web-startup-profile.js',
  'verify-web-pipeline-prewarm.cjs', 'verify-villa-engine-comparison.cjs', 'villa-engine-comparison.json'])
  files.push(audit(path.join(__dirname, name)));
const evidence = {
  date: '2026-11-09', pass: true, candidate: 'villa-prewarm-20261109-v3',
  unchanged: Object.fromEntries(['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'content.bin', 'config-files.json']
    .map(name => [name, current[name].sha256])),
  baseline: summarize(baseline), chrome: summarize(chrome), edge: summarize(edge), release: summarize(release),
  reproducedFailures: failure.runs.map(run => ({index: run.index, elapsedMs: run.elapsedMs, failure: run.last.failure})),
  crashInspection,
  comparison: {
    pass: comparison.pass, dpr: comparison.dpr, affinity: comparison.affinity,
    runs: comparison.runs.map(run => ({
      engine: run.engine, pass: run.pass, errors: run.errors, readySeconds: run.readySeconds,
      officialReadyMs: run.state.officialPerformance?.prewarm?.marks?.ready,
      canvas: run.state.canvas, prewarm: run.state.prewarm,
      officialPrewarm: run.state.officialPerformance?.prewarm?.made,
      hudMeasured: run.state.performance?.submitted?.fps > 0 && run.state.performance?.submitted?.low > 0
    })),
    boundary: 'This final UI check waits for >60 engine frames / >120 official canvas acquisitions; its readySeconds are not comparable to the startup probe. Official own ready marker was 10.83 s in this fresh-profile run, unlike the earlier approximately 5 s measurements.'
  },
  files: files.map(item => ({...item, file: path.relative(root, item.file).replaceAll('\\', '/')})),
  boundary: 'Recorded PSO prewarm improves measured startup. The v2 candidate passed six uninstrumented starts across Chrome and Edge; v3 retains its pipeline pack and additionally distinguishes nested constants named label, with three Chrome starts and the comparison-page checks. Native compiler crash root cause is not fixed or proven. Coverage is limited to the captured route; new pipelines still compile on demand. Cold means no page content cache, not a cleared system driver cache. No FPS ranking or long-term reliability guarantee.'
};
fs.writeFileSync(path.join(__dirname, 'evidence/villa-startup-prewarm-20261109.json'),
  JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, chromeMs: chrome.runs.map(run => run.elapsedMs),
  edgeMs: edge.runs.map(run => run.elapsedMs), releaseMs: release.runs.map(run => run.elapsedMs),
  comparison: comparison.pass}));
