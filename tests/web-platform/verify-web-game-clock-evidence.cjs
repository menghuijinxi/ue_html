'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const fingerprint = file => ({...audit(path.join(root, file)), file});
const result = name => 'tests/web-platform/results/' + name + '.json';
const rounds = [
  ['game-clock-r2', 'game-clock-20261105-r2-package'],
  ['page-raf-r2', 'game-clock-20261105-page-raf-r1-package'],
  ['mailbox-r1', 'input-bridge-20261105-mailbox-r1-package'],
];
let total = 0;
const captures = rounds.map(([tag, packageName]) => {
  const file = result('motion-blur-inputs-20261105-' + tag);
  const analysisFile = file.replace('.json', '-analysis.json');
  const report = read(file), analysis = read(analysisFile), packageFile = result(packageName);
  const packaged = read(packageFile);
  assert(report.pass && analysis.pass && packaged.pass);
  assert.equal(analysis.input.sha256, fingerprint(file).sha256);
  const runs = report.runs.map((run, index) => {
    assert.equal(run.settings.gi, 1);
    assert.equal(run.settings.reflections, 1);
    assert.equal(run.settings.antiAliasing, 4);
    assert.deepEqual([run.errors, run.probe.errors, run.probe.losses], [[], [], []]);
    const measured = analysis.runs[index];
    assert.equal(run.folder, measured.folder);
    assert.equal(run.probe.samples.length, measured.scale.samples);
    assert.equal(Math.max(...run.probe.samples.map(v => v.globals.VelocityScale[0])), measured.scale.maxScaleX);
    assert(measured.movingScaleOver500 > 0);
    const products = packaged.cases?.find(v => v.folder === run.folder)?.products || packaged.products;
    const versions = read('tests/web-platform/build/' + packaged.baseline + '/asset-versions.json');
    for (const product of products) {
      const name = path.basename(product.file);
      if (['index.html', 'UEWebEngineThreads.js', 'web-engine-host.js', 'web-engine-worker.js',
        'asset-versions.json'].includes(name)) continue;
      assert.equal(product.sha256, versions[name].sha256, 'Unchanged product identity');
    }
    let screenshot;
    if (tag === 'mailbox-r1' && index === 0) {
      screenshot = {excluded: true, reason: 'Original owner image was overwritten by shared image; raw report preserved.'};
    } else if (run.screenshot) {
      assert.equal(audit(run.screenshot.file).sha256, run.screenshot.sha256);
      screenshot = run.screenshot;
    }
    if (tag === 'page-raf-r2') {
      assert.equal(run.frameBridge.mode, 'page-raf');
      assert(run.frameBridge.ready && run.frameBridge.delivered > 100);
    }
    if (run.inputBridge?.mode === 'shared-mailbox') {
      assert.equal(run.inputBridge.sent, run.gameClock.mailbox.consumed);
      assert.equal(run.inputBridge.overflows, 0);
      assert.equal(run.gameClock.mailbox.overflowResets, 0);
    }
    total += run.probe.samples.length;
    return {...measured, screenshot, mailbox: run.gameClock.mailbox,
      sharedProducer: run.inputBridge?.mode === 'shared-mailbox' ? run.inputBridge : undefined,
      errors: {page: 0, gpu: 0, deviceLosses: 0}};
  });
  return {report: fingerprint(file), analysis: fingerprint(analysisFile), packageReport: fingerprint(packageFile),
    probeAtCapture: report.source, packageSourcesAtCapture: packaged.sources, runs};
});
assert.equal(total, 863);
const failedFile = result('motion-blur-inputs-20261105-game-clock-r1');
assert.equal(read(failedFile).pass, false);
const provisionalFile = result('motion-blur-inputs-20261105-page-raf-r1');
const provisional = read(provisionalFile);
assert(provisional.pass && provisional.runs[0].probe.samples.length === 238);
const sources = ['web-engine-host.js', 'web-engine-worker.js', 'package-web-input-bridge.cjs',
  'probe-web-motion-blur-inputs.cjs', 'verify-web-input-bridge.cjs', 'package-web-game-clock.cjs',
  'web-game-clock-observer.cjs', 'analyze-web-game-clock.cjs', 'verify-web-game-clock-evidence.cjs']
  .map(name => fingerprint('tests/web-platform/' + name));
sources.push(fingerprint('reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'));
const evidence = JSON.parse(JSON.stringify({
  date: '2026-11-05', captureChecksPassed: true, visualFixClaimed: false,
  manualDirectInputVerdict: {symptomImproved: false, result: '用户反馈：这一版抖动没有任何改善。'},
  referenceEngineCommit: execFileSync('git', ['rev-parse', 'HEAD'],
    {cwd: path.join(root, 'reference-engine'), encoding: 'utf8', windowsHide: true}).trim(),
  sources, finalDispatchSamples: total, captures,
  failedCapture: {report: fingerprint(failedFile), reason: 'Route injection did not install readable GT observer; excluded.'},
  provisionalCapture: {report: fingerprint(provisionalFile), samples: 238,
    boundary: 'RAF activation counters absent. Repeated as page-raf-r2 with explicit ready/delivered assertions.'},
  checks: {sourceAndDerivedSyntax: 'PASS', realPortsAndSharedQueue: 'PASS',
    captureAndAnalysisHashes: 'PASS', unchangedResourcesAtPackaging: 'PASS',
    screenshots: 'Shared and page-RAF-r2 reviewed; owner overwritten image excluded.'},
  conclusion: 'Changing input transport or RAF provider did not remove scale spikes. GT entry intervals and uploaded scale are inversely correlated; CPU timing versus camera history remains unresolved.',
  boundary: 'JS-only derived runtime, no full UBT/WASM rebuild. GT entry intervals are not a direct read of CPU DeltaRealTime, Amount or TargetFPS. Counter alignment is empirical. No velocity texture readback or manual visual verdict for the new variants. Diagnostics and browser-generated mouse events add overhead; not a performance benchmark. Capture-time source hashes remain historical.',
}));
const destination = 'tests/web-platform/evidence/game-clock-investigation-20261105.json';
if (process.argv.includes('--write')) {
  assert(!fs.existsSync(path.join(root, destination)), 'Preserve previous evidence');
  fs.writeFileSync(path.join(root, destination), JSON.stringify(evidence, null, 2) + '\n');
} else assert.deepEqual(read(destination), evidence);
console.log(JSON.stringify({pass: true, finalDispatchSamples: total, evidence: destination}));
