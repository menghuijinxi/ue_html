'use strict';
const {initializeProjectOutput, assertProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
const file = name => path.join(base, 'results', name + '.json');
const coverageFile = file('villa-pso-startup-check-20261113-b');
const routeFile = file('villa-pso-startup-route-20261113-c');
const coverage = JSON.parse(fs.readFileSync(coverageFile)), route = JSON.parse(fs.readFileSync(routeFile));
const relativeAudit = name => ({...audit(name), file: path.relative(path.resolve(base, '../..'), name).replaceAll('\\', '/')});
function summarize(run) {
  assert(run.startup && run.before && run.after, 'Require complete startup and route observations');
  const rhi = run.startup.rhi;
  return {mode: run.mode, functionalPass: run.pass, startupTo60FramesMs: run.startup.ms,
    downloadedBytes: run.before.io.downloadedBytes, prewarm: run.startup.prewarm,
    automatic: {requested: rhi.asyncPrecacheRequested, completed: rhi.asyncPrecacheCompleted,
      failed: rhi.asyncPrecacheFailed, usedGraphics: rhi.precachedGraphicsUsed},
    newPipelines: run.newCalls.filter(call => call.name.includes('Pipeline')),
    failedPipelines: run.failedPipelines, errors: run.errors,
    view: run.startup.view, settings: run.startup.settings, route: run.route};
}
const startup = coverage.runs.map(summarize), manualRoute = route.runs.map(summarize);
assert(startup.filter(run => run.mode !== 'automatic').every(run => run.functionalPass));
assert(route.pass);
assert.equal(startup.find(run => run.mode === 'automatic').automatic.failed, 2);
const live = ['e', 'f', 'g'].map(suffix => {
  const name = file('villa-pso-live-20261113-' + suffix), data = JSON.parse(fs.readFileSync(name));
  assert(data.pass);
  return {source: relativeAudit(name), mode: data.initialMode, pass: data.pass, dpr: 1.5,
    distance: data.distance, yaw: data.yaw, exportURL: data.exportURL,
    forcedGC: data.forcedGC || 0, layouts: data.layouts.map(item => item.viewport)};
});
const report = {date: new Date().toISOString(), diagnosticOnly: true, formalReleaseApproved: false,
  sources: [relativeAudit(coverageFile), relativeAudit(routeFile)],
  originalPipelines: 311, manualPipelineSupplements: 0, defaultsChanged: false,
  startup, manualRoute, live,
  unresolved: [
    'Automatic component mode still uses the recorded global corpus; it is not capture-free automatic global coverage.',
    'Manual-route sampling still triggers two pipeline creations in component mode; sampled camera poses do not reproduce human frame pacing.',
    'One component live launch and one full-automatic probe lost the external WebGPU instance. Later live and forced-GC checks passed; the cause is unresolved.',
    'Full global automatic collection creates many unused candidates and has two sampled-texture/filtering-sampler validation failures.',
    'Warm browser/driver caches retained. No statistical performance claim or new UE 5.9 speed ranking.'
  ]};
const output = assertProjectOutput(path.join(base, 'evidence/pso-startup-overlap-20261113.json'));
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({output, functionalModes: startup.filter(run => run.functionalPass).map(run => run.mode),
  fullAutomaticApproved: false, liveChecks: live.length}));
