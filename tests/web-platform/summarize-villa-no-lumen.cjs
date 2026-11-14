'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..'), sources = [];
function read(relative) {
  const file = path.join(__dirname, relative); sources.push(audit(file));
  return JSON.parse(fs.readFileSync(file));
}
const profile = read('villa-engine-comparison-no-lumen.json');
const original = read('villa-engine-comparison.json');
const staged = read('results/villa-no-lumen-20261110-package.json');
const captured = read('results/villa-startup-20261110-no-lumen-capture/result.json');
const officialCapture = read('results/ue59-no-lumen-20261110-capture-v2/result.json');
const packaged = read('results/villa-no-lumen-20261110-v1-package.json');
const chrome = read('results/villa-engine-comparison-20261110-no-lumen-chrome/result.json');
const edge = read('results/villa-engine-comparison-20261110-no-lumen-edge/result.json');
const before = read('build/' + profile.source + '/asset-versions.json');
const after = read('build/' + profile.ours + '/asset-versions.json');
assert(staged.pass && captured.pass && officialCapture.pass && packaged.pass);
assert.equal(original.ours, profile.source, 'Original Lumen entry changed');
assert.deepEqual(Object.keys(profile.settings).filter(key => profile.settings[key] !== original.settings[key]).sort(),
  ['r.DynamicGlobalIlluminationMethod', 'r.Lumen.DiffuseIndirect.Allow', 'r.ReflectionMethod']);
assert.deepEqual(Object.keys(after).filter(name => after[name].sha256 !== before[name]?.sha256).sort(),
  ['config-files.json', 'index.html', 'pipeline-prewarm.json']);
for (const product of packaged.products) assert.equal(audit(product.file).sha256, product.sha256);
const officialChanged = [];
for (const file of staged.officialFiles) {
  assert.equal(audit(file.file).sha256, file.sha256, 'Original official file changed: ' + file.relative);
  const target = path.join(staged.officialStage, file.relative);
  if (audit(target).sha256 !== file.sha256) officialChanged.push(file.relative.replaceAll('\\', '/'));
}
assert.deepEqual(officialChanged.sort(), ['TriplexHouseVilla/Content/WebGPUPrewarm-SF_WEBGPU_SM5.json', 'wasm-cache.json']);
const officialPack = read('build/ue59-official-villa-20261109/no-lumen-20261110/TriplexHouseVilla/Content/WebGPUPrewarm-SF_WEBGPU_SM5.json');
const runs = [];
for (const report of [chrome, edge]) {
  assert(report.pass && report.affinity === 0);
  assert.deepEqual(report.profile, profile);
  assert.equal(report.runs.length, 2);
  for (const run of report.runs) {
    assert(run.pass); assert.deepEqual(run.errors, []);
    assert.deepEqual(run.state.canvas, {width: 1920, height: 1080});
    assert(run.state.hud.includes('FPS') && run.state.performance.submitted.fps > 0);
    if (run.engine === 'ours') {
      assert.equal(run.state.settings.gi, 0); assert.equal(run.state.settings.reflections, 0);
      assert(run.state.prewarm.adopted && run.state.prewarm.ready);
      assert.equal(run.state.prewarm.counts.misses, 0);
      assert(run.movementDistance > 20);
    } else {
      assert.deepEqual(run.actualSettings, profile.settings);
      assert(run.state.officialPerformance.prewarm.made.pipelines_ready > 0);
      assert.equal(run.state.officialPerformance.prewarm.failures, 0);
    }
    runs.push({browser: report.browser, engine: run.engine, pass: run.pass, errors: run.errors,
      canvas: run.state.canvas, settings: run.actualSettings || run.state.settings,
      prewarm: run.state.prewarm || run.state.officialPerformance.prewarm,
      movementDistance: run.movementDistance, mobileOverflow: run.mobile.overflow,
      dprChangedWhileRunning: run.dprChangedWhileRunning});
  }
}
for (const file of ['package-villa-no-lumen.cjs', 'capture-ue59-no-lumen.cjs',
  'probe-villa-startup.cjs', 'verify-villa-engine-comparison.cjs', 'villa-engine-comparison.html',
  'build/ue59-official-villa-20261109/comparison-no-lumen-files.json'])
  sources.push(audit(path.join(__dirname, file)));
const evidence = {date: '2026-11-10', pass: true,
  entry: 'http://127.0.0.1:8766/villa-engine-comparison.html?lighting=off#ours',
  profile, officialChanged, originalOfficialFilesVerified: staged.officialFiles.length,
  unchanged: Object.fromEntries(['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'content.bin',
    'web-content-worker.js'].map(name => [name, after[name].sha256])),
  officialPackPipelines: officialPack.pipelines.length, runs,
  sources: sources.map(item => ({file: path.relative(root, item.file).replaceAll('\\', '/'), sha256: item.sha256})),
  boundary: 'Configuration repackaging, no engine rebuild or recook. Rendering, HUD, prewarm, movement, switching, DPI and layout checks only; instrumented FPS samples are not a CPU benchmark or performance ranking. GPU work remains. Initial official capture failed with HTTP 404 before adding the child stage to the server allowlist; the successful rerun is capture-v2. Native GPU/compiler crash root cause remains unresolved.'};
fs.writeFileSync(path.join(__dirname, 'evidence/villa-no-lumen-20261110.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, runs: runs.length, officialPackPipelines: evidence.officialPackPipelines,
  unchangedOriginalOfficialFiles: staged.officialFiles.length}));
