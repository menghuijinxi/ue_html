'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const results = path.join(__dirname, 'results');
const read = name => {
  const file = path.join(results, name + '.json');
  return {...JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), provenance: audit(file)};
};
const control = read('web-browser-lifecycle-msedge-fix-control-isolated-20261104-results');
const returned = read('web-browser-lifecycle-msedge-fix-control-return-20261104-results');
const compiler = [
  read('web-browser-lifecycle-msedge-fix-hlsl2018-20261104-results'),
  read('web-browser-lifecycle-msedge-fix-hlsl2018-repeat-20261104-results')
];
const gameplay = read('project-gameplay-fix-hlsl2018-gameplay-20261104');
const replay = read('crash-replay-full-async-20261104');
const preview = read('compat-preview-verified-20261104');
const launch = read('preview-20261104-144426-34424');
assert.equal(control.pass, false);
assert.match(control.failure, /WebGPU device lost/);
assert(returned.pass && compiler.every(r => r.pass) && gameplay.pass && replay.pass && preview.pass);
assert.equal(replay.result.successful, 420);
assert.equal(preview.samples.length, 3);
assert(launch.affinityChecks.some(p => p.type === 'gpu-process' && p.affinityMask === '0xffff0000'));
for (const report of [control, returned, ...compiler, gameplay, preview])
  assert.deepEqual(report.settingsOverrides, []);
const report = {
  recordedAt: new Date().toISOString(),
  status: 'Temporary isolated-browser workaround verified; default browser root cause unresolved.',
  source: audit(__filename),
  launcher: audit(path.join(__dirname, 'start-web-preview.ps1')),
  folder: control.folder,
  settingsChanged: false,
  pipelineReplay: {report: replay.provenance, requests: replay.result.successful,
    modules: replay.result.modules, failed: replay.result.failed,
    boundary: 'Async compilation completed without scene drawing; not a scene stability test.'},
  controls: [control, returned].map(r => ({report: r.provenance, pass: r.pass, runs: r.runs,
    failure: r.failure || null})),
  legacyHlslExperiment: {
    argument: '--disable-dawn-features=d3d12_use_hlsl_2021',
    lifecycles: compiler.map(r => ({report: r.provenance, runs: r.runs, pass: r.pass})),
    gameplay: {report: gameplay.provenance, pass: gameplay.pass, secondsPerRun: gameplay.seconds,
      runs: gameplay.runs.map(r => ({frames: r.samples.at(-1).frame, travelCm: r.maxTravelCm,
        turnDegrees: r.maxTurnDegrees, settings: r.samples.at(-1).settings}))},
    conclusion: 'Passing experiment only; returned default controls also passed. Not a confirmed repair.'
  },
  preview: {report: preview.provenance, launch: launch.provenance,
    affinityChecks: launch.affinityChecks, affinityMask: preview.affinityMask,
    legacyHlsl: preview.legacyHlsl, samples: preview.samples, errors: preview.errors,
    screenshot: audit(path.join(results, 'compat-preview-verified-20261104.png'))},
  boundary: 'Affinity changes cores and timing. It does not identify a hardware fault, certify long-term stability, or fix ordinary browser startup.'
};
const output = path.join(__dirname, 'evidence', 'villa-startup-compat-20261104.json');
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({output, status: report.status}));
