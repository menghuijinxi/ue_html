'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag'), inputs = process.argv.slice(2).filter(value => !value.startsWith('--'));
assert(tag && /^[a-z0-9-]+$/.test(tag) && inputs.length);
const output = path.join(__dirname, 'evidence', tag + '.json');
assert(!fs.existsSync(output));
const captures = inputs.map(name => {
  assert(/^[a-z0-9-]+$/.test(name));
  const file = path.join(__dirname, 'results', name + '.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(report.pass, 'Exclude failed/incomplete probes from acceptance: ' + name);
  return {report: audit(file), source: report.source, capturedSource: report.capturedSource,
    folder: report.folder, width: report.width, height: report.height, scale: report.scale,
    acceptanceThreshold: report.minVisibleRatio || 0,
    gpuProbe: !!report.gpuProbe, rhiWake: report.rhiWake || 'priority',
    runs: report.runs.map(run => {
      assert(run.pass && !run.errors.length && run.travel > 10 && run.turn > 30);
      const display = run.display || Object.fromEntries(['visual', 'submitted', 'refresh'].map(key =>
        [key, run.samples.reduce((sum, sample) => sum + sample.hud[key].fps, 0) / run.samples.length]));
      return {mode: run.mode, url: run.url, result: run.result, display,
        visibleRatio: display.visual / display.submitted, camera: {before: run.before.camera, after: run.after.camera,
          travelCm: run.travel, turnDegrees: run.turn, inputEvents: run.motion.events},
        view: run.before.view, settings: run.before.settings, workload: run.workload, rhiMs: run.rhiMs,
        gpu: run.gpuSummary, budget: run.after.budget, visibility: run.visibility,
        history: Object.fromEntries(['polls', 'ready', 'hits', 'expired', 'cameraRejected'].map(key =>
          [key, run.after.history[key] - run.before.history[key]]))};
    })};
});
const unbounded = captures.filter(c => !c.gpuProbe && c.rhiWake === 'priority')
  .flatMap(c => c.runs).filter(r => r.mode === 'local');
const accepted = captures.filter(c => c.acceptanceThreshold >= .65)
  .flatMap(c => c.runs).filter(r => r.mode === 'local4');
assert(unbounded.length >= 2 && unbounded.every(r => r.visibleRatio < .35), 'Original moving regression must reproduce');
assert(accepted.length >= 2 && accepted.every(r => r.visibleRatio >= .65 &&
  r.budget.peak <= 8 && r.visibility?.resumed > r.visibility?.paused), 'Bounded moving regression must pass twice');
const packages = [...new Set(captures.map(c => c.folder))]
  .filter(folder => folder.startsWith('villa-local-budget'))
  .map(folder => {
    const file = path.join(__dirname, 'results', folder + '-package.json');
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(info.pass);
    for (const product of info.products) assert.equal(audit(product.file).sha256, product.sha256);
    return {report: audit(file), folder, defaultAhead: info.defaultAhead, products: info.products};
  });
const sources = ['web-engine-worker.js', 'web-engine-host.js', 'probe-web-local-clock-motion.cjs',
  'verify-web-local-frame-budget.cjs', 'verify-web-input-bridge.cjs',
  'package-web-local-frame-budget.cjs', 'summarize-web-local-frame-budget.cjs'].map(name => audit(path.join(__dirname, name)));
sources.push(audit(path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js')));
const report = {pass: true, date: new Date().toISOString(), sources, captures, packages,
  boundary: 'Visible Edge on one machine, continuous synthetic mouse/keyboard movement. Page-observed FPS is the mean of rolling HUD samples, not physical display measurements. Equal input schedules do not guarantee identical camera paths or draw counts. GPU completion latency includes browser callback delivery. Visibility checks synthesize document visibility events; actual OS tab freezing and a second device remain unverified.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, captures: captures.length}));
