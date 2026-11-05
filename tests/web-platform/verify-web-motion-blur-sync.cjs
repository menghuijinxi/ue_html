'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const fingerprint = file => ({...audit(path.join(root, file)), file});
const result = tag => 'tests/web-platform/results/motion-blur-inputs-20261105-' + tag + '.json';
const option = name => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const candidate = option('candidate');
const stable = report => {
  assert(report.pass);
  for (const run of report.runs) {
    assert.equal(run.settings.gi, 1);
    assert.equal(run.settings.reflections, 1);
    assert.equal(run.settings.antiAliasing, 4);
    assert.deepEqual([run.errors, run.probe.errors, run.probe.losses], [[], [], []]);
    assert(run.probe.samples.length >= 100);
    assert(run.probe.samples.every(sample => sample.globals.VelocityScale[0] <= 500),
      'Regression: short-frame motion-blur scale spikes remain');
  }
};
if (candidate) {
  stable(read(candidate));
  console.log('PASS: candidate excludes the reproduced scale-spike signature');
  process.exit(0);
}
const captures = ['cpu-r4', 'cpu-sync-r1', 'cpu-r5', 'cpu-sync-r2'].map(tag => {
  const file = result(tag), report = read(file), analysisFile = file.replace('.json', '-cpu-analysis.json');
  const analysis = read(analysisFile);
  assert(report.pass && analysis.pass);
  assert.equal(analysis.input.sha256, fingerprint(file).sha256);
  const measured = analysis.runs[0], run = report.runs[0], sync = tag.includes('sync');
  assert.equal(measured.uniformsMatched, run.probe.samples.length);
  assert.equal(measured.targetFPS, 30);
  assert.equal(measured.amount, 0.5);
  if (sync) {
    stable(report);
    assert.equal(measured.intervalsUnder8ms, 0);
    assert.equal(measured.movingScaleOver500, 0);
    assert.equal(measured.radiusProxyOver20px, 0);
  } else {
    assert(measured.intervalsUnder8ms > 0);
    assert(measured.movingScaleOver500 > 0);
    assert(measured.scales.maxScaleX > 1000);
  }
  return {report: fingerprint(file), analysis: fingerprint(analysisFile),
    probeAtCapture: report.source, settingLogs: run.settingLogs, ...measured};
});
const previewFile = result('frame-sync-preview'), preview = read(previewFile);
stable(preview);
assert(preview.runs[0].settingLogs.some(v => v.includes('r.OneFrameThreadLag:0')));
const packageFile = 'tests/web-platform/results/motion-blur-ab-20261105-package.json';
const packaged = read(packageFile);
assert(packaged.pass && packaged.cases.length === 1);
const entry = packaged.cases[0];
assert.deepEqual(entry.settings, {'r.OneFrameThreadLag': 0});
assert.equal(entry.folder, preview.runs[0].folder);
const directory = 'tests/web-platform/build/' + entry.folder + '/';
const baseline = 'tests/web-platform/build/' + packaged.baseline + '/';
const versions = read(baseline + 'asset-versions.json');
const mutable = new Set(['index.html', 'config-files.json', 'asset-versions.json']);
for (const product of entry.products) {
  const name = path.basename(product.file);
  assert.equal(audit(product.file).sha256, product.sha256);
  if (!mutable.has(name)) assert.equal(product.sha256, versions[name].sha256);
}
const configs = read(directory + 'config-files.json'), oldConfigs = read(baseline + 'config-files.json');
assert.equal(configs.length, oldConfigs.length);
for (let i = 0; i < configs.length; ++i) {
  const value = configs[i], previous = oldConfigs[i];
  assert.equal(value.path, previous.path);
  if (!value.path.endsWith('/Platforms/Web/Config/WebEngine.ini')) {
    assert.deepEqual(value, previous);
    continue;
  }
  const bytes = Buffer.from(value.data, 'base64');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), value.sha256);
  assert.equal(bytes.toString('utf8'), Buffer.from(previous.data, 'base64').toString('utf8') +
    '\n[SystemSettings]\nr.OneFrameThreadLag=0\n');
}
const buildFile = 'tests/web-platform/results/motion-blur-cpu-20261105-build.json', build = read(buildFile);
assert(build.pass && build.fullLinkAttempted && build.wasmValidated);
const finalSamples = captures.reduce((sum, value) => sum + value.uniformsMatched, 0) +
  preview.runs[0].probe.samples.length;
assert.equal(finalSamples, 1079);
const sources = ['build-web-engine.ps1', 'prepare-web-core-host.ps1', 'package-web-game-clock.cjs',
  'package-web-motion-blur-ab.cjs', 'probe-web-motion-blur-inputs.cjs', 'web-game-clock-observer.cjs',
  'analyze-web-motion-blur-cpu.cjs', 'verify-web-motion-blur-cpu.cjs', 'verify-web-motion-blur-sync.cjs']
  .map(name => fingerprint('tests/web-platform/' + name));
sources.push(fingerprint('reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp'));
const evidence = JSON.parse(JSON.stringify({
  date: '2026-11-05', automatedChecksPassed: true, manualVisualAcceptance: 'pending',
  referenceEngineCommit: execFileSync('git', ['rev-parse', 'HEAD'],
    {cwd: path.join(root, 'reference-engine'), encoding: 'utf8', windowsHide: true}).trim(),
  finalSamples, sources, build: fingerprint(buildFile), captures,
  preview: {report: fingerprint(previewFile), packageReport: fingerprint(packageFile),
    folder: entry.folder, url: entry.url, settings: preview.runs[0].settings,
    settingLogs: preview.runs[0].settingLogs, scale: preview.runs[0].summary,
    changedConfig: entry.settings, unchangedWasmAndRuntimeAndCookVerified: true},
  excluded: ['cpu-r1', 'cpu-r2', 'cpu-r3'].map(tag => ({report: fingerprint(result(tag)),
    reason: 'Diagnostic transport failed before complete capture; excluded from conclusion.'})),
  conclusion: 'CPU parameters and camera history match uploaded frames. Disabling one-frame thread lag removed the reproduced short-frame/scale-spike signature in two native diagnostic runs and an original-WASM preview.',
  boundary: 'No frame-rate cap, time manipulation, blur clamp or disabled Lumen/motion blur. Does not prove perceived shake fixed; manual acceptance pending. Fixed-depth camera-radius proxy is not GPU texture or final-image readback. Full synchronization reduces CPU pipeline overlap and may affect throughput. Long frames remain.',
}));
const destination = 'tests/web-platform/evidence/motion-blur-frame-sync-20261105.json';
if (process.argv.includes('--write')) {
  assert(!fs.existsSync(path.join(root, destination)), 'Preserve existing evidence');
  fs.writeFileSync(path.join(root, destination), JSON.stringify(evidence, null, 2) + '\n');
} else assert.deepEqual(read(destination), evidence);
console.log(JSON.stringify({pass: true, finalSamples, preview: entry.url}));
