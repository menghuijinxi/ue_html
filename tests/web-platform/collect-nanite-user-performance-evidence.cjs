'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {audit} = require('./content-file-metadata.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const verify = entry => assert.equal(audit(entry.file).sha256, entry.sha256, entry.file);
const name = 'nanite-user-performance-20261111';
const directory = path.join(__dirname, 'evidence', name);
fs.mkdirSync(directory, {recursive: true});
const artifacts = [], seen = new Set();
function archive(file) {
  file = path.resolve(file);
  if (seen.has(file)) return;
  seen.add(file);
  const bytes = fs.readFileSync(file), compressed = zlib.gzipSync(bytes, {level: 9});
  assert(zlib.gunzipSync(compressed).equals(bytes));
  const target = path.join(directory, `${artifacts.length}-${path.basename(file)}.gz`);
  fs.writeFileSync(target, compressed);
  artifacts.push({original: audit(file), archive: audit(target), encoding: 'gzip'});
}
const reportFile = path.join(__dirname, 'results', name, 'report.json');
const report = read(reportFile);
assert(report.pass); assert.deepEqual(report.errors, []);
assert.equal(report.url, 'http://127.0.0.1:8766/villa/index.html');
verify(report.source); verify(report.manifest);
const manifest = read(report.manifest.file), release = path.dirname(report.manifest.file);
assert(manifest.pass);
for (const product of manifest.products) {
  const file = path.join(release, product.path);
  assert.equal(fs.statSync(file).size, product.bytes);
  assert.equal(audit(file).sha256, product.sha256, product.path);
}
assert(!report.clock?.renderTimeFrozen && !report.clock?.materialTimeFrozen);
assert.deepEqual(report.samples.map(s => s.name), [
  '1440-normal', '720-normal', '1440-nanite-on', '1440-nanite-off', '1440-nanite-restored']);
const baseline = report.samples[0];
for (const sample of report.samples) {
  assert(sample.milliseconds >= 20000 && sample.frames > 0);
  assert.equal(sample.frames, sample.after.stages.presented - sample.before.stages.presented);
  assert.equal(sample.fps, sample.frames * 1000 / sample.milliseconds);
  for (const endpoint of [sample.before, sample.after]) {
    assert(!endpoint.failure); assert.equal(endpoint.visible, 'visible');
    assert.deepEqual(endpoint.camera, baseline.after.camera);
    assert.deepEqual(endpoint.settings, baseline.after.settings);
    const small = sample.name === '720-normal';
    assert.equal(endpoint.view.outputWidth, small ? 1280 : 2560);
    assert.equal(endpoint.view.outputHeight, small ? 720 : 1440);
  }
  archive(path.join(path.dirname(reportFile), sample.name + '.png'));
}
assert.deepEqual(report.nanite.map(n => n.step), [1, 2, 3]);
for (const state of report.nanite) {
  verify(state.report);
  const raw = read(state.report.file), enabled = state.step !== 2;
  assert.equal(raw.enabled, enabled); assert.equal(state.enabled, enabled);
  assert.equal(raw.registered, enabled ? 2062 : 0);
  assert.equal(raw.entries, enabled ? 606 : 0);
  if (enabled) assert.equal(raw.materialDraws, 149);
  archive(state.report.file);
}
const [normal, small, on, off, restored] = report.samples;
assert(normal.fps < 10 && small.fps < 11, 'Recorded low frame rate must be reproduced');
assert(off.fps > on.fps * 5 && off.fps > restored.fps * 5, 'Nanite on/off/on causal comparison');
archive(reportFile); archive(report.source.file); archive(report.manifest.file);
archive(path.join(path.dirname(reportFile), 'browser.log'));

const cpuFile = path.join(__dirname, 'results/cpu-nanite-user-spawn-20261111.json');
const cpu = read(cpuFile);
assert(cpu.pass); assert.deepEqual(cpu.errors, []); assert.deepEqual(cpu.settingsOverrides, []);
assert.equal(cpu.cameraMode, 'original-spawn'); assert.equal(cpu.samples.length, 1);
verify(cpu.source); verify(cpu.package);
assert.equal(cpu.package.sha256, manifest.packages.villa.sha256);
const sourcePackage = read(cpu.package.file);
assert(sourcePackage.pass); sourcePackage.products.forEach(verify);
const profileBase = cpuFile.slice(0, -5);
const profile = read(profileBase + '-0.cpuprofile');
assert.equal(profile.samples.length, profile.timeDeltas.length);
assert(!cpu.visualClock?.renderTimeFrozen && !cpu.visualClock?.materialTimeFrozen);
assert.deepEqual(cpu.plainSamples.map(s => s.label), ['before-profiler', 'after-profiler-disabled']);
for (const sample of cpu.plainSamples) assert(sample.fps < 10);
assert.deepEqual(cpu.samples[0].before.calls, {}); // No WebGPU method wrappers.
const nodes = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map();
profile.samples.forEach((id, i) => {
  const key = nodes.get(id).callFrame.functionName;
  self.set(key, (self.get(key) || 0) + profile.timeDeltas[i] / 1000);
});
const selfTime = [...self].map(([name, milliseconds]) => ({name, milliseconds}))
  .sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 20);
for (const suffix of ['.json', '.log', '-0.cpuprofile', '-0.png']) archive(profileBase + suffix);
archive(cpu.source.file); archive(cpu.package.file);
for (const file of [
  '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp',
  '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
  '../../reference-engine/Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebScene.cpp',
  '../../reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderingThread.cpp'
]) archive(path.resolve(__dirname, file));
archive(__filename);
const evidence = {
  pass: true, performanceAccepted: false, failureReproduced: true, date: new Date().toISOString(),
  source: audit(__filename), manifest: report.manifest,
  samples: report.samples.map(s => ({name: s.name, frames: s.frames, milliseconds: s.milliseconds,
    fps: s.fps, rhiMillisecondsPerFrame: s.stageMsPerFrame.rhiWorkMilliseconds})),
  nanite: report.nanite, normalCamera: baseline.after.camera,
  cpu: {report: audit(cpuFile), plainSamples: cpu.plainSamples.map(s => ({label: s.label, fps: s.fps, rhiMs: s.rhiMs})),
    profiledFps: cpu.samples[0].fps, baseline: cpu.samples[0].baseline, selfTime},
  artifacts,
  boundary: 'pass means evidence integrity and successful reproduction, NOT acceptable performance. '
    + 'Normal Villa spawn in an isolated headless Edge process, unchanged delivered files and advancing clocks. '
    + 'Five 20-second present-count windows follow ten-second settling periods; no CPU profiler or GPU method wrappers during those windows. '
    + 'The last three windows use the same settled scene observer for native r.Nanite on/off/on. '
    + 'Independent RHI-worker profiling identifies CPU binding/submission overhead but does not attribute all frame latency or measure GPU duration. '
    + 'The initial unsampled window also reproduces single-digit FPS. Prior fixed-view results do not close entrance performance acceptance.'
};
const output = path.join(__dirname, 'evidence', name + '.json');
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log({pass: true, performanceAccepted: false, artifacts: artifacts.length, output, samples: evidence.samples});
