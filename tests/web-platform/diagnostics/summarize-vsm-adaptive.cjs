'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const gpuFile = option('gpu'), timingFiles = process.argv.filter(a => a.startsWith('--timing=')).map(a => a.slice(9));
assert(gpuFile && timingFiles.length && option('out'));
const gpu = read(gpuFile), timing = timingFiles.map(file => ({file, report: read(file)}));
const variants = read(gpu.variants.file);
assert.equal(audit(gpu.variants.file).sha256, gpu.variants.sha256);
const base = path.resolve(__dirname, '..');
const policyFile = path.join(base, 'results/vsm-adaptive-policy-20261111/result.json'), policy = read(policyFile);
assert(gpu.pass && gpu.kind === 'gpu' && policy.pass && policy.checkedLanes === 384 && policy.invalidWorkgroupBarrierRejected);
const result = {date: new Date().toISOString(), pass: false, qualityAccepted: false, releaseReady: false,
  source: audit(__filename),
  variants: {source: gpu.variants, preparation: variants.sources,
    modules: variants.variants.map(v => ({entry: v.entry, permutation: v.permutation, sources: v.sources}))},
  boundary: 'Opt-in experiment, not an official package or default. GPU captures split compute passes; timing captures preserve normal pass reuse. Image differences include temporal noise and do not establish dynamic visual equivalence.',
  policy: {source: audit(policyFile), checkedLanes: policy.checkedLanes,
    invalidWorkgroupBarrierRejected: policy.invalidWorkgroupBarrierRejected, inputs: policy.sources},
  gpu: {source: audit(gpuFile), browser: gpu.browser, package: gpu.package,
    overrides: gpu.overrides, adapter: gpu.runs[0].adapter,
    startupFailures: gpu.startupFailures || [], phases: [], runs: []},
  timing: []};
result.defaultCompiles = process.argv.filter(a => a.startsWith('--default-probe=')).map(argument => {
  const directory = argument.slice(16), reportFile = path.join(directory, 'probe-results.json'), report = read(reportFile);
  assert(report.pass && !report.adaptiveProbe);
  const conversion = path.join(directory, 'ShaderConversion');
  const shaders = fs.readdirSync(conversion, {withFileTypes: true}).filter(e => e.isDirectory());
  assert.equal(shaders.length, 1);
  const input = path.join(conversion, shaders[0].name, 'input.json'), metadata = read(input);
  const permutation = Number(metadata.shader.split('/')[2].split(':')[0]);
  const variant = variants.variants.find(v => v.permutation === permutation);
  assert(variant);
  const wgsl = path.join(conversion, shaders[0].name, 'output.wgsl');
  const normalize = file => fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim();
  assert.equal(normalize(wgsl), normalize(variant.sources[3].file));
  assert(!/enable subgroups/.test(normalize(wgsl)));
  return {permutation, identicalToPackagedOriginal: true, sources: [reportFile, input, wgsl].map(audit)};
});
assert.deepEqual(result.defaultCompiles.map(c => c.permutation).sort(), [17, 18]);
result.supportingChecks = ['results/nanite-converter/results.json', 'results/web-material-host-build-results.json']
  .map(name => {
    const file = path.join(base, name), report = read(file);
    assert(report.pass);
    return {source: audit(file), pass: true, cases: report.cases?.length,
      normalUBTBuildVerified: report.normalUBTBuildVerified};
  });
for (const run of gpu.runs) {
  assert.deepEqual(run.errors, []); assert.deepEqual(run.gpuErrors, []);
  for (const phase of run.phases) {
    assert.equal(phase.gpuFrames.length, 6);
    assert.equal(phase.after.prewarm.counts.misses - phase.before.prewarm.counts.misses, 0);
  }
  result.gpu.runs.push({adaptive: run.adaptive, matched: run.initial.probe.matched,
    replaced: run.initial.probe.replaced, phases: run.phases.map(p => ({name: p.name, samples: p.gpuFrames.length}))});
}
for (const phase of gpu.comparisons) {
  const total = values => Object.values(values).reduce((sum, n) => sum + n, 0);
  const baselineMs = total(phase.baseline), adaptiveMs = total(phase.adaptive);
  assert(baselineMs > 0 && adaptiveMs > 0);
  result.gpu.phases.push({...phase, baselineMs, adaptiveMs, savedMs: baselineMs - adaptiveMs,
    reductionPercent: 100 * (1 - adaptiveMs / baselineMs)});
}
function imageDifference(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let absolute = 0, squared = 0, large = 0, max = 0;
  const channels = a.width * a.height * 3;
  for (let i = 0; i < a.data.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 3; ++c) {
      const delta = Math.abs(a.data[i + c] - b.data[i + c]);
      absolute += delta; squared += delta * delta; pixelMax = Math.max(pixelMax, delta);
    }
    if (pixelMax > 16) ++large;
    max = Math.max(max, pixelMax);
  }
  return {meanAbsoluteChannelDifference: absolute / channels,
    rootMeanSquareDifference: Math.sqrt(squared / channels),
    pixelsOver16Percent: 100 * large / (a.width * a.height), maximumChannelDifference: max};
}
for (const {file, report} of timing) {
  assert(report.pass && report.kind === 'timing');
  assert.equal(report.package.sha256, gpu.package.sha256);
  assert.equal(report.variants.sha256, gpu.variants.sha256);
  const summary = {source: audit(file), probe: report.source, browser: report.browser,
    order: report.order, seconds: report.seconds, overrides: report.overrides,
    startupFailures: report.startupFailures || [],
    comparisons: report.comparisons.map(p => ({...p,
      averageGainPercent: 100 * (p.adaptive.fps / p.baseline.fps - 1),
      low1GainPercent: 100 * (p.adaptive.low1Fps / p.baseline.low1Fps - 1)})), runs: [], images: []};
  for (const run of report.runs) {
    assert.deepEqual(run.errors, []);
    assert(run.initial.prewarm.ready && run.initial.prewarm.adopted);
    assert.equal(run.initial.settings.virtualShadows, 1);
    assert.equal(run.initial.settings.gi, 1); assert.equal(run.initial.settings.reflections, 1);
    assert.equal(run.initial.settings.virtualTextures, 1);
    assert.equal(run.initial.view.width, 1400); assert.equal(run.initial.view.height, 788);
    assert.equal(run.initial.view.outputWidth, 1920); assert.equal(run.initial.view.outputHeight, 1080);
    assert.equal(run.initial.view.antiAliasing, 4); assert(run.initial.occlusion.reuseComputePass);
    summary.runs.push({index: run.index, adaptive: run.adaptive, settings: run.initial.settings,
      view: run.initial.view, matched: run.initial.probe.matched, replaced: run.initial.probe.replaced,
      phases: run.phases.map(p => {
        assert.equal(p.capture.creations.length, 0);
        assert.equal(p.after.prewarm.counts.misses - p.before.prewarm.counts.misses, 0);
        assert.deepEqual(p.after.probe.errors, []);
        return {name: p.name, ...p.summary, route: p.route, creations: 0, prewarmMisses: 0};
      })});
  }
  for (const name of ['interior', 'living', 'kitchen']) {
    const images = report.runs.map(run => {
      const image = run.images.find(i => i.name === name);
      assert.equal(audit(image.image.file).sha256, image.image.sha256);
      assert.deepEqual(image.state.probe.errors, []);
      return {run: run.index, adaptive: run.adaptive, source: image.image, camera: image.state.camera,
        png: PNG.sync.read(fs.readFileSync(image.image.file))};
    });
    const comparisons = [];
    for (let a = 0; a < images.length; ++a) for (let b = a + 1; b < images.length; ++b) {
      const left = images[a], right = images[b];
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
        assert(Math.abs(left.camera[key] - right.camera[key]) < 0.001, 'Camera views must match');
      comparisons.push({runs: [left.run, right.run],
        type: left.adaptive !== right.adaptive ? 'baseline-adaptive' : left.adaptive ? 'adaptive-repeat' : 'baseline-repeat',
        ...imageDifference(left.png, right.png)});
    }
    summary.images.push({name, sources: images.map(({png, ...image}) => image), comparisons});
  }
  result.timing.push(summary);
}
result.excluded = process.argv.filter(a => a.startsWith('--excluded=')).map(argument => {
  const file = argument.slice(11), report = read(file);
  assert.equal(report.pass, false, 'Only failed or incomplete reports belong in excluded evidence');
  return {source: audit(file), error: report.error || report.failure,
    completedPhases: (report.runs || []).reduce((sum, run) => sum + run.phases.filter(p => p.after).length, 0),
    startupFailures: (report.runs || []).filter(run => run.startupFailure).map(run =>
      ({index: run.index, adaptive: run.adaptive, failure: run.startupFailure}))};
});
result.pass = true;
fs.writeFileSync(option('out'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({pass: true, gpu: result.gpu.phases, timing: result.timing.map(t => t.comparisons)}));
