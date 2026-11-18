'use strict';
// Evidence for the automatic occlusion mode round (UE58_NANITE_HZB_AUTO_20261114.md).
// Small reports, probe sources, batch scripts and logs are archived. Readbacks,
// images, reports above 16 MiB and engine logs stay in results/ and are recorded
// by size and SHA-256 only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const name = 'nanite-hzb-auto-20261114', root = __dirname, results = path.join(root, 'results'), directory = path.join(root, 'evidence', name);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const archived = new Set(), referenced = new Set(), limit = 16 * 1024 * 1024;
const add = f => { assert(fs.existsSync(f), f); (fs.statSync(f).size <= limit ? archived : referenced).add(path.resolve(f)); return f; };
const reference = f => { assert(fs.existsSync(f), f); referenced.add(path.resolve(f)); return f; };
const round = (v, digits = 2) => v === undefined || v === null ? v : +v.toFixed(digits);
const runtime = 'nanite-hzbauto5';
function sourceOf(file, report, sourceName = 'source.cjs') {
  const source = path.join(path.dirname(file), sourceName);
  assert.equal(audit(source).sha256, report.source.sha256, source); add(source);
}
// Frozen-clock comparisons of the automatic scene test. `expected` maps the
// switch value of a step (0 or 1) to whether that step must have used two-phase occlusion.
function switchRun(step, villa, expected) {
  const tag = `${runtime}-${step}-20261113`, file = add(path.join(results, tag, 'report.json')), r = read(file);
  assert(r.pass, r.failure); assert.deepEqual(r.errors, []); assert.deepEqual(r.gpu.errors, []); sourceOf(file, r);
  assert.equal(!!r.villa, villa); assert.equal(r.comparisons.length, villa ? 4 : 3);
  for (const t of r.tests) {
    if (t.readback) { assert.equal(audit(t.readback.file).sha256, t.readback.sha256, t.readback.file); reference(t.readback.file); }
    if (t.entries) assert.equal(!!t.twoPhase, expected[t.batch], `${tag} step ${t.step}`);
  }
  reference(path.join(results, tag, 'engine.log'));
  return {tag, scalar: r.scalar, hzbMode: r.hzbMode, hzbAuto: r.hzbAuto, hzb: r.hzb, shade: r.shade, programmable: r.programmable, package: r.package.sha256,
    comparisons: r.comparisons, steps: r.tests.filter(t => t.entries).map(t => ({label: t.label, value: t.batch, hzbMode: t.hzbMode, twoPhase: t.twoPhase, clusterCapacity: t.clusterCapacity, entries: t.entries}))};
}
function fixtureRun(kind, file, sourceName, count) {
  const full = add(path.join(results, `${runtime}-${kind}-20261113`, file)), r = read(full);
  assert(r.pass, r.failure); assert.deepEqual(r.errors || [], []); assert.deepEqual(r.gpu.errors, []); sourceOf(full, r, sourceName);
  assert.equal(r.tests.length, count);
  return {kind, file, scalar: !!r.scalar, tests: r.tests.length, paths: r.paths, occlusionHistory: r.occlusionHistory, report: audit(full)};
}
// Laps of one browser session alternating a console variable.
function laps(tag, expect) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); assert(r.pass, r.failure); sourceOf(file, r);
  const summary = Object.fromEntries(Object.entries(r.summary).map(([v, s]) => [v, {laps: s.laps, fps: round(s.fps), fpsRange: s.fpsRange.map(x => round(x, 1)), low1Fps: round(s.low1Fps, 1),
    frameMs: round(s.frameMs, 3), rhiMs: round(s.rhiMs), renderMs: round(s.renderMs)}]));
  if (expect) expect(summary);
  return {tag, folder: r.folder, switch: r.switch, values: r.values, still: r.still, seconds: r.seconds, foreground: r.foregroundProcesses, summary};
}
function tour(tag) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); assert(r.pass, r.failure); sourceOf(file, r);
  assert(r.tour && r.headed && r.seconds === 60 && r.width === 2560 && r.height === 1440);
  return {tag, runs: r.runs.map(run => { const p = run.phases[0], x = p.result || p; assert(run.pass && !run.errors.length);
    return {index: run.index, folder: run.folder, nanite: run.nanite?.enabled, cvar: run.cvar && {name: run.cvar.name, value: run.cvar.value}, fps: round(x.fps), low1Fps: round(x.low1Fps),
      over33Ms: x.over33Ms, over50Ms: x.over50Ms, maxMs: round(x.maxMs, 1), rhiMs: round(x.rhiMs), renderMs: round(x.renderMs),
      foreground: [run.environmentBefore?.desktop?.foregroundProcess, run.environmentAfter?.desktop?.foregroundProcess]}; })};
}

const summary = {date: new Date().toISOString(), pass: true, naniteFullPerformanceAccepted: false, runtime};
summary.switches = [
  switchRun('villa-hzb-mode', true, {0: true, 1: false}), switchRun('villa-hzb-auto-two-phase', true, {0: true, 1: true}),
  switchRun('default-hzb-mode', false, {0: true, 1: false}), switchRun('default-hzb-mode-scalar', false, {0: true, 1: false}),
  switchRun('villa-shade-two-phase', true, {0: true, 1: true}), switchRun('villa-shade-auto', true, {0: false, 1: false}),
  switchRun('villa-programmable-auto', true, {0: false, 1: false}), switchRun('default-shade-two-phase', false, {0: true, 1: true}),
  switchRun('default-shade-auto-scalar', false, {0: false, 1: false})];
summary.fixtures = [];
for (const [kind, count] of [['programmable', 52], ['wpo', 36]]) for (const scalar of [false, true])
  summary.fixtures.push(fixtureRun(kind, scalar ? 'browser-scalar.json' : 'browser.json', scalar ? 'scalar-source.cjs' : 'packed-source.cjs', count));
for (const mode of ['packed', 'scalar']) {
  const row = fixtureRun('recovery', mode + '.json', mode + '-source.cjs', 8);
  // Disocclusion recovery ran with merged changed-occluder regions.
  assert(row.occlusionHistory.mergeBoundsChanges && row.occlusionHistory.boundsChangesMerged > 0);
  summary.fixtures.push(row);
}
{
  const file = add(path.join(results, `${runtime}-eligibility-20261113/report.json`)), r = read(file); assert(r.pass && r.tests.length === 13); sourceOf(file, r);
  summary.eligibility = {tests: 13, report: audit(file)};
}
const ratio = (s, a, b) => s[a].fps / s[b].fps;
summary.laps = {
  naniteTour: laps('nanite-hzbauto5-laps-onoff-b-20261114', s => assert(ratio(s, 1, 0) > .90 && ratio(s, 1, 0) < .97)),
  naniteTourEarlierBuild: laps('nanite-hzbauto4-laps-onoff-20261113', s => assert(ratio(s, 1, 0) > .90 && ratio(s, 1, 0) < .97)),
  naniteStill: laps('nanite-hzbauto5-laps-onoff-still-b-20261114', s => assert(ratio(s, 1, 0) > .95)),
  hzbTour: laps('nanite-hzbauto5-laps-hzb-b-20261114', s => assert(ratio(s, 2, 1) > 1.05)),
  hzbTourEarlierBuild: laps('nanite-hzbauto4-laps-hzb-20261113', s => assert(ratio(s, 2, 1) > 1.05)),
  boundsMergeStill: laps('nanite-hzbauto5-laps-boundsmerge-still-b-20261114', s => assert(s[1].renderMs < s[0].renderMs)),
  rdgValidationTour: laps('nanite-hzbauto4-laps-rdgvalidation-20261113', s => assert(s[0].renderMs < s[1].renderMs - .5)),
  // Removed experiment: one render pass for all merged fixed raster batches. No measurable change.
  fixedRasterSinglePass: laps('nanite-hzbauto3-laps-singlepass-a-20261113', s => assert(Math.abs(ratio(s, 1, 0) - 1) < .02))};
summary.firstTour = tour('nanite-hzbauto5-onoff-abba-b-20261114');
{
  const mean = v => { const rows = summary.firstTour.runs.filter(r => r.nanite === v); return rows.reduce((sum, r) => sum + r.fps, 0) / rows.length; };
  summary.firstTour.onOverOff = round(mean(1) / mean(0), 4); assert(summary.firstTour.onOverOff > .90);
}
// Runs kept although they are not comparable: a batch during which the machine was in use, and a lap
// set that overlapped other commands (its report may be incomplete because the batch was restarted).
summary.disturbed = ['nanite-hzbauto2-onoff-abba-20261113', 'nanite-hzbauto2-hzb-abba-20261113', 'nanite-hzbauto2-singlepass-abba-20261113'].map(tour);
for (const tag of ['nanite-hzbauto5-laps-onoff-20261114', 'nanite-hzbauto4-laps-singlepass-20261113']) {
  const file = path.join(results, tag, 'report.json'); if (fs.existsSync(file)) { add(file); summary.disturbed.push({tag, pass: read(file).pass, report: audit(file)}); }
}
// WebGPU calls per frame and the indirect draw validations they cause in the browser.
summary.calls = Object.fromEntries(['on', 'off'].map(state => {
  const file = add(path.join(results, `webgpu-calls-hzbauto5-${state}-20261114.json`)), r = read(file); assert(r.pass);
  return [state, {total: round(r.totalCallsPerFrame, 0), drawIndirect: round(r.perFrame['GPURenderPassEncoder.drawIndirect'] || 0, 1),
    drawIndexedIndirect: round(r.perFrame['GPURenderPassEncoder.drawIndexedIndirect'] || 0, 1), dispatchIndirect: round(r.perFrame['GPUComputePassEncoder.dispatchWorkgroupsIndirect'] || 0, 1),
    renderPassesWithIndirectDraws: round(r.indirect.renderPassesWithIndirectDraws, 1), drawValidationPasses: round(r.indirect.drawValidationPasses, 1), byTarget: r.indirect.byTarget,
    pipelinesCreated: r.pipelinesCreated}];
}));
assert(summary.calls.on.drawValidationPasses > summary.calls.off.drawValidationPasses);
{
  const file = add(path.join(results, 'webgpu-calls-hzbauto5-pipelines-20261114.json')), r = read(file); assert(r.pass);
  // The pipeline created just after the tour starts is the per-instance fixed raster one.
  const early = r.pipelinesCreated.find(p => p.kind === 'nanite-other' && p.seconds < 5); assert(early && early.markers.includes('WebRasterLocalToClip'));
  summary.firstMovePipeline = early;
}
{
  const file = add(path.join(results, 'webgpu-command-costs-busy-e-20261114.json')), r = read(file); assert(r.pass);
  summary.commandCosts = {note: 'Measured while the correctness batch was running; compare patterns with each other.',
    patterns: r.patterns.map(p => ({name: p.name, gpuProcessUs: round(p.gpuProcessUs), submitUs: round(p.submitUs), wallUs: round(p.wallUs)}))};
  const cost = n => r.patterns.find(p => p.name === n).gpuProcessUs;
  assert(cost('render pass + drawIndirect, one pass each, shared buffer') > 2 * cost('render pass + draw, one pass each'));
  assert(cost('one pass: drawIndirect, distinct buffers') > 3 * cost('one pass: drawIndirect, shared buffer'));
  for (const tag of ['a', 'b', 'busy-c', 'busy-d']) { const failed = path.join(results, `webgpu-command-costs-${tag}-20261114.json`); if (fs.existsSync(failed)) add(failed); }
}
// Batch scripts and logs, including the interrupted and discarded batches.
for (const n of fs.readdirSync(path.join(results, 'nanite-hzb-auto-20261113')).filter(n => /\.(ps1|log|txt)$/.test(n))) add(path.join(results, 'nanite-hzb-auto-20261113', n));
for (const scene of ['default', 'villa', 'regression']) { const file = path.join(root, 'build', `${runtime}-${scene}-20261113`, 'package.json'); assert(read(file).pass); add(file); }
for (const n of ['collect-nanite-hzb-auto.cjs', 'probe-nanite-switch-laps.cjs', 'probe-nanite-hierarchy-batch.cjs', 'probe-nanite-off-regression.cjs', 'probe-nanite-primitive-recovery.cjs',
  'count-webgpu-calls.cjs', 'bench-webgpu-command-costs.cjs', 'analyze-gpu-process-events.cjs', 'analyze-render-cpu-tree.cjs', 'profile-web-render-cpu.cjs', 'sample-test-environment.cjs'])
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
summary.boundary = 'Automatic occlusion mode takes one raster round below the cluster threshold; forced modes and the forced-threshold test keep two-phase covered. '
  + 'Lap comparisons are steady-state within one browser session; the first-tour comparison uses separate sessions. Sessions differ by several percent, '
  + 'so only rows of one report are compared. Command costs were measured on a busy machine. Disturbed and failed runs are kept. '
  + 'Full enabled performance acceptance stays open.';
fs.writeFileSync(path.join(root, 'evidence', name + '.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({pass: true, archives: records.length, archiveMiB: +(records.reduce((sum, r) => sum + fs.statSync(r.archive.file).size, 0) / 1048576).toFixed(1),
  referencedOnly: summary.referencedOnly.length, firstTourOnOverOff: summary.firstTour.onOverOff}));
