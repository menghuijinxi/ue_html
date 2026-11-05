'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const benchFile = option('benchmark'), stressFile = option('stress'), imagesFile = option('images'), output = option('output');
assert(benchFile && stressFile && imagesFile && output && !fs.existsSync(output));
const verified = item => (assert.equal(audit(item.file).sha256, item.sha256, item.file), item);
function capture(file) {
  const report = read(file); assert(report.pass && !report.error && !report.prototype);
  verified(report.source); report.helpers.forEach(verified); report.packageFiles.forEach(verified);
  assert(report.runs.every(r => r.pass && !r.errors.length && !r.after.failure));
  for (const run of report.runs) {
    assert.equal(run.before.queryWait.budgetMs, run.queryWaitMs);
    assert.equal(run.after.queryWait.budgetMs, run.queryWaitMs);
    assert(!run.before.occlusion.bindingPlanEnabled && !run.before.upload.enabled);
    if (run.maxAhead) {
      assert(run.before.gpu[6] === 1 && run.after.gpu[0] > run.before.gpu[0]);
      assert(run.after.gpu[3] <= run.maxAhead && run.after.gpu[5] <= run.maxAhead);
    }
  }
  return report;
}
const bench = capture(benchFile), stress = capture(stressFile), images = read(imagesFile);
assert(bench.folder === stress.folder && !bench.stress && stress.stress);
assert.deepEqual(bench.packageFiles, stress.packageFiles);
assert(stress.runs.length === 3 && stress.runs[0].mode === 'control' && stress.runs[2].mode === 'control');
assert(stress.runs.every(r => r.visual.length === 5 && r.input && r.stress.length === 8));
assert(stress.runs[1].visibility && stress.runs[1].visibility.resumed.frame > stress.runs[1].visibility.hiddenAfter.frame);
verified(images.diagnostic); verified(images.source);
const imageInput = read(images.diagnostic.file); assert.equal(audit(stressFile).sha256, images.diagnostic.sha256);
assert(imageInput.pass && imageInput.stress);
for (let index = 0; index < 5; ++index) {
  for (let run = 0; run < 3; ++run) {
    const actual = stress.runs[run].visual[index]; verified(actual.screenshot);
    assert.deepEqual(imageInput.runs[run].visual[index].screenshot, actual.screenshot);
  }
}
const packageFile = path.join(__dirname, 'results', bench.folder + '-package.json'), packaged = read(packageFile);
assert(packaged.pass); packaged.products.forEach(verified); verified(packaged.build);
const build = read(packaged.build.file); assert(build.pass && build.buildSucceeded && build.allocator === 'mimalloc');
build.sourceFiles.forEach(verified);
build.objects.forEach(o => ['source', 'object', 'response', 'definitions'].forEach(k => verified(o[k])));
const modes = [...new Set(bench.modes)], aggregates = {};
for (const mode of modes) {
  const runs = bench.runs.filter(r => r.mode === mode); assert.equal(runs.length, 2);
  const frames = runs.reduce((s, r) => s + r.measurement.frames, 0);
  const ms = runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0);
  const intervals = runs.flatMap(r => r.intervals).sort((a, b) => b - a), tail = intervals.slice(0, Math.ceil(intervals.length * .01));
  const samples = runs.reduce((s, r) => s + r.after.occlusion.sampleFrame - r.before.occlusion.sampleFrame, 0);
  const workload = Object.fromEntries(['draws', 'indirectDraws', 'dispatches', 'ready', 'pending', 'zero'].map(k =>
    [k, runs.reduce((s, r) => s + r.after.occlusion[k] - r.before.occlusion[k], 0) / samples]));
  workload.pendingFraction = workload.pending / (workload.ready + workload.pending);
  aggregates[mode] = {runs: runs.map(r => ({index: r.index, fps: r.fps, low1Fps: r.frameMs.low1Fps})), frames,
    fps: frames * 1000 / ms, low1Fps: 1000 * tail.length / tail.reduce((s, v) => s + v, 0), maximumMs: intervals[0],
    rhiWorkMs: runs.reduce((s, r) => s + r.rhiWorkMs * r.measurement.frames, 0) / frames, workload,
    queryWait: {callsPerFrame: runs.reduce((s, r) => s + r.after.queryWait.calls - r.before.queryWait.calls, 0) / samples,
      unreadyPerFrame: runs.reduce((s, r) => s + r.after.queryWait.unready - r.before.queryWait.unready, 0) / samples,
      msPerFrame: runs.reduce((s, r) => s + r.after.queryWait.microseconds - r.before.queryWait.microseconds, 0) / samples / 1000},
    gpu: runs.map(r => ({before: r.before.gpu, after: r.after.gpu}))};
}
const candidate = stress.runs[1].mode;
assert(aggregates.control && aggregates.controlw8 && aggregates[candidate]);
const excludedCaptures = (option('excluded') || '').split(',').filter(Boolean).map(file => {
  const report = read(file); assert(!report.pass && report.error);
  return {input: audit(file), rawError: report.error, excludedFromResults: true};
});
const delta = (a, b) => ({fpsPercent: (b.fps / a.fps - 1) * 100, low1Percent: (b.low1Fps / a.low1Fps - 1) * 100});
const report = {date: new Date().toISOString(), experimentCompleted: true, pass: images.pass, acceptedForDefault: false,
  runtimeChecksPassed: true, strictImagesPassed: images.pass, candidate,
  inputs: [benchFile, stressFile, imagesFile, packageFile].map(audit), analysisSource: audit(__filename),
  excludedCaptures,
  executedSources: [bench.source, stress.source], package: {folder: bench.folder, build: packaged.build,
    products: packaged.products, originalCook: packaged.baselineCookPayload, baselineEvidence: packaged.baselineEvidence},
  settings: {camera: bench.runs[0].before.camera, view: bench.runs[0].before.view,
    renderer: bench.runs[0].before.settings, threads: bench.runs[0].before.threads, qualityOverrides: []},
  order: bench.modes, seconds: bench.seconds, warmup: bench.warmup, results: aggregates,
  combinedVsControl: delta(aggregates.control, aggregates[candidate]),
  queryWaitVsControl: delta(aggregates.control, aggregates.controlw8),
  clockVsSameQueryWait: delta(aggregates.controlw8, aggregates[candidate]),
  stressFrozen: stress.frozen, stress: stress.runs.map(r => ({mode: r.mode, input: r.input, visibility: r.visibility,
    snapshots: r.stress.map(s => ({frame: s.frame, view: s.view, gpu: s.gpu, queryWait: s.queryWait, streaming: s.streaming}))})),
  images, boundary: 'One six-run interleaved fixed-view comparison with two fresh browser runs per branch. Original queries and two-frame query history enabled. Candidate caps reserved and GPU-submitted frames; this is not measured input latency. Runtime stress covers five views, keyboard movement, three sizes and a visibility-handler pause/resume cycle. The capture records actualHiddenObserved and handlerSimulated; a simulated cycle does not verify browser background throttling. Image check uses independent fresh sessions bracketed by controls and retains temporal drift. Frozen-clock state is recorded explicitly. No default promotion, cross-browser or long-run acceptance; no first-use PSO/physical display/OS GPU-utilization/native performance claim.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: report.pass, results: aggregates, combined: report.combinedVsControl,
  queryOnly: report.queryWaitVsControl, clockAdditional: report.clockVsSameQueryWait}));
