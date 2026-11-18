'use strict';
// Evidence for the rigid batch round (UE58_NANITE_RIGID_BATCH_20261114.md).
// Small reports, probe sources, batch scripts and logs are archived. Readbacks,
// images, reports above 16 MiB, engine logs, CPU profiles and traces stay in
// results/ and are recorded by size and SHA-256 only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const name = 'nanite-rigid-batch-20261114', root = __dirname, results = path.join(root, 'results'), directory = path.join(root, 'evidence', name);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const archived = new Set(), referenced = new Set(), limit = 16 * 1024 * 1024;
const add = f => { assert(fs.existsSync(f), f); (fs.statSync(f).size <= limit ? archived : referenced).add(path.resolve(f)); return f; };
const reference = f => { assert(fs.existsSync(f), f); referenced.add(path.resolve(f)); return f; };
const round = (v, digits = 2) => v === undefined || v === null ? v : +v.toFixed(digits);
const runtime = 'nanite-rigid', date = '20261114';
function sourceOf(file, report, sourceName = 'source.cjs') {
  const source = path.join(path.dirname(file), sourceName);
  assert.equal(audit(source).sha256, report.source.sha256, source); add(source);
}
function switchRun(step, villa) {
  const tag = `${runtime}-${step}-${date}`, file = add(path.join(results, tag, 'report.json')), r = read(file);
  assert(r.pass, r.failure); assert.deepEqual(r.errors, []); assert.deepEqual(r.gpu.errors, []); sourceOf(file, r);
  assert.equal(!!r.villa, villa); assert.equal(r.comparisons.length, villa ? 4 : 3);
  for (const t of r.tests) if (t.readback) { assert.equal(audit(t.readback.file).sha256, t.readback.sha256, t.readback.file); reference(t.readback.file); }
  reference(path.join(results, tag, 'engine.log'));
  return {tag, scalar: r.scalar, hzb: r.hzb, package: r.package.sha256, comparisons: r.comparisons,
    steps: r.tests.filter(t => t.entries).map(t => ({label: t.label, value: t.batch, entries: t.entries, batched: t.batched, other: t.dispatchBuffers, twoPhase: t.twoPhase}))};
}
function fixtureRun(kind, file, sourceName, count) {
  const full = add(path.join(results, `${runtime}-${kind}-${date}`, file)), r = read(full);
  assert(r.pass, r.failure); assert.deepEqual(r.errors || [], []); assert.deepEqual(r.gpu.errors, []); sourceOf(full, r, sourceName);
  assert.equal(r.tests.length, count);
  return {kind, file, scalar: !!r.scalar, tests: r.tests.length, paths: r.paths, report: audit(full)};
}
function laps(tag) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); assert(r.pass, r.failure); sourceOf(file, r);
  return {tag, folder: r.folder, switch: r.switch, values: r.values, still: r.still, foreground: r.foregroundProcesses,
    summary: Object.fromEntries(Object.entries(r.summary).map(([v, s]) => [v, {laps: s.laps, fps: round(s.fps), fpsRange: s.fpsRange.map(x => round(x, 1)), low1Fps: round(s.low1Fps, 1),
      frameMs: round(s.frameMs, 3), rhiMs: round(s.rhiMs), renderMs: round(s.renderMs)}]))};
}
function tour(tag) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); assert(r.pass, r.failure); sourceOf(file, r);
  assert(r.tour && r.headed && r.seconds === 60 && r.width === 2560 && r.height === 1440);
  return {tag, runs: r.runs.map(run => { const p = run.phases[0], x = p.result || p; assert(run.pass && !run.errors.length);
    // Frames longer than 40 ms with their time on the tour, to compare where stalls happen.
    const f = p.frames, long = []; for (let i = 1; i < f.length; i++) { const ms = f[i][1] - f[i - 1][1]; if (ms > 40) long.push({second: round((f[i][1] - f[0][1]) / 1000, 1), ms: round(ms, 0)}); }
    return {index: run.index, folder: run.folder, nanite: run.nanite?.enabled, fps: round(x.fps), low1Fps: round(x.low1Fps), over33Ms: x.over33Ms, over50Ms: x.over50Ms,
      maxMs: round(x.maxMs, 1), rhiMs: round(x.rhiMs), renderMs: round(x.renderMs), long}; })};
}
const summary = {date: new Date().toISOString(), pass: true, naniteFullPerformanceAccepted: false, runtime};

// One batch per view against 128 instances per batch.
summary.batchInstances = [switchRun('villa-batch-instances', true), switchRun('villa-batch-instances-auto', true), switchRun('default-batch-instances-scalar', false)];
{
  const villa = summary.batchInstances[0].steps.filter(s => s.label !== 'lifecycle');
  assert.deepEqual(villa.filter(s => s.value).map(s => s.other), [1, 1, 1, 1]); assert.deepEqual(villa.filter(s => !s.value).map(s => s.other), [5, 5, 3, 3, 2, 2, 5, 5]);
}
summary.switches = [['villa-hierarchy', true], ['villa-occlusion-batch', true], ['villa-pack-batch', true], ['villa-micro-batch', true], ['villa-micro-batch-auto', true],
  ['villa-fixed-merge', true], ['villa-fixed-merge-auto', true], ['default-micro-batch', false], ['default-micro-batch-scalar', false], ['default-fixed-merge', false],
  ['default-fixed-merge-scalar', false], ['villa-shade-auto', true], ['villa-programmable-auto', true], ['villa-hzb-mode', true], ['villa-hzb-auto-two-phase', true]].map(v => switchRun(...v));
summary.fixtures = [];
for (const [kind, count] of [['programmable', 52], ['wpo', 36]]) for (const scalar of [false, true])
  summary.fixtures.push(fixtureRun(kind, scalar ? 'browser-scalar.json' : 'browser.json', scalar ? 'scalar-source.cjs' : 'packed-source.cjs', count));
for (const mode of ['packed', 'scalar']) summary.fixtures.push(fixtureRun('recovery', mode + '.json', mode + '-source.cjs', 8));
{
  const file = add(path.join(results, `${runtime}-eligibility-${date}/report.json`)), r = read(file); assert(r.pass && r.tests.length === 13); sourceOf(file, r);
  summary.eligibility = {tests: 13, report: audit(file)};
}
summary.laps = {batchInstancesTour: laps('nanite-rigid-laps-batch-instances-20261114'), batchInstancesStill: laps('nanite-rigid-laps-batch-instances-still-20261114'),
  naniteTour: laps('nanite-rigid-laps-onoff-20261114'), naniteStill: laps('nanite-rigid-laps-onoff-still-20261114')};
assert(summary.laps.batchInstancesTour.summary[4096].rhiMs < summary.laps.batchInstancesTour.summary[128].rhiMs);
summary.firstTour = {onOff: tour('nanite-rigid-onoff-abba-20261114'), previousRuntimeAgainstThis: tour('nanite-rigid-oldnew-abba-b-20261114'),
  previousRuntimeOnOff: tour('nanite-hzbauto5-onoff-abba-b-20261114')};
{
  // The first-move stall is gone: no frame above 50 ms with Nanite on, and none in the first five seconds on this runtime.
  const on = summary.firstTour.onOff.runs.filter(r => r.nanite === 1); assert(on.every(r => r.over50Ms === 0));
  const versus = summary.firstTour.previousRuntimeAgainstThis.runs, early = r => r.long.filter(l => l.second < 5 && l.ms > 70).length;
  assert(versus.filter(r => r.folder.startsWith('nanite-hzbauto5')).every(r => early(r) === 1)); assert(versus.filter(r => r.folder.startsWith('nanite-rigid')).every(r => early(r) === 0));
}
{
  // Stall attribution on the previous runtime.
  const dir = path.join(results, 'nanite-hzbauto5-on-trace-b-20261114'), file = add(path.join(dir, 'gpu-process.json')), g = read(file);
  add(path.join(dir, 'report.json')); reference(g.trace.file);
  summary.stallTrace = {intervalsOver30Ms: g.intervalsOver30Ms, blocksOver8Ms: g.gpuProcess.blocksOver8Ms, longFrames: g.longFrames.map(f => ({tourSeconds: round(f.tourSeconds), intervalMs: round(f.intervalMs, 1), gpuCommandMs: round(f.gpuCommandMs, 1)}))};
  assert(g.gpuProcess.blocksOver8Ms[0] > 70);
}
summary.calls = Object.fromEntries([['previousRuntime', 'webgpu-calls-hzbauto5-on-20261114'], ['batch128', 'webgpu-calls-rigid-batch128-20261114'], ['default', 'webgpu-calls-rigid-on-20261114'],
  ['naniteOff', 'webgpu-calls-hzbauto5-off-20261114']].map(([key, tag]) => { const file = add(path.join(results, tag + '.json')), r = read(file); assert(r.pass);
  return [key, {total: round(r.totalCallsPerFrame, 0), drawIndirect: round(r.perFrame['GPURenderPassEncoder.drawIndirect'] || 0, 1), dispatch: round(r.perFrame['GPUComputePassEncoder.dispatchWorkgroups'] || 0, 1),
    writeBuffer: round(r.perFrame['GPUQueue.writeBuffer'] || 0, 1), drawValidationPasses: round(r.indirect.drawValidationPasses, 1),
    nanitePipelinesCreated: r.pipelinesCreated.filter(p => p.kind !== 'other').length}]; }));
assert(summary.calls.default.total < summary.calls.batch128.total && summary.calls.default.drawValidationPasses < summary.calls.previousRuntime.drawValidationPasses);
assert.equal(summary.calls.default.nanitePipelinesCreated, 0); assert.equal(summary.calls.previousRuntime.nanitePipelinesCreated, 1);
summary.commandCosts = ['a', 'b'].map(t => { const file = add(path.join(results, `webgpu-command-costs-idle-${t}-20261114.json`)), r = read(file); assert(r.pass);
  return r.patterns.map(p => ({name: p.name, gpuProcessUs: round(p.gpuProcessUs), submitUs: round(p.submitUs)})); });
// CPU profiles of the render thread and of the WebGPU owner thread during the tour.
summary.profiles = [];
for (const tag of ['render-cpu-nanite-rigid-tour-on-20261114', 'render-cpu-nanite-rigid-tour-off-20261114', 'render-cpu-nanite-rigid-on-20261114',
  'rhi-cpu-nanite-rigid-tour-on-a-20261114', 'rhi-cpu-nanite-rigid-tour-off-a-20261114', 'rhi-cpu-nanite-rigid-tour-off-b-20261114', 'rhi-cpu-nanite-rigid-tour-on-b-20261114']) {
  const file = add(path.join(results, tag + '.json')), r = read(file); assert(r.pass); reference(path.join(results, tag + '.cpuprofile'));
  summary.profiles.push({tag, thread: r.thread || 'render', nanite: r.nanite, frames: r.after.frames - r.before.frames, sampledFps: round(r.sampledFPS, 1)});
}
for (const n of fs.readdirSync(path.join(results, 'nanite-rigid-batch-20261114')).filter(n => /\.(ps1|log|txt)$/.test(n))) add(path.join(results, 'nanite-rigid-batch-20261114', n));
for (const scene of ['default', 'villa', 'regression']) for (const kind of ['', '-content']) {
  const file = path.join(root, 'build', `${runtime}-${scene}${kind}-${date}`, 'package.json'); assert(read(file).pass); add(file);
}
for (const n of ['collect-nanite-rigid-batch.cjs', 'probe-nanite-hierarchy-batch.cjs', 'probe-nanite-switch-laps.cjs', 'probe-nanite-off-regression.cjs', 'count-webgpu-calls.cjs',
  'bench-webgpu-command-costs.cjs', 'profile-web-render-cpu.cjs', 'compare-render-cpu.cjs', 'analyze-render-cpu-tree.cjs', 'analyze-gpu-process-trace.cjs', 'package-nanite-shadow-guard.cjs'])
  add(path.join(root, n));

assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const records = [];
for (const [i, file] of [...archived].entries()) {
  const bytes = fs.readFileSync(file), archive = path.join(directory, i + '-' + path.basename(file) + '.gz');
  fs.writeFileSync(archive, zlib.gzipSync(bytes, {level: 9})); assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(bytes));
  records.push({original: audit(file), archive: audit(archive)});
}
summary.records = records;
summary.referencedOnly = [...referenced].filter(f => !archived.has(f)).map(f => audit(f));
summary.boundary = 'Rigid instances form one batch per view; fixed and micro raster share one preparation. Exact frozen-clock comparisons across batch sizes, every batching switch, '
  + 'both occlusion modes and both visibility formats pass. The first-move pipeline stall is gone. Average frame rate gained about one percent; rows of different reports are not comparable '
  + 'because the machine state differed between batches. CPU profiles were taken on a busy machine and are used for on/off differences only. Full enabled performance acceptance stays open.';
fs.writeFileSync(path.join(root, 'evidence', name + '.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({pass: true, archives: records.length, archiveMiB: +(records.reduce((sum, r) => sum + fs.statSync(r.archive.file).size, 0) / 1048576).toFixed(1), referencedOnly: summary.referencedOnly.length}));
