'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const reports = ['baseline', 'candidate'].map(name => {
  assert(option(name), '--' + name + ' requires a result.json path');
  const file = path.resolve(option(name));
  return {file, data: JSON.parse(fs.readFileSync(file, 'utf8'))};
});
const [baseline, candidate] = reports.map(item => item.data);
const comparison = {date: new Date().toISOString(), pass: false, reports: reports.map(item => audit(item.file)),
  source: audit(__filename), phases: [],
  boundary: 'Relative regression gate for controlled runs on the same machine/browser. RHI submission FPS, not display timing or a cross-device target.'};
try {
  for (const report of [baseline, candidate]) {
    assert(report.pass && !report.gpu && !report.cpu && !report.errors.length);
    assert.equal(audit(report.package.file).sha256, report.package.sha256, 'Measured package changed');
    assert.equal(audit(report.source.file).sha256, report.source.sha256, 'Timing harness changed');
    for (const key of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
      assert.equal(report.initial.settings[key], 1, key);
    assert(report.initial.settings.virtualShadowPathActive && report.initial.settings.virtualTexturePathActive);
    assert(report.initial.prewarm.ready && report.initial.prewarm.adopted);
  }
  assert.equal(baseline.source.sha256, candidate.source.sha256);
  assert.equal(baseline.seconds, candidate.seconds);
  assert.equal(baseline.warmup, candidate.warmup);
  assert.deepEqual(baseline.initial.settings, candidate.initial.settings);
  for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
    assert.equal(baseline.initial.view[key], candidate.initial.view[key], key);
  const folders = reports.map(item => path.dirname(item.data.package.file));
  for (const name of ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'config-files.json',
    'web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js'])
    assert.equal(audit(path.join(folders[0], name)).sha256, audit(path.join(folders[1], name)).sha256, name);
  assert.equal(baseline.phases.length, 6);
  assert.equal(candidate.phases.length, baseline.phases.length);
  for (let index = 0; index < baseline.phases.length; ++index) {
    const before = baseline.phases[index], after = candidate.phases[index];
    assert.equal(before.name, after.name);
    assert.equal(after.summary.prewarmMisses, 0, after.name + ': unrecorded pipeline');
    assert.equal(after.summary.creations, 0, after.name + ': runtime pipeline compilation');
    const ratio = after.summary.fps / before.summary.fps;
    if (!before.name.startsWith('standing')) {
      assert(ratio >= 2, before.name + ': require at least 2x motion throughput');
      assert(after.summary.p95Ms < before.summary.p95Ms * .5, before.name + ': require lower frame-time tail');
    } else assert(ratio >= .9, before.name + ': stationary throughput regressed');
    comparison.phases.push({name: before.name, baseline: before.summary, candidate: after.summary, speedup: ratio});
  }
  comparison.pass = true;
} catch (error) {comparison.error = error.stack; process.exitCode = 1;}
fs.writeFileSync(path.join(__dirname, 'results/villa-vsm-motion-comparison.json'), JSON.stringify(comparison, null, 2));
console.log(JSON.stringify(comparison));
