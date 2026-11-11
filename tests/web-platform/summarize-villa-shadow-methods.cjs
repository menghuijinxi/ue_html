'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const inputs = process.argv.filter(arg => arg.startsWith('--input=')).map(arg => path.resolve(arg.slice(8)));
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
const allowInterrupted = process.argv.includes('--allow-interrupted');
assert(inputs.length && output, 'Provide --input=result.json for each session and --output=summary.json');
assert(!fs.existsSync(output), 'Preserve previous results');
const reports = inputs.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
const reference = reports[0], runs = [], excluded = [];
const phaseNames = ['standing', 'turning', 'moving'];
const viewKeys = ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'];
const settingsWithoutShadow = ({virtualShadows, virtualShadowPathActive, ...settings}) => settings;
const verifyAudit = item => assert.equal(audit(item.file).sha256, item.sha256, 'Changed input: ' + item.file);
const audited = new Set();
function once(item) {
  const key = item.file + ':' + item.sha256;
  if (!audited.has(key)) {verifyAudit(item); audited.add(key);}
}
function intervals(phase) {
  const times = phase.capture.times;
  assert(times.length > 100);
  const values = times.slice(1).map((time, index) => time - times[index]);
  assert(values.every(value => Number.isFinite(value) && value > 0));
  const duration = times.at(-1) - times[0];
  assert(duration >= reference.seconds * 950 && duration <= reference.seconds * 1200);
  return values;
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {intervals: values.length, fps: 1000 * values.length / values.reduce((a, b) => a + b, 0),
    low1Fps: 1000 * tail.length / tail.reduce((a, b) => a + b, 0),
    p95Ms: sorted[Math.floor(sorted.length * .95)], p99Ms: sorted[Math.floor(sorted.length * .99)],
    maxMs: sorted.at(-1), over50Ms: values.filter(value => value > 50).length,
    over100Ms: values.filter(value => value > 100).length};
}
for (let reportIndex = 0; reportIndex < reports.length; ++reportIndex) {
  const report = reports[reportIndex];
  assert(!report.error && !report.errors.length);
  assert(report.pass || allowInterrupted, 'Incomplete session requires --allow-interrupted');
  for (const key of ['folder', 'offFolder', 'seconds', 'warmup', 'browser', 'capturePackage'])
    assert.equal(report[key], reference[key], 'Mismatched session: ' + key);
  assert.equal(report.source.sha256, reference.source.sha256);
  assert.equal(report.package.sha256, reference.package.sha256);
  assert.deepEqual(report.files, reference.files);
  assert.deepEqual(report.packages, reference.packages);
  for (const item of [report.source, report.package, ...report.files]) once(item);
  for (const item of report.packages || []) {
    assert.equal(item.folder, item.virtualShadows ? report.folder : report.offFolder);
    for (const file of [item.manifest, ...item.files]) once(file);
  }
  for (let index = 0; index < report.runs.length; ++index) {
    const run = report.runs[index];
    assert.equal(run.virtualShadows, report.order[index]);
    assert(!run.errors.length);
    if (!run.phases.length) {
      assert(allowInterrupted && !report.pass && index === report.runs.length - 1,
        'Only an unmeasured final run in an interrupted session may be excluded');
      excluded.push({file: inputs[reportIndex], run: run.index, reason: 'Interrupted before measurement'});
      continue;
    }
    assert.deepEqual(run.phases.map(phase => phase.name), phaseNames, 'Incomplete measured run');
    if (report.offFolder) {
      assert.equal(run.override, undefined, 'Paired releases must not override startup settings');
      assert.equal(run.folder, report.packages[run.virtualShadows].folder);
    } else {
      assert.deepEqual(run.override, {path: '/Engine/Platforms/Web/Config/WebEngine.ini',
        section: 'SystemSettings', key: 'r.Shadow.Virtual.Enable', value: run.virtualShadows});
    }
    for (const phase of run.phases) {
      assert(phase.summary && phase.capture && !phase.capture.active);
      assert.equal(phase.capture.creations.length, 0, 'Compiled pipelines during timing');
      assert.equal(phase.summary.creations, 0);
      assert.equal(phase.summary.prewarmMisses, report.capturePackage ? null : 0);
      assert.equal(phase.samples.length, report.seconds);
      for (const state of [phase.before, ...phase.samples, phase.after]) {
        assert(!state.failure);
        assert.equal(state.settings.virtualShadows, run.virtualShadows);
        assert.equal(state.settings.virtualShadowPathActive, !!run.virtualShadows);
        for (const key of ['gi', 'reflections', 'virtualTextures']) assert.equal(state.settings[key], 1);
        assert(state.settings.virtualTexturePathActive);
        assert.equal(state.view.antiAliasing, 4);
        assert.deepEqual(settingsWithoutShadow(state.settings), settingsWithoutShadow(reference.runs[0].warmed.settings));
        for (const key of viewKeys) assert.equal(state.view[key], reference.runs[0].warmed.view[key], key);
      }
      if (phase.name !== 'standing') {
        assert(phase.completedMotion.completed);
        assert.equal(phase.completedMotion.serial, phase.after.motion.serial);
        let degrees = 0, distance = 0;
        for (let sample = 1; sample < phase.samples.length; ++sample) {
          const a = phase.samples[sample - 1].camera, b = phase.samples[sample].camera;
          degrees += Math.abs(((b.yaw - a.yaw + 540) % 360) - 180);
          distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        }
        assert(phase.name === 'turning' ? degrees > 250 : distance > 600);
      }
      const recomputed = summary(intervals(phase));
      for (const [key, value] of Object.entries(recomputed))
        assert.equal(phase.summary[key], value, 'Summary does not match raw timestamps: ' + key);
    }
    runs.push({file: inputs[reportIndex], ...run});
  }
}
assert.deepEqual(runs.map(run => run.virtualShadows), [0, 1, 1, 0], 'Require a complete off/on/on/off comparison');
for (const name of phaseNames) {
  const camera = runs[0].phases.find(phase => phase.name === name).before.camera;
  for (const run of runs) {
    const actual = run.phases.find(phase => phase.name === name).before.camera;
    for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
      assert(Math.abs(actual[key] - camera[key]) < .01, 'Different starting camera: ' + key);
  }
}
const result = {date: new Date().toISOString(), pass: true, source: audit(__filename),
  inputs: inputs.map(audit), package: reference.package, packages: reference.packages, files: reference.files,
  browser: reference.browser, seconds: reference.seconds, warmup: reference.warmup,
  renderView: Object.fromEntries(viewKeys.map(key => [key, reference.runs[0].warmed.view[key]])),
  settings: settingsWithoutShadow(reference.runs[0].warmed.settings),
  order: runs.map(run => run.virtualShadows), excluded, comparisons: [],
  boundary: 'Pooled raw RHI submission intervals, not average of Low values or physical presentation. Four validated runs, two per mode. ' +
    (reference.offFolder ? 'Paired releases with mode-matched prewarm and no startup override. ' :
      'In-memory startup override; warm steady-state only. ') +
    'Not cold-start validation. VSM off retains conventional shadows with different appearance.'};
for (const name of phaseNames) {
  const summarizeMode = mode => {
    const selected = runs.filter(run => run.virtualShadows === mode);
    return {...summary(selected.flatMap(run => intervals(run.phases.find(phase => phase.name === name)))),
      runs: selected.map(run => ({file: run.file, index: run.index,
        ...run.phases.find(phase => phase.name === name).summary}))};
  };
  const off = summarizeMode(0), on = summarizeMode(1);
  result.comparisons.push({name, off, on, low1CostPercent: 100 * (1 - on.low1Fps / off.low1Fps),
    averageCostPercent: 100 * (1 - on.fps / off.fps)});
}
fs.writeFileSync(output, JSON.stringify(result, null, 2));
console.log(JSON.stringify({pass: result.pass, comparisons: result.comparisons}, null, 2));
