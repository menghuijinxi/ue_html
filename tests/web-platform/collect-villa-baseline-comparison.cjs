'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const verify = item => assert.equal(audit(item.file).sha256, item.sha256, item.file);
const name = 'villa-baseline-comparison-20261111', output = path.join(__dirname, 'evidence', name);
fs.mkdirSync(output, {recursive: true});
const artifacts = [], seen = new Set();
function archive(file) {
  file = path.resolve(file); if (seen.has(file)) return; seen.add(file);
  const bytes = fs.readFileSync(file), zipped = zlib.gzipSync(bytes, {level: 9});
  assert(zlib.gunzipSync(zipped).equals(bytes));
  const target = path.join(output, `${artifacts.length}-${path.basename(file)}.gz`);
  fs.writeFileSync(target, zipped);
  artifacts.push({original: audit(file), archive: audit(target), encoding: 'gzip'});
}
const currentFile = path.join(__dirname, 'results/nanite-fallback-baseline-20261111/report.json');
const legacyFile = path.join(__dirname, 'results/villa-legacy-baseline-20261111/report.json');
const current = read(currentFile), legacy = read(legacyFile);
const names = ['spawn-720', 'spawn-1440', 'room-1440', 'room-720', 'wall-720', 'wall-1440'];
const comparisons = [];
for (const [file, report] of [[currentFile, current], [legacyFile, legacy]]) {
  assert(report.pass); assert.deepEqual(report.errors, []); verify(report.source);
  assert.equal(report.dpr, 1); assert(report.headless);
  assert.deepEqual(report.samples.map(s => s.name), names);
  for (const sample of report.samples) {
    assert(sample.frames > 0 && sample.milliseconds >= 20000);
    assert.equal(sample.frames, sample.after.stages.presented - sample.before.stages.presented);
    assert.equal(sample.fps, sample.frames * 1000 / sample.milliseconds);
    for (const state of [sample.before, sample.after]) {
      assert(!state.failure && !state.clock?.materialTimeFrozen && !state.clock?.renderTimeFrozen);
      assert.deepEqual(state.settings, report.samples[0].before.settings);
    }
    archive(path.join(path.dirname(file), sample.name + '.png'));
  }
  archive(file); archive(report.source.file); archive(path.join(path.dirname(file), 'browser.log'));
}
assert.equal(current.browserVersion, legacy.browserVersion);
assert.equal(legacy.url, 'http://127.0.0.1:8765/build/villa-default-20261107/index.html');
assert.equal(current.url, 'http://127.0.0.1:8766/villa/index.html');
assert.deepEqual(current.nanite.map(s => [s.step, s.enabled, s.registered]), [[1, true, 2062], [2, false, 0]]);
assert.equal(current.nanite[1].entries, 0);
for (const state of current.nanite) { verify(state.report); archive(state.report.file); }
verify(current.manifest);
const manifest = read(current.manifest.file), release = path.dirname(current.manifest.file);
assert(manifest.pass);
for (const product of manifest.products) {
  const file = path.join(release, product.path);
  assert.equal(fs.statSync(file).size, product.bytes); assert.equal(audit(file).sha256, product.sha256);
}
legacy.assets.forEach(verify);
archive(current.manifest.file);
for (const file of ['index.html', 'config-files.json', 'asset-versions.json']) {
  archive(path.join(release, 'villa', file));
  archive(path.join(__dirname, 'build/villa-default-20261107', file));
}
for (let i = 0; i < names.length; ++i) {
  const a = legacy.samples[i], b = current.samples[i];
  // Compare the observed camera, not just the requested position.
  assert.deepEqual(a.before.camera, b.before.camera);
  for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
    assert.equal(a.before.view[key], b.before.view[key], key);
  // The November 7 runtime predates three diagnostics. Missing telemetry is
  // not evidence of the same VT/VSM implementation; retain that boundary.
  const legacyKeys = Object.keys(a.before.settings);
  for (const key of legacyKeys) assert.equal(a.before.settings[key], b.before.settings[key], key);
  const unavailableInLegacy = Object.keys(b.before.settings).filter(k => !legacyKeys.includes(k));
  assert.deepEqual(unavailableInLegacy.sort(), ['virtualShadowPathActive', 'virtualTexturePathActive', 'virtualTextures']);
  comparisons.push({name: names[i], legacyFPS: a.fps, currentFallbackFPS: b.fps,
    legacyRhiMs: a.rhiMs, currentFallbackRhiMs: b.rhiMs, camera: a.before.camera,
    internalResolution: [a.before.view.width, a.before.view.height],
    outputResolution: [a.before.view.outputWidth, a.before.view.outputHeight],
    matchingPublishedSettingKeys: legacyKeys, unavailableInLegacy});
}
const historicalFile = path.join(__dirname, 'evidence/nanite-raster-batch-20261111.json');
const historical = read(historicalFile);
const recorded = historical.artifacts.find(a => a.original.file.endsWith('cpu-nanite-core-fallback-20261111.json'));
verify(recorded.archive);
const oldBytes = zlib.gunzipSync(fs.readFileSync(recorded.archive.file));
const oldProfile = JSON.parse(oldBytes);
assert(oldProfile.pass && oldProfile.width === 1280 && oldProfile.height === 720 && !oldProfile.nanite.enabled);
archive(historicalFile); archive(recorded.archive.file);
const previousFile = path.join(__dirname, 'evidence/nanite-user-performance-20261111.json');
const previous = read(previousFile); assert(previous.pass && previous.performanceAccepted === false);
assert.equal(previous.manifest.sha256, current.manifest.sha256);
archive(previousFile);
archive(path.join(path.dirname(legacyFile), 'collector-missing-settings-field-failure.cjs'));
archive(__filename);
const report = {pass: true, nanitePerformanceAccepted: false, date: new Date().toISOString(), source: audit(__filename),
  legacy: {url: legacy.url, report: audit(legacyFile), assets: legacy.assets},
  current: {url: current.url, report: audit(currentFile), manifest: current.manifest},
  browserVersion: current.browserVersion, comparisons,
  historicalFixedViewFPS: oldProfile.samples.map(s => s.baseline.fps),
  previousCurrentSpawn1440FallbackFPS: previous.samples.find(s => s.name === '1440-nanite-off').fps,
  artifacts,
  boundary: 'Diagnostic comparison, not a Nanite performance acceptance. The user-specified November 7 '
    + 'ordinary-mesh release and current Nanite-disabled release run serially in isolated Edge processes. '
    + 'Observed cameras, internal/output resolutions, AA and all 14 common published renderer settings match. '
    + 'The old runtime does not publish virtualTextures, virtualTexturePathActive or virtualShadowPathActive; '
    + 'no equality of those implementations is claimed. The initial collector incorrectly required those absent fields; its source is retained. '
    + 'Runtime and cooked geometry differ. This neither isolates a single regression nor explains the '
    + 'earlier 54.85 FPS sample; that raw evidence remains intact. Do not use that sample as the old-version baseline.'};
fs.writeFileSync(path.join(__dirname, 'evidence', name + '.json'), JSON.stringify(report, null, 2) + '\n');
console.log({pass: true, artifacts: artifacts.length, comparisons});
