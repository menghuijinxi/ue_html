'use strict';
// Evidence for the programmable raster merge and global shade binning rounds
// (UE58_NANITE_PROGRAMMABLE_MERGE_20261113.md, UE58_NANITE_SHADE_BINNING_20261113.md).
// Small reports, probe sources, batch scripts and logs are archived. Readbacks,
// images, per-test reports above 16 MiB, engine logs, CPU profiles and browser
// traces stay in results/ and are recorded by size and SHA-256 only.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const name = 'nanite-shade-binning-20261113', root = __dirname, results = path.join(root, 'results'), directory = path.join(root, 'evidence', name);
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const archived = new Set(), referenced = new Set();
const limit = 16 * 1024 * 1024;
const add = f => { assert(fs.existsSync(f), f); (fs.statSync(f).size <= limit ? archived : referenced).add(path.resolve(f)); return f; };
const reference = f => { assert(fs.existsSync(f), f); referenced.add(path.resolve(f)); return f; };
const round = (v, digits = 2) => v === undefined || v === null ? v : +v.toFixed(digits);
const noErrors = r => { assert(r.pass, r.failure); assert.deepEqual(r.errors || [], []); if (r.gpu) assert.deepEqual(r.gpu.errors, []); };
function sourceOf(file, report, sourceName = 'source.cjs') {
  const source = path.join(path.dirname(file), sourceName);
  assert.equal(audit(source).sha256, report.source.sha256, source); add(source);
}

// Frozen-clock switch comparisons of the automatic scene test.
function switchRun(tag, key, villa) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); noErrors(r); sourceOf(file, r);
  assert(r[key]); assert.equal(!!r.villa, villa); assert.equal(r.comparisons.length, villa ? 4 : 3);
  for (const t of r.tests) if (t.readback) { assert.equal(audit(t.readback.file).sha256, t.readback.sha256, t.readback.file); reference(t.readback.file); }
  reference(path.join(results, tag, 'engine.log'));
  return {tag, scalar: r.scalar, package: r.package.sha256, comparisons: r.comparisons,
    steps: r.tests.filter(t => t.entries).map(t => ({label: t.label, batch: t.batch, entries: t.entries, batched: t.batched, other: t.dispatchBuffers}))};
}
// Material, WPO and recovery fixtures write one report per visibility format.
function fixtureRun(tag, file, sourceName, count) {
  const full = add(path.join(results, tag, file)), r = read(full); noErrors(r); sourceOf(full, r, sourceName);
  assert.equal(r.tests.length, count);
  return {tag, file, scalar: !!r.scalar, tests: r.tests.length, paths: r.paths, cvars: r.cvars, report: audit(full)};
}
// First interior tour, one browser per run.
function tour(tag) {
  const file = add(path.join(results, tag, 'report.json')), r = read(file); assert(r.pass, r.failure); sourceOf(file, r);
  assert(r.tour && r.headed && r.seconds === 60 && r.width === 2560 && r.height === 1440);
  for (const run of r.runs) reference(path.join(results, tag, run.index + '-' + run.mode + '.log'));
  return {tag, instrumented: !!(r.trace || r.gpuTimestamps || r.gpuProbe), runs: r.runs.map(run => {
    const p = run.phases[0], x = p.result || p; assert(run.pass && !run.errors.length);
    return {index: run.index, folder: run.folder, nanite: run.nanite?.enabled, cvar: run.cvar && {name: run.cvar.name, value: run.cvar.value},
      programmableMerge: run.programmableMerge?.enabled, shadeBinning: run.shadeBinning?.enabled,
      fps: round(x.fps), low1Fps: round(x.low1Fps), p99Ms: round(x.p99Ms), over50Ms: x.over50Ms, rhiMs: round(x.rhiMs), renderMs: round(x.renderMs),
      foreground: run.environmentBefore ? [run.environmentBefore.desktop?.foregroundProcess, run.environmentAfter?.desktop?.foregroundProcess] : undefined,
      gpu: run.gpuTimestamps?.summary ? {frames: run.gpuTimestamps.frames, passMs: run.gpuTimestamps.passMs,
        rasterExtentMs: round(run.gpuTimestamps.groups['render:Nanite.Web.RasterExtent']?.msPerFrame, 3)} : undefined};
  })};
}
function trace(tag) {
  const out = tour(tag), file = add(path.join(results, tag, 'gpu-process.json')), g = read(file);
  assert.equal(audit(g.trace.file).sha256, g.trace.sha256); reference(g.trace.file);
  const h = g.gpuProcess['WebGPUDecoderImpl::HandleDawnCommands'];
  return {...out, frames: g.frames, tracedFps: round(g.tracedFps, 1), handleDawnMsPerFrame: round(h.perFrameMs), handleDawnShare: round(h.shareOfWall, 3),
    intervalsOver30Ms: g.intervalsOver30Ms, blocksOver8Ms: g.gpuProcess.blocksOver8Ms.map(v => round(v, 1))};
}
function calls(tag) {
  const file = add(path.join(results, tag + '.json')), r = read(file); assert(r.pass);
  const pick = k => round(r.perFrame[k] || 0, 1);
  return {tag, nanite: r.nanite, cvars: r.cvars, total: round(r.totalCallsPerFrame, 0), copyBufferToBuffer: pick('GPUCommandEncoder.copyBufferToBuffer'),
    writeBuffer: pick('GPUQueue.writeBuffer'), clearBuffer: pick('GPUCommandEncoder.clearBuffer'), beginComputePass: pick('GPUCommandEncoder.beginComputePass'),
    dispatchWorkgroups: pick('GPUComputePassEncoder.dispatchWorkgroups'), drawIndirect: pick('GPURenderPassEncoder.drawIndirect'),
    createBindGroup: pick('GPUDevice.createBindGroup'), writeBytes: round(r.writeBytesPerFrame, 0), copyBytes: round(r.copyBytesPerFrame, 0)};
}

const summary = {date: new Date().toISOString(), pass: true, naniteFullPerformanceAccepted: false};

// Round 1: programmable raster merge (runtime nanite-programmable3-*).
const merge = summary.programmableMerge = {};
merge.switches = [['nanite-programmable3-default-correctness-20261113', false], ['nanite-programmable3-default-scalar-20261113', false],
  ['nanite-programmable3-villa-correctness-20261113', true]].map(([tag, villa]) => switchRun(tag, 'programmable', villa));
merge.fixtures = [];
// The first fixture runs used content cooked before the parameter structure
// changed and stopped at the shader layout assertion. They are kept as failures;
// the passing material and WPO runs of this round are the shade-binning runtime
// with shade binning disabled at startup (shade.fixtures, state 'off').
merge.staleShaderFailures = [];
for (const tag of ['nanite-programmable3-programmable-20261113', 'nanite-programmable3-wpo-20261113']) for (const file of ['browser.json', 'browser-scalar.json']) {
  const full = add(path.join(results, tag, file)), r = read(full);
  assert(!r.pass && r.errors.some(e => e.includes('parameter structure has changed without recompilation')));
  merge.staleShaderFailures.push({tag, file, completedTests: r.tests.length, report: audit(full)});
}
for (const mode of ['packed', 'scalar']) merge.fixtures.push(fixtureRun('nanite-programmable3-recovery-20261113', mode + '.json', mode + '-source.cjs', 8));
{
  const file = add(path.join(results, 'nanite-programmable3-eligibility-20261113/report.json')), r = read(file); noErrors(r); sourceOf(file, r);
  assert.equal(r.tests.length, 13); merge.eligibility = {tests: 13, report: audit(file)};
}
merge.oldNew = tour('nanite-programmable3-oldnew-abba-20261113');
merge.onOff = tour('nanite-programmable3-onoff-abba-20261113');
merge.firstVersion = tour('nanite-programmable-motion-abba-20261113');
merge.gpuProcess = {on: trace('nanite-programmable2-stall-trace-20261113'), off: trace('nanite-programmable2-off-trace-20261113')};
assert.equal(merge.gpuProcess.on.handleDawnMsPerFrame, 9.94); assert.equal(merge.gpuProcess.off.handleDawnMsPerFrame, 5.63);

// Round 2: global shade binning (runtime nanite-shadebin-*).
const shade = summary.shadeBinning = {};
shade.switches = [['nanite-shadebin-default-correctness-20261113', false], ['nanite-shadebin-default-scalar-20261113', false],
  ['nanite-shadebin-villa-correctness-20261113', true]].map(([tag, villa]) => switchRun(tag, 'shade', villa));
{
  const villa = shade.switches[2].steps.filter(s => s.label !== 'lifecycle');
  assert.deepEqual(villa.filter(s => s.batch).map(s => s.batched), [149, 94, 81, 154]);
  assert(villa.every(s => s.batch ? s.other === 0 : s.batched === 0));
}
shade.fixtures = [];
for (const state of ['on', 'off']) for (const [kind, count] of [['programmable', 52], ['wpo', 36]]) for (const scalar of [false, true]) {
  const row = fixtureRun(`nanite-shadebin-${kind}-${state}-20261113`, scalar ? 'browser-scalar.json' : 'browser.json', scalar ? 'scalar-source.cjs' : 'packed-source.cjs', count);
  // The path observer proves which material path the fixture actually drew with.
  if (state === 'on') assert(row.paths.binnedMaterialDraws > 0 && row.paths.shadeBinDispatches > 0);
  else assert(row.paths.binnedMaterialDraws === 0 && row.paths.shadeBinDispatches === 0);
  shade.fixtures.push({state, ...row});
}
assert.equal(shade.fixtures.reduce((sum, f) => sum + f.tests, 0), 352);
for (const mode of ['packed', 'scalar']) shade.fixtures.push(fixtureRun('nanite-shadebin-recovery-20261113', mode + '.json', mode + '-source.cjs', 8));
{
  const file = add(path.join(results, 'nanite-shadebin-eligibility-20261113/report.json')), r = read(file); noErrors(r); sourceOf(file, r);
  assert.equal(r.tests.length, 13); shade.eligibility = {tests: 13, report: audit(file)};
}
shade.calls = {legacy: calls('webgpu-calls-shadebin-legacy-20261113'), binned: calls('webgpu-calls-shadebin-on-20261113'),
  binnedSingleRoundHZB: calls('webgpu-calls-shadebin-hzb0-20261113'), naniteOff: calls('webgpu-calls-shadebin-off-20261113'),
  previousRuntimeOn: calls('webgpu-calls-prog3-on-20261113'), previousRuntimeOff: calls('webgpu-calls-prog3-off-20261113')};
assert(shade.calls.binned.total < shade.calls.legacy.total && shade.calls.binned.copyBufferToBuffer < shade.calls.legacy.copyBufferToBuffer / 5);
shade.motion = ['nanite-shadebin-motion-abba-20261113', 'nanite-shadebin-motion-baab-20261113'].map(tour);
shade.onOff = ['nanite-shadebin-onoff-abba-20261113', 'nanite-shadebin-onoff-baab-20261113'].map(tour);
shade.foregroundWindow = tour('nanite-shadebin-onoff-env-20261113');
{
  // Same Nanite-off configuration, differing only in which window had the desktop foreground.
  const off = shade.foregroundWindow.runs.filter(r => r.nanite === 0);
  assert.equal(off[0].foreground[0], 'msedge'); assert.notEqual(off[1].foreground[0], 'msedge'); assert(off[0].fps > off[1].fps * 1.07);
}
shade.rdgValidation = tour('nanite-shadebin-rdgvalidation-abba-20261113');
shade.gpuProcess = {on: trace('nanite-shadebin-on-trace-20261113'), off: trace('nanite-shadebin-off-trace-20261113'), singleRoundHZB: trace('nanite-shadebin-hzb0-trace-20261113')};
assert(shade.gpuProcess.on.handleDawnMsPerFrame < merge.gpuProcess.on.handleDawnMsPerFrame - 2);

// Two-round HZB cost, measured on the shade-binning runtime.
const hzb = summary.twoRoundHZB = {};
hzb.backgroundWindow = tour('nanite-shadebin-hzb-abba-20261113');
hzb.foregroundWindow = ['nanite-shadebin-fg-hzb1-a-20261113', 'nanite-shadebin-fg-hzb0-a-20261113', 'nanite-shadebin-fg-hzb0-b-20261113', 'nanite-shadebin-fg-hzb1-b-20261113'].map(tour);
for (const r of hzb.foregroundWindow) assert.deepEqual(r.runs[0].foreground, ['msedge', 'msedge']);
{
  const fps = v => hzb.foregroundWindow.filter(r => r.runs[0].cvar.value === v).map(r => r.runs[0].fps);
  assert(Math.min(...fps(0)) > Math.max(...fps(1)) * 1.06, 'One round is faster in every foreground run');
}
hzb.gpuTime = ['nanite-shadebin-gputime-hzb1-d-20261113', 'nanite-shadebin-gputime-hzb0-d-20261113', 'nanite-shadebin-gputime-off-d-20261113'].map(tour);
assert(hzb.gpuTime[1].runs[0].gpu.passMs.mean < hzb.gpuTime[0].runs[0].gpu.passMs.mean);
hzb.failedAttempts = ['nanite-shadebin-gputime-hzb1-20261113', 'nanite-shadebin-gputime-hzb1-b-20261113', 'nanite-shadebin-gputime-hzb1-c-20261113', 'nanite-shadebin-gputime-hzb0-c-20261113']
  .map(tag => { const file = path.join(results, tag, 'report.json');
    // A run killed with the remote connection leaves no report; a run that exceeded the message size leaves a failed one.
    return fs.existsSync(file) ? {tag, pass: read(add(file)).pass, report: audit(file)} : {tag, pass: false, report: null}; });
for (const tag of ['nanite-shadebin-gpu-hzb1-20261113', 'nanite-shadebin-gpu-hzb0-20261113']) {
  const file = path.join(results, tag + '.json'); if (fs.existsSync(file)) add(file);
}
for (const tag of ['nanite-shadebin-on-20261113', 'nanite-shadebin-off-20261113']) {
  add(path.join(results, `render-cpu-${tag}.json`)); reference(path.join(results, `render-cpu-${tag}.cpuprofile`));
}

// Batch scripts, command logs, cleanup records.
for (const dir of ['nanite-programmable-merge-20261113', 'nanite-shade-binning-20261113'])
  for (const n of fs.readdirSync(path.join(results, dir)).filter(n => /\.(ps1|log|txt|json)$/.test(n))) add(path.join(results, dir, n));
for (const scene of ['default', 'villa', 'regression']) for (const prefix of ['nanite-programmable3', 'nanite-shadebin']) {
  const file = path.join(root, 'build', `${prefix}-${scene}-20261113`, 'package.json'); if (fs.existsSync(file)) { assert(read(file).pass); add(file); }
}
for (const n of ['collect-nanite-shade-binning.cjs', 'probe-nanite-hierarchy-batch.cjs', 'probe-nanite-off-regression.cjs', 'probe-nanite-programmable.cjs',
  'probe-nanite-wpo.cjs', 'count-webgpu-calls.cjs', 'analyze-gpu-process-trace.cjs', 'analyze-render-cpu-tree.cjs', 'observe-nanite-paths.cjs',
  'observe-nanite-motion-gpu.cjs', 'sample-test-environment.cjs', 'startup-cvars.cjs', 'package-nanite-shadow-guard.cjs', 'profile-web-render-cpu.cjs', 'profile-web-gpu.cjs'])
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
summary.boundary = 'Programmable raster draws merge by material and state buffer; material tiles for every shading bin come from three dispatches over the shading mask. '
  + 'Exact frozen-clock depth and material comparisons, mask/PDO/WPO fixtures in both visibility formats with the new path on and off, recovery and eligibility pass. '
  + 'Performance rows are single first-tour runs; rows with different foreground windows are not comparable, and instrumented rows are not frame-rate evidence. '
  + 'Readbacks, images, large per-test reports, engine logs, CPU profiles and traces are recorded by hash only and remain in results/. '
  + 'Two-round HZB is slower than one round in the accepted scene; full enabled performance acceptance stays open.';
fs.writeFileSync(path.join(root, 'evidence', name + '.json'), JSON.stringify(summary, null, 2) + '\n');
const bytes = records.reduce((sum, r) => sum + fs.statSync(r.archive.file).size, 0);
console.log(JSON.stringify({pass: true, archives: records.length, archiveMiB: +(bytes / 1048576).toFixed(1), referencedOnly: summary.referencedOnly.length}));
