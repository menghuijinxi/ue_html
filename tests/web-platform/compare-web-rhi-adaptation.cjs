'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option('baseline') || 'triplex-project-distance-fields-threads';
const candidate = option('candidate') || 'villa-rhi-adaptation-candidate';
const tagPrefix = option('tag') || 'adaptation';
const warmupSeconds = Number(option('warmup-seconds') || 20);
assert(warmupSeconds >= 0 && warmupSeconds <= 120);
assert([baseline, candidate, tagPrefix].every(value => /^[a-z0-9-]+$/.test(value)));
const root = path.join(__dirname, 'build');
const report = {date: new Date().toISOString(), settingsOverrides: [], warmupSeconds,
  width: 1863, height: 1030, dpr: 1.25, order: ['baseline', 'candidate', 'candidate', 'baseline'],
  packages: {}, runs: [], pass: false};
const output = path.join(__dirname, 'results', tagPrefix + '-abba.json');
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
for (const [name, folder] of Object.entries({baseline, candidate})) {
  report.packages[name] = {folder, files: Object.fromEntries(['content.bin', 'config-files.json',
    'UEWebEngineThreads.wasm'].map(file => [file, audit(path.join(root, folder, file))]))};
}
for (const file of ['content.bin', 'config-files.json'])
  assert.equal(report.packages.baseline.files[file].sha256, report.packages.candidate.files[file].sha256);
(async () => {
  try {
    for (const [i, name] of report.order.entries()) {
      const tag = tagPrefix + '-abba-' + i + '-' + name;
      const code = await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.join(__dirname, 'capture-web-performance.cjs'),
          '--folder=' + report.packages[name].folder, '--tag=' + tag, '--width=1863', '--height=1030',
          '--dpr=1.25', '--baseline-only', '--baseline-seconds=15', '--warmup-seconds=' + warmupSeconds],
          {stdio: 'inherit', windowsHide: true});
        child.on('error', reject); child.on('close', resolve);
      });
      assert.equal(code, 0);
      const file = path.join(__dirname, 'results', 'performance-capture-' + tag + '.json');
      const value = JSON.parse(fs.readFileSync(file));
      assert(value.pass && value.cameraMode === 'original-spawn' && !value.errors.length);
      const view = value.before.view;
      const dimensions = [view.width, view.height, view.outputWidth, view.outputHeight, view.antiAliasing];
      if (report.runs.length) assert.deepEqual(dimensions, report.runs[0].dimensions);
      report.runs.push({name, file, dimensions, baseline: value.baseline, samples: value.baselineSamples});
      save();
    }
    report.fps = Object.fromEntries(['baseline', 'candidate'].map(name => {
      const runs = report.runs.filter(run => run.name === name);
      return [name, runs.reduce((s, r) => s + r.baseline.frames, 0) /
        runs.reduce((s, r) => s + r.baseline.milliseconds, 0) * 1000];
    }));
    report.improvementPercent = (report.fps.candidate / report.fps.baseline - 1) * 100;
    report.pass = true;
    console.log(JSON.stringify({pass: true, fps: report.fps, improvementPercent: report.improvementPercent, output}));
  } finally { save(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
