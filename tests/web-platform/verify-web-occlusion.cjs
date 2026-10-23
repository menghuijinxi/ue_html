const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  reports: [], browsers: [], editorVisualParityVerified: false, totalVRAMBudgetVerified: false};
const checked = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) {
    const file = path.resolve(value.file);
    if (!checked.has(file)) checked.set(file, audit(file).sha256);
    assert.equal(checked.get(file), value.sha256, file);
  }
  for (const child of Object.values(value)) visit(child);
}
function evidence(name) {
  const file = path.join(directory, `${name}.json`), value = read(file);
  assert(value.pass, file);
  visit(value);
  report.reports.push(audit(file));
  return value;
}
try {
  const build = evidence('web-engine-full-build-results');
  assert(build.buildSucceeded && build.fullLinkAttempted);
  for (const scene of ['web-project-triplex-house-villa', 'web-engine-webgpu-es31-default'])
    for (const step of ['cook', 'stage']) evidence(`${scene}-${step}-results`);
  const packaged = evidence('web-project-triplex-house-villa-package-results');
  evidence('web-default-template-package-results');
  evidence('web-default-scene-results');
  const native = evidence('web-occlusion-native-results');
  assert.equal(native.checks, 7);
  const nativeResult = read(native.runtime.file);
  assert(nativeResult.transitions.pass && nativeResult.transitions.checks.every(check => check.pass) &&
    !nativeResult.errors.length);
  const uniforms = evidence('web-static-uniforms-native-results');
  const count = result => result.modes ? result.modes.reduce((sum, mode) => {
    assert(mode.pass && mode.checks.every(check => check.pass) && !mode.errors.length);
    return sum + mode.checks.length;
  }, 0) : (assert(result.material.pass && result.material.checks.every(check => check.pass)),
    result.material.checks.length);
  report.nativeStaticChecks = uniforms.runs.reduce((sum, run) => sum + count(read(run.runtime.file)), 0);
  assert.equal(report.nativeStaticChecks, 267);
  const textures = evidence('web-texture-streaming-native-results');
  report.nativeTextureChecks = count(read(textures.runtime.file));
  assert.equal(report.nativeTextureChecks, 362);
  for (const file of ['reference-engine/Engine/Platforms/Web/Config/WebEngine.ini',
    'tests/ue-shader-host/Config/Web/WebEngine.ini', 'tests/web-platform/cook-profiles/DefaultTemplateEngine.ini',
    'tests/web-platform/cook-profiles/TriplexHouseVillaEngine.ini']) {
    const absolute = path.join(root, file);
    assert(/^r.NumBufferedOcclusionQueries=2$/m.test(fs.readFileSync(absolute, 'utf8')));
    report.reports.push(audit(absolute));
  }
  for (const name of ['chrome', 'edge']) {
    const performance = evidence(`visibility-final-${name}-results`);
    assert(performance.occlusion && !performance.cpuProfile && !performance.fixedClock &&
      performance.bufferedFrames === 0 && performance.warmupFrames >= 600 && !performance.errors.length);
    assert.equal(performance.package.sha256, audit(path.join(directory,
      'web-project-triplex-house-villa-package-results.json')).sha256);
    const phases = new Map(performance.phases.map(phase => [phase.label, phase]));
    const pairs = [['room-off', 'room-on'], ['wall-off', 'wall-on'],
      ['room-off-repeat', 'room-on-repeat']].map(([off, on]) => {
      const a = phases.get(off), b = phases.get(on);
      const draws = phase => phase.callsPerFrame['GPURenderPassEncoder.drawIndexed'];
      const before = b.sample.firstOcclusionRHI, after = b.sample.occlusionRHI;
      assert(draws(b) < draws(a) * (on.startsWith('wall') ? 0.75 : 0.85));
      assert(b.sample.occluded > 0 && b.sample.visible > 0);
      assert(after.ready > before.ready && after.zero > before.zero &&
        after.pending - before.pending < (after.ready - before.ready) * 0.05);
      return {off, on, fpsBefore: a.fps, fpsAfter: b.fps, speedup: b.fps / a.fps,
        drawsBefore: draws(a), drawsAfter: draws(b), drawReduction: 1 - draws(b) / draws(a)};
    });
    for (const value of [performance.visual.room, performance.visual.roomRepeat, performance.visual.wall])
      assert(value.rms < 3 && value.changedFraction < 0.01);
    const stability = evidence(`web-project-triplex-house-villa-occlusion-stability-${name}-results`);
    assert(stability.seconds >= 180 && stability.mode === 'tour' && !stability.errors.length &&
      !stability.engineErrors.length && stability.samples.every(sample =>
        !sample.failure && !sample.gpu.errors.length && !sample.gpu.deviceLosses.length));
    assert(stability.final.occlusion.ready > stability.initial.occlusion.ready &&
      stability.final.occlusion.zero > stability.initial.occlusion.zero);
    assert.equal(stability.packageReport.sha256, performance.package.sha256);
    const local = evidence(`web-project-local-io-${name}-results`);
    assert.equal(local.packageReport.sha256, performance.package.sha256);
    assert(local.runs.length === 2 && !local.runs[1].requests.length &&
      local.runs.every(run => !run.errors.length && run.phases.length === 4 && run.phases.every(phase =>
        !phase.failure && phase.bulkFiles === 621 && !phase.bulkMemfsBytes &&
        !phase.streaming.pending && phase.local.memoryBytes <= phase.local.memoryLimit)));
    for (const run of local.runs) {
      const [spawn, high, low, recovered] = run.phases;
      assert.equal(run.requests.length, run.warm ? 0 : 2);
      assert.equal(spawn.local.downloads, run.warm ? 0 : 2);
      assert(low.streaming.residentBytes < high.streaming.residentBytes * 0.8 &&
        recovered.streaming.residentBytes > low.streaming.residentBytes * 1.25 &&
        recovered.local.diskReads > low.local.diskReads &&
        recovered.local.downloadedBytes === high.local.downloadedBytes);
    }
    report.browsers.push({browser: performance.browser, pairs, visual: performance.visual,
      stability: {frames: stability.final.frame - stability.initial.frame,
        seconds: stability.samples.at(-1).elapsedSeconds, occlusion: stability.final.occlusion}});
  }
  const historical = path.join(directory, 'visibility-metrics-results.json');
  const previous = read(historical), off = previous.phases.find(phase => phase.label === 'room-off'),
    on = previous.phases.find(phase => phase.label === 'room-on');
  assert(on.callsPerFrame['GPURenderPassEncoder.drawIndexed'] >
    off.callsPerFrame['GPURenderPassEncoder.drawIndexed'] && on.sample.occlusionRHI.pending > on.sample.occlusionRHI.ready);
  report.historicalReadbackMiss = audit(historical);
  report.historicalBoundary = 'The first nonblocking implementation used the previous binary/configuration. ' +
    'GPU results existed but UE usually read before they were ready; historical source/product hashes are not current.';
  report.checkedFiles = checked.size;
  report.textureCompression = packaged.textureCompression;
  assert.equal(packaged.textureCompression, 'BC');
  report.boundary = 'Asynchronous hardware occlusion queries and three-frame mobile history, with existing ' +
    'view-frustum culling. HZB, GPU-driven indirect culling, editor parity and unlimited stability are not verified. ' +
    'CPU draw submission and shadow passes remain significant. FPS measurements include browser instrumentation.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
const file = path.join(directory, 'web-occlusion-audit-results.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, checkedFiles: report.checkedFiles,
  browsers: report.browsers, failure: report.failure}, null, 2));
