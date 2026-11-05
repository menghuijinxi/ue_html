'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {performanceModes} = require('./web-performance-modes.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
const packageTag = option('package-tag') || tag;
assert(tag && /^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(packageTag));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const packageFile = path.join(__dirname, 'results', `motion-blur-ab-${packageTag}-package.json`);
const runtimeFile = path.join(__dirname, 'results', `motion-blur-ab-${tag}-runtime.json`);
const packaged = read(packageFile), runtime = read(runtimeFile);
assert(packaged.pass && packaged.renderMatrix && runtime.pass);
assert.equal(audit(packageFile).sha256, runtime.package.sha256);
const motionMatrix = packaged.comparisonAxis === 'motion-blur';
const optimizationsOff = process.argv.includes('--optimizations-off');
const {modes: launchModes, query} = performanceModes({optimizationsOff,
  occlusion: option('occlusion'), clock: option('clock'), rhiwake: option('rhiwake')});
const selectedCase = option('case');
assert.equal(runtime.optimizationsOff === true, optimizationsOff);
assert.equal(runtime.selectedCase, selectedCase);
if (runtime.query !== undefined || query) assert.equal(runtime.query, query);
if (runtime.launchModes) assert.deepEqual(runtime.launchModes, launchModes);
if (query && !optimizationsOff) {
  assert.deepEqual(runtime.launchModes, launchModes);
  assert.equal(runtime.modesSource.sha256, audit(path.join(__dirname, 'web-performance-modes.cjs')).sha256);
}
const expectedMatrix = motionMatrix ? [
  ['no-lumen-blur', 0, 4, 1, 4], ['lumen-no-blur', 1, 4, 1, 0],
  ['lumen-blur-lag0', 1, 4, 0, 4], ['lumen-blur-lag1', 1, 4, 1, 4],
] : [
  ['no-lumen-aa', 0, 4, 1], ['lumen-no-aa', 1, 0, 1],
  ['lumen-aa-lag0', 1, 4, 0], ['lumen-aa-lag1', 1, 4, 1],
];
assert.equal(packaged.cases.length, expectedMatrix.length);
const expected = expectedMatrix.filter(([name]) => !selectedCase || name === selectedCase);
assert(expected.length > 0 && (!selectedCase || expected.length === 1));
assert.equal(runtime.runs.length, expected.length);
const reference = new Map(packaged.baselineProducts.map(item => [path.basename(item.file), item.sha256]));
const baselineFile = path.join(__dirname, 'results', packaged.baseline + '-package.json');
const baseline = read(baselineFile);
assert(baseline.pass);
assert.equal(path.resolve(baseline.output), path.resolve(__dirname, 'build', packaged.baseline));
assert.equal(audit(baseline.build.file).sha256, baseline.build.sha256);
const build = read(baseline.build.file);
assert(build.pass && build.fullLinkVerified && build.wasmValidated && build.threads);
for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm']) {
  const product = build.products.find(item => path.basename(item.file) === name);
  assert(product);
  assert.equal(reference.get(name), product.sha256, 'Variants must use the newly compiled runtime');
}
const entries = expected.map(([name, lumen, aa, lag, blurQuality], index) => {
  const entry = packaged.cases.find(value => value.name === name), run = runtime.runs[index];
  assert.equal(entry.name, name);
  assert.equal(run.name, name);
  assert(run.pass);
  assert.deepEqual(entry.settings, run.applied);
  assert.equal(entry.settings['r.DynamicGlobalIlluminationMethod'], lumen);
  assert.equal(entry.settings['r.ReflectionMethod'], lumen);
  assert.equal(entry.settings['r.AntiAliasingMethod'], aa);
  assert.equal(entry.settings['r.OneFrameThreadLag'], lag);
  assert.equal(entry.settings['t.MaxFPS'], 0);
  if (motionMatrix) {
    assert.equal(entry.settings['r.MotionBlurQuality'], blurQuality);
    assert.equal(run.state.view.antiAliasing, 4);
    assert.equal((run.state.probe.resources['MotionBlur.SceneColor'] || 0) > 0, blurQuality > 0);
    assert.equal((run.state.probe.bindings['MotionBlur.SceneColor'] || 0) > 0, blurQuality > 0);
  }
  assert.deepEqual([run.errors, run.state.probe.errors, run.state.probe.losses], [[], [], []]);
  for (const item of entry.products) {
    assert.equal(audit(item.file).sha256, item.sha256, item.file);
    const base = path.basename(item.file);
    if (!['config-files.json', 'index.html', 'asset-versions.json'].includes(base))
      assert.equal(item.sha256, reference.get(base), 'Unexpected variant difference: ' + base);
  }
  const configs = read(path.join(__dirname, 'build', entry.folder, 'config-files.json'));
  const baselineConfigs = read(path.join(__dirname, 'build', packaged.baseline, 'config-files.json'));
  for (const config of configs) {
    const original = baselineConfigs.find(item => item.path === config.path);
    assert(original);
    if (config.path.endsWith('/WebEngine.ini')) {
      const before = Buffer.from(original.data, 'base64').toString('utf8');
      const addition = '\n[SystemSettings]\n' +
        Object.entries(entry.settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
      assert.equal(Buffer.from(config.data, 'base64').toString('utf8'), before + addition);
    } else assert.deepEqual(config, original);
  }
  assert.equal(run.state.cpuTraceSamples, 0);
  assert.equal(run.state.gameClock.mode, launchModes.clock);
  assert.equal(run.state.history.enabled, launchModes.occlusion === 'history');
  assert.equal(run.state.rhiWake.requested, launchModes.rhiwake);
  assert.equal(run.state.rhiWake.active,
    launchModes.rhiwake === 'priority' && run.state.rhiWake.prioritySupported ? 'priority' : 'channel');
  if (query) {
    assert.equal(run.url, entry.url + query);
    assert.equal(run.state.arguments.includes('-WebGameLocalClock'), launchModes.clock === 'local');
    assert(run.state.arguments.includes('-WebOcclusionMode=' + launchModes.occlusion));
    assert(run.state.arguments.includes('-WebRHIWake=' + launchModes.rhiwake));
    assert.equal(run.state.occlusionRHI.bindingPlanEnabled, false);
    assert.equal(run.state.uploadStaging.enabled, false);
    assert.equal(run.state.occlusionWait.budgetMs, 0);
  }
  assert.equal(run.input.mode, 'owner-forwarded');
  return {name, folder: entry.folder, url: run.url || entry.url, settings: entry.settings,
    actual: {settings: run.state.settings, lighting: run.state.lighting, view: run.state.view,
      gameClock: run.state.gameClock, rhiWake: run.state.rhiWake,
      historyEnabled: run.state.history.enabled, inputMode: run.input.mode,
      arguments: run.state.arguments, occlusionRHI: run.state.occlusionRHI,
      uploadStaging: run.state.uploadStaging, occlusionWait: run.state.occlusionWait,
      cpuTraceSamples: run.state.cpuTraceSamples},
    resources: run.state.probe.resources, bindings: run.state.probe.bindings, image: run.image,
    files: entry.products.filter(item => /(?:config-files\.json|index\.html|UEWebEngineThreads\.(?:js|wasm))$/.test(item.file))};
});
const evidence = {date: new Date().toISOString(), pass: true, package: audit(packageFile),
  comparisonAxis: query ? 'performance-defaults' : packaged.comparisonAxis || 'anti-aliasing',
  optimizationsOff, selectedCase, launchModes,
  runtime: audit(runtimeFile), baseline: audit(baselineFile), build: baseline.build,
  source: audit(__filename), cases: entries,
  boundary: 'Configuration, shared payload, real rendering passes, camera input and error checks passed. Functional probes include wrappers and are not a performance benchmark or a subjective mouse-stutter verdict.'};
const output = path.join(__dirname, 'evidence', `render-matrix-${tag}.json`);
assert(!fs.existsSync(output), 'Preserve prior evidence; use a new tag');
fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, cases: entries.map(entry => entry.name)}));
