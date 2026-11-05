'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const normalFile = option('normal'), isolatedFile = option('noqueries'), output = option('output');
assert(normalFile && isolatedFile && output && !fs.existsSync(output), 'Specify inputs and a new output');
const verified = item => (assert.equal(audit(item.file).sha256, item.sha256, item.file), item);
const stableView = view => Object.fromEntries(Object.entries(view).filter(([key]) => !['frame', 'threadId'].includes(key)));
function distribution(values) {
  assert(values.length);
  const sorted = [...values].sort((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {count: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], maximum: sorted.at(-1),
    low1Fps: 1000 * tail.length / tail.reduce((s, v) => s + v, 0)};
}
function verifyCapture(file, sourceOverride) {
  const report = read(file);
  assert.equal(report.runs.length, report.modes.length);
  assert(report.runs.every(r => r.pass && !r.errors.length));
  // Preserve the raw failure and recheck all semantic view fields below.
  // Earlier captures compared frame/worker IDs as rendering settings.
  const metadataGateFailure = !report.pass && /^AssertionError \[ERR_ASSERTION\]: Expected values to be strictly deep-equal:/.test(report.error || '') &&
    /\+\s+(?:frame|threadId):/.test(report.error);
  assert((report.pass && !report.error) || metadataGateFailure, report.error);
  const capturedSource = sourceOverride ? audit(sourceOverride) : verified(report.capturedSource);
  assert.equal(capturedSource.sha256, report.source.sha256, 'Executed source snapshot');
  report.packageFiles.forEach(verified);
  for (const run of report.runs) {
    verified(run.diagnosticRuntime);
    assert.equal(run.routedRuntimeSha256, run.diagnosticRuntime.sha256);
    assert.equal(run.before.pacingBuildMode, run.mode);
    assert(run.measurement.frames > 100 && run.scheduling.length > 100);
    assert(run.before.threads.renderThread && run.before.threads.rhiThread);
    assert(!run.before.upload.enabled && !run.before.occlusion.bindingPlanEnabled);
    assert.equal(run.before.capacity, run.after.capacity);
    assert.deepEqual(run.before.camera, run.after.camera);
    assert.deepEqual(run.before.settings, run.after.settings);
    assert.deepEqual(stableView(run.before.view), stableView(run.after.view));
    assert.deepEqual(run.before.camera, report.runs[0].before.camera);
    assert.deepEqual(run.before.settings, report.runs[0].before.settings);
    assert.deepEqual(stableView(run.before.view), stableView(report.runs[0].before.view));
  }
  return {report, input: audit(file), capturedSource, validation: {rawPass: report.pass,
    aggregateMetadataGateRechecked: metadataGateFailure, rawError: report.error || null}};
}
const normal = verifyCapture(normalFile, option('normal-source'));
const isolated = verifyCapture(isolatedFile);
assert.equal(normal.report.folder, isolated.report.folder);
assert.deepEqual(normal.report.packageFiles, isolated.report.packageFiles);
assert(!normal.report.queryBuffering && (!normal.report.queries || normal.report.queries === 'default'));
assert.equal(isolated.report.queries, 'off');
assert(isolated.report.runs.every(r => r.occlusionOverrideAck));
assert.deepEqual(normal.report.runs[0].before.camera, isolated.report.runs[0].before.camera);
assert.deepEqual(normal.report.runs[0].before.settings, isolated.report.runs[0].before.settings);
function aggregate(capture) {
  return Object.fromEntries([...new Set(capture.modes)].map(mode => {
    const runs = capture.runs.filter(r => r.mode === mode); assert.equal(runs.length, 2);
    const frames = runs.reduce((s, r) => s + r.measurement.frames, 0);
    const milliseconds = runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0);
    const sampleFrames = runs.reduce((s, r) => s + r.after.occlusion.sampleFrame - r.before.occlusion.sampleFrame, 0);
    const workload = Object.fromEntries(['draws', 'indirectDraws', 'dispatches', 'ready', 'pending', 'zero'].map(k =>
      [k, runs.reduce((s, r) => s + r.after.occlusion[k] - r.before.occlusion[k], 0) / sampleFrames]));
    workload.pendingFraction = workload.pending / (workload.ready + workload.pending) || 0;
    const scheduling = {};
    for (const [name, from, to] of [['requestToGame', 'requested', 'gameBegin'], ['gameCallbackWall', 'gameBegin', 'gameEnd'],
      ['requestToOwner', 'requested', 'ownerReceived'], ['ownerScheduleWait', 'ownerReceived', 'ownerCallback'], ['ownerToGame', 'ownerCallback', 'gameBegin']]) {
      const values = runs.flatMap(r => r.scheduling).filter(r => Number.isFinite(r[from]) && Number.isFinite(r[to])).map(r => r[to] - r[from]);
      if (values.length) {scheduling[name] = distribution(values); delete scheduling[name].low1Fps;}
    }
    return [mode, {runs: runs.map(r => ({index: r.index, fps: r.fps, low1Fps: r.frameMs.low1Fps})),
      frames, milliseconds, fps: frames * 1000 / milliseconds, frameMs: distribution(runs.flatMap(r => r.intervals)),
      rhiWorkMs: runs.reduce((s, r) => s + r.rhiWorkMs * r.measurement.frames, 0) / frames,
      workload, scheduling, frameProgressSnapshots: runs.map(r => ({before: {game: r.before.gameFrames, rhi: r.before.frames},
        after: {game: r.after.gameFrames, rhi: r.after.frames}}))}];
  }));
}
const ordinary = aggregate(normal.report), noqueries = aggregate(isolated.report);
// The isolation is useful only if disabling queries actually removes query
// polling, and both schedules submit the same geometry workload. Dispatch
// counts remain recorded separately; elapsed-time-dependent passes may differ.
assert(Object.values(noqueries).every(r => r.workload.ready === 0 && r.workload.pending === 0));
for (const key of ['draws', 'indirectDraws']) {
  assert(Math.abs(noqueries['game-local'].workload[key] / noqueries['owner-raf'].workload[key] - 1) < .005,
    'Isolation workload differs: ' + key);
}
const delta = group => ({fpsPercent: (group['game-local'].fps / group['owner-raf'].fps - 1) * 100,
  low1Percent: (group['game-local'].frameMs.low1Fps / group['owner-raf'].frameMs.low1Fps - 1) * 100,
  dispatchPercent: (group['game-local'].workload.dispatches / group['owner-raf'].workload.dispatches - 1) * 100});
const prior = ['tests/web-platform/evidence/binding-tlv-20261104.json', 'tests/web-platform/evidence/buffer-lifecycle-20261104.json'];
const sources = ['reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js',
  'tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp',
  'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp'];
const excluded = (option('excluded') || '').split(',').filter(Boolean).map(file => {
  const capture = read(file); assert(!capture.pass && capture.error);
  return {input: audit(file), rawPass: false, rawError: capture.error,
    modeOrder: capture.modes, completedRuns: capture.runs.filter(r => r.pass).length,
    excludedFromPerformanceSummary: true};
});
const report = {date: new Date().toISOString(), pass: true, diagnosticWindowsVerified: true, acceptedForDefault: false,
  schedulingOpportunityObserved: true, qualityParityVerified: false, motionStabilityVerified: false,
  gpuUtilizationMeasured: false, fullGpuFrameMeasured: false,
  inputs: [normal.input, isolated.input], executedSources: [normal.capturedSource, isolated.capturedSource],
  captureValidation: [normal.validation, isolated.validation],
  excludedCaptures: excluded,
  analysisSource: audit(__filename), contextSources: sources.map(audit), priorNullResults: prior.map(audit),
  packageFiles: normal.report.packageFiles, settings: {view: stableView(normal.report.runs[0].before.view),
    camera: normal.report.runs[0].before.camera, renderer: normal.report.runs[0].before.settings,
    threads: normal.report.runs[0].before.threads, capacity: normal.report.runs[0].before.capacity},
  normal: {order: normal.report.modes, seconds: normal.report.seconds, warmup: normal.report.warmup, results: ordinary, change: delta(ordinary)},
  noqueries: {order: isolated.report.modes, seconds: isolated.report.seconds, warmup: isolated.report.warmup,
    diagnosticOverrides: isolated.report.diagnosticOverrides, results: noqueries, change: delta(noqueries)},
  boundary: 'Fixed-view diagnostic, not a product optimization. FPS is completed RHI submissions, not display scanout or GPU completion. Ordinary scheduling changes occlusion readiness and draw/dispatch counts. Queries-off is a separate matched-workload isolation, not a shipping setting. Scheduling telemetry uses a later four-second window. All timings are wall clock; callback and wait intervals overlap other threads. Screenshots are observations, not accepted pixel parity. No moving-camera, first-use PSO, hidden-tab, input latency, GPU queue depth or desktop parity acceptance.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({normal: ordinary, normalChange: report.normal.change, noqueries, isolatedChange: report.noqueries.change}, null, 2));
