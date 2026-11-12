'use strict';
const {assertProjectOutput, initializeProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const {readPage} = require('../web-pipeline-prewarm-package.cjs');
const {PNG} = require('pngjs');
const {execFileSync} = require('node:child_process');
const base = path.resolve(__dirname, '..');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const inputs = {};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const result = name => {
  const tag = option(name); assert(tag && /^[a-z0-9-]+$/.test(tag));
  const file = path.join(base, 'results', tag, 'result.json');
  inputs[name] = audit(file);
  const report = read(file); assert(report.pass, name);
  return report;
};
const benchmark = result('benchmark'), control = result('control'), candidate = result('candidate');
const verification = result('release');
const repeat = option('repeat') ? result('repeat') : null;
const recoveryFile = path.join(base, 'results/tsr-package-recovery-20261112.json');
const recovery = fs.existsSync(recoveryFile) ? read(recoveryFile) : null;
if (recovery) {
  assert(recovery.pass);
  inputs.recovery = audit(recoveryFile);
  assert.equal(recovery.originalManifest.sha256, benchmark.package.sha256);
  assert.equal(audit(recovery.recoveredManifest.file).sha256, recovery.recoveredManifest.sha256);
  for (const item of recovery.products) assert.equal(audit(item.file).sha256, item.sha256);
}
function samePackage(report) {
  assert([benchmark.package.sha256, recovery?.recoveredManifest.sha256].includes(report.package.sha256),
    'Use the measured package or its byte-identical recovery');
}
assert.equal(benchmark.setting, 'r.WebGPU.TSRLargeTiles');
assert.deepEqual(benchmark.order, [0, 1, 1, 0]);
if (repeat) {
  assert.equal(repeat.setting, benchmark.setting);
  samePackage(repeat);
  assert.deepEqual(repeat.order, [1, 0, 0, 1]);
}
for (const report of [control, candidate, verification])
  samePackage(report);
assert(verification.runs.every(r => r.pass && r.distance > 10 && r.yaw > 5 && !r.errors.length));
assert.deepEqual(verification.runs.map(r => r.dpr), [1.5, 1]);
for (const [report, workgroup] of [[control, '256u, 1u, 1u'], [candidate, '1024u, 1u, 1u']]) {
  assert(!report.errors.length && !report.gpuErrors.length);
  assert(report.tsrDispatches.length > 0 && report.tsrDispatches.every(s => s.workgroup === workgroup));
}
const fallbacks = ['fallback-invocations', 'fallback-x', 'fallback-storage'].map(name => {
  const report = result(name);
  samePackage(report);
  assert(!report.errors.length && !report.gpuErrors.length && report.tsrTiles === '1');
  assert(report.tsrDispatches.length > 0 && report.tsrDispatches.every(s => s.workgroup === '256u, 1u, 1u'));
  return {name, limits: report.phases[0].after.limits, dispatches: report.tsrDispatches,
    boundary: 'RHI capability-report fixture on a physical high-limit device; recorded prewarm was not replayed. Other existing shaders still require 1024 threads.'};
});
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const runs = [benchmark, ...(repeat ? [repeat] : [])].flatMap(r => r.runs);
const performance = benchmark.comparisons.map(c => {
  const summarize = mode => {
    const phases = runs.filter(r => r.mode === mode).map(r => r.phases.find(p => p.name === c.name));
    const times = phases.flatMap(p => p.capture.times.slice(1).map((t, i) => t - p.capture.times[i]));
    assert(times.length >= 1000 && times.every(t => t > 0));
    assert(phases.every(p => !p.capture.creations.length &&
      p.before.prewarm.counts.misses === p.after.prewarm.counts.misses));
    const sorted = times.toSorted((a, b) => a - b), slow = sorted.slice(-Math.ceil(sorted.length * .01));
    return {mode, runs: phases.map(p => p.summary), frames: times.length,
      fps: 1000 / mean(times), low1Fps: 1000 / mean(slow), p99Ms: sorted[Math.floor(sorted.length * .99)]};
  };
  const before = summarize(0), after = summarize(1);
  return {phase: c.name, before, after, fpsChangePercent: (after.fps / before.fps - 1) * 100,
    low1ChangePercent: (after.low1Fps / before.low1Fps - 1) * 100};
});
const catalog = [control, candidate].map(report =>
  read(path.join(path.dirname(report.source.file), 'compute-shaders.json')));
const images = [control, candidate].map(report => {
  const file = path.join(path.dirname(report.source.file), 'standing.png');
  return {audit: audit(file), pixels: PNG.sync.read(fs.readFileSync(file))};
});
assert(images.every(i => i.pixels.width === 1920 && i.pixels.height === 1200));
let pixels = 0, absoluteDifference = 0, over8 = 0;
for (let y = 60; y < 1140; ++y) for (let x = 0; x < 1920; ++x) {
  if (x < 390 && y < 440) continue;
  const offset = (y * 1920 + x) * 4;
  let difference = 0;
  for (let c = 0; c < 3; ++c)
    difference += Math.abs(images[0].pixels.data[offset + c] - images[1].pixels.data[offset + c]) / 3;
  ++pixels; absoluteDifference += difference; over8 += difference > 8;
}
const visual = {images: images.map(i => i.audit), pixels, meanAbsChannelDifference: absoluteDifference / pixels,
  fractionOver8: over8 / pixels, boundary: 'Same camera after route warmup; letterbox and live HUD excluded. Scene time, temporal history and stochastic noise are not pixel-identical. This is a coarse image regression check plus manual inspection, not a guarantee for all views.'};
assert(visual.meanAbsChannelDifference < 3 && visual.fractionOver8 < .03, 'Large image regression');
const names = read(path.join(base, 'evidence/vsm-remaining-costs-20261111.json')).shaderNames;
const gpu = control.phases.map((p, phaseIndex) => {
  const pair = [p, candidate.phases[phaseIndex]];
  assert.equal(pair[0].name, pair[1].name);
  assert.deepEqual(pair[0].before.settings, pair[1].before.settings);
  if (p.name === 'standing') assert.deepEqual(pair[0].before.camera, pair[1].before.camera);
  const passes = ['FTSRRejectShadingCS', 'FTSRUpdateHistoryCS', 'FScreenProbeTraceVoxelsCS',
    'FReflectionTraceVoxelsCS', 'FLumenRadiosityDistanceFieldTracingCS'].map(name => {
    const times = pair.map((phase, i) => mean(phase.gpuFrames.map(frame =>
      frame.entries.filter(e => name === 'FTSRRejectShadingCS' ?
        catalog[i][e.pipeline]?.includes('WebTSRAnyThreadResult') : names[e.pipeline]?.name === name)
        .reduce((n, e) => n + e.gpuMs, 0))));
    return {name, beforeMs: times[0], afterMs: times[1],
      changePercent: times[0] ? (times[1] / times[0] - 1) * 100 : null};
  });
  assert(passes[0].beforeMs > 0 && passes[0].afterMs > 0);
  return {phase: p.name, framesPerVariant: pair.map(p => p.gpuFrames.length), passes};
});
const page = readPage(path.join(base, 'build', benchmark.folder));
const packageReport = read(path.join(base, 'results/web-project-triplex-virtual-distance-fields-threads-package-results.json'));
assert(packageReport.pass && packageReport.releaseDefaults.releaseReady);
assert.equal(path.basename(packageReport.output), benchmark.folder);
assert(page.assets.pipelinePrewarm && !page.args.includes('-WebPSOPrecacheTest'));
assert.equal(audit(benchmark.package.file).sha256, recovery?.recoveredManifest.sha256 || benchmark.package.sha256);
const report = {date: new Date().toISOString(), pass: true, package: recovery?.recoveredManifest || benchmark.package,
  referenceEngineCommit: execFileSync('git', ['-C', path.resolve(base, '../../reference-engine'),
    'rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true}).trim(),
  packageReport: audit(path.join(base, 'results/web-project-triplex-virtual-distance-fields-threads-package-results.json')),
  sources: [__filename, path.join(base, 'web-tsr-shader-overrides.cjs'), path.join(base, 'cached-cook-validation.cjs'),
    path.join(base, 'verify-web-tsr-cook-policy.cjs'), path.join(base, 'project-output.cjs'),
    path.resolve(base, '../../reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp'),
    path.resolve(base, '../../tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp')].map(audit),
  inputs, performance, gpu, visual, fallbacks,
  startupFailures: [
    'villa-startup-auto-prewarm-522a1c84-860a-436c-a58b-0f0e0883bf49',
    'tsr-tiles-fallback-x-20261112', 'tsr-tiles-fallback-storage-20261112'
  ].map(tag => {
    const file = path.join(base, 'results', tag, 'result.json'), r = read(file);
    assert(!r.pass);
    return {input: audit(file), excluded: 'Failed during startup before any valid timed window',
      failure: r.error || r.runs?.[0]?.failure || r.runs?.[0]?.after?.failure};
  }),
  boundary: 'GPU attribution splits compute passes; FPS and 1% Low use separate ABBA windows with normal pass reuse and no pipeline creation. Lumen settings, TSR quality, resolution and the first three accepted VSM optimizations remain active. Masked device tests prove shader/dispatch selection, not low-capability prewarm portability.'};
const output = assertProjectOutput(path.join(base, 'evidence/lumen-tsr-hotspots-20261112.json'));
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, performance: performance.map(p => ({phase: p.phase,
  beforeFps: p.before.fps, afterFps: p.after.fps, beforeLow: p.before.low1Fps,
  afterLow: p.after.low1Fps})), gpu}));
