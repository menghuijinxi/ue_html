'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag'), folder = option('package');
const names = process.argv.slice(2).filter(value => !value.startsWith('--'));
const excluded = (option('excluded') || '').split(',').filter(Boolean);
assert([tag, folder, ...names, ...excluded].every(value => value && /^[a-z0-9-]+$/.test(value)));
const output = path.join(__dirname, 'evidence', tag + '.json');
assert(names.length && !fs.existsSync(output));
const load = name => {
  const file = path.join(__dirname, 'results', name + '.json');
  return {file, value: JSON.parse(fs.readFileSync(file, 'utf8'))};
};
const captures = names.map(name => {
  const {file, value: report} = load(name);
  assert(report.pass && report.runs.every(run => run.pass && !run.errors.length));
  assert.equal(audit(report.capturedSource.file).sha256, report.source.sha256);
  for (const item of report.files) assert.equal(audit(item.file).sha256, item.sha256);
  const analysisFile = file.replace(/\.json$/, '-pipeline-analysis.json');
  const analysis = report.pipeline ? JSON.parse(fs.readFileSync(analysisFile, 'utf8')) : undefined;
  if (analysis) assert.equal(analysis.capture.sha256, audit(file).sha256);
  const compositorFile = file.replace(/\.json$/, '-compositor-analysis.json');
  const compositor = report.chromeTrace ? JSON.parse(fs.readFileSync(compositorFile, 'utf8')) : undefined;
  if (compositor) assert.equal(compositor.capture.sha256, audit(file).sha256);
  return {capture: audit(file), capturedSource: report.capturedSource, files: report.files,
    folder: report.folder, profile: report.profile, width: report.width, height: report.height, scale: report.scale,
    duration: report.duration, pipeline: !!report.pipeline, chromeTrace: !!report.chromeTrace,
    packagedInput: !!report.packagedInput, defaultSettings: !!report.defaultSettings, inputMode: report.inputMode,
    analysis: analysis && {file: audit(analysisFile), runs: analysis.runs},
    compositor: compositor && {file: audit(compositorFile), runs: compositor.runs, boundary: compositor.boundary},
    runs: report.runs.map(run => {
      assert(run.travel > 10 && run.turn > 30);
      if (run.mode.startsWith('pipeline')) assert(run.after.budget.peak <= run.after.budget.maxAhead);
      return {mode: run.mode, url: run.url, result: run.result, display: run.display,
        camera: {travelCm: run.travel, turnDegrees: run.turn, inputEvents: run.motion.events},
        view: run.before.view, settings: run.before.settings, workload: run.workload, rhiMs: run.rhiMs,
        budget: run.after.budget, visibility: run.visibility, inputBridge: run.inputBridge, trace: run.trace};
    })};
});
const normal = captures.filter(capture => !capture.pipeline && !capture.chromeTrace);
const abba = normal.find(capture =>
  capture.runs.map(run => run.mode).join(',') === 'local4,pipeline3,pipeline3,local4');
assert(abba, 'Require a moving ABBA comparison without detailed diagnostic wrappers');
const oldRuns = abba.runs.filter(run => run.mode === 'local4');
const newRuns = abba.runs.filter(run => run.mode === 'pipeline3');
assert(newRuns.every(run => run.result.p95 < Math.min(...oldRuns.map(old => old.result.p95)) &&
  run.result.low1Fps > Math.max(...oldRuns.map(old => old.result.low1Fps)) &&
  run.visibility?.resumed > run.visibility?.paused), 'Moving frame consistency and resume must improve twice');
const {file: packageFile, value: info} = load(folder + '-package');
assert(info.pass && info.budgetMode === 'pipeline' && info.defaultAhead === 3);
for (const item of info.products) assert.equal(audit(item.file).sha256, item.sha256);
const failures = excluded.map(name => {
  const {file, value} = load(name); assert(!value.pass);
  return {capture: audit(file), folder: value.folder, pipeline: !!value.pipeline, chromeTrace: !!value.chromeTrace,
    inputMode: value.inputMode, failure: value.failure, startupFailure: value.startup?.failure,
    runs: value.runs.map(run => ({mode: run.mode, errors: run.errors, measured: !!run.result}))};
});
const sources = ['web-engine-host.js', 'web-engine-worker.js', 'probe-web-local-clock-motion.cjs',
  'web-local-pipeline-observer.cjs', 'analyze-web-local-pipeline.cjs', 'analyze-web-compositor-motion.cjs', 'verify-web-pipeline-budget.cjs',
  'verify-web-local-frame-budget.cjs', 'verify-web-input-bridge.cjs', 'package-web-local-frame-budget.cjs',
  'summarize-web-pipeline-budget.cjs'].map(name => audit(path.join(__dirname, name)));
sources.push(audit(path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js')));
const report = {pass: true, date: new Date().toISOString(), sources, captures, excluded: failures,
  package: {report: audit(packageFile), folder, defaultAhead: info.defaultAhead, budgetMode: info.budgetMode,
    products: info.products, sources: info.sources},
  packagedDefaultPassed: normal.some(capture => capture.folder === folder && capture.defaultSettings),
  boundary: 'One machine, moving synthetic mouse/keyboard input, varying actual camera paths. Submission timing and rAF-observed progress are not physical display FPS. Detailed GPU/input diagnostics are separate from normal timing. GPU feedback includes callback delivery. Synthetic visibility events do not validate OS tab freezing. Startup failures are excluded explicitly; cross-device acceptance remains open.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, captures: captures.length, packagedDefaultPassed: report.packagedDefaultPassed}));
