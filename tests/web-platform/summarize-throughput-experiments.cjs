'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verified = item => { assert.equal(audit(item.file).sha256, item.sha256, item.file); return item; };
const benchmarkFiles = option('benchmarks')?.split(','), diagnosticFile = option('diagnostic'), imageFile = option('images');
const output = option('output'); assert(benchmarkFiles?.length && diagnosticFile && imageFile && output && !fs.existsSync(output));
const diagnostics = read(diagnosticFile), benchmarks = benchmarkFiles.map(read), images = read(imageFile);
assert(diagnostics.pass && typeof images.pass === 'boolean' && diagnostics.errors.length === 0);
diagnostics.sources.forEach(verified);
verified(images.source); verified(images.diagnostic);
const imageInput = read(images.diagnostic.file);
assert(imageInput.pass && imageInput.folder === diagnostics.folder); verified(imageInput.source);
const costFiles = option('costs')?.split(',') || [];
const costs = costFiles.map(file => {
  const cost = read(file); verified(cost.source); verified(cost.targets);
  cost.threads.forEach(thread => verified(thread.profile));
  return {source: audit(file), threads: cost.threads, boundary: cost.boundary};
});
const packageFile = path.join(__dirname, 'results', diagnostics.folder + '-package.json');
const packaged = read(packageFile); assert(packaged.pass); packaged.products.forEach(verified);
const build = read(packaged.build.file); verified(packaged.build); assert(build.pass && build.allocator === 'mimalloc');
build.sourceFiles.forEach(verified);
for (const unit of build.objects) for (const key of ['object', 'source', 'definitions', 'response']) verified(unit[key]);
const modes = Object.fromEntries(diagnostics.phases.map(p => [p.mode, p]));
assert.deepEqual(Object.keys(modes), ['control', 'binding', 'tlv', 'combined']);
const volumeComparison = {};
for (const [mode, phase] of Object.entries(modes)) {
  let count = 0, equalToControl = 0, equalToValidatedBinding = 0, maxRelativeEnergyDifference = 0;
  for (let view = 0; view < phase.views.length; ++view) {
    const volumes = phase.views[view].volumes, control = modes.control.views[view].volumes;
    const binding = modes.binding.views[view].volumes;
    assert.equal(volumes.length, control.length);
    for (let i = 0; i < volumes.length; ++i) {
      const actual = volumes[i], expected = control[i];
      assert(actual.invalid === 0 && actual.label === expected.label && actual.width === expected.width && actual.depth === expected.depth);
      ++count; equalToControl += actual.sha256 === expected.sha256;
      equalToValidatedBinding += actual.sha256 === binding[i].sha256;
      maxRelativeEnergyDifference = Math.max(maxRelativeEnergyDifference,
        Math.abs(actual.energy - expected.energy) / Math.max(1, expected.energy));
    }
  }
  assert(maxRelativeEnergyDifference < 1e-4, 'TLV energy changed beyond the diagnostic tolerance');
  if (mode === 'tlv' || mode === 'combined') assert.equal(equalToValidatedBinding, count);
  volumeComparison[mode] = {count, equalToControl, equalToValidatedBinding, maxRelativeEnergyDifference};
}
function distribution(values) {
  const sorted = values.toSorted((a, b) => b - a), tail = sorted.slice(0, Math.ceil(sorted.length * .01));
  return {low1Fps: 1000 * tail.length / tail.reduce((a, b) => a + b, 0),
    maximumMs: sorted[0], over50: values.filter(x => x > 50).length};
}
function aggregate(runs) {
  const frames = runs.reduce((s, r) => s + r.measurement.frames, 0);
  const milliseconds = runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0);
  const sampleFrames = runs.reduce((s, r) => s + r.workload.sampleFrames, 0);
  const counters = ['bindingPlanEntries', 'bindingEntriesPrepared', 'bindingEntriesReused',
    'bindGroupCacheHits', 'bindGroupsCreated', 'uniformSnapshots', 'groupPreparationHits', 'groupAccessMisses', 'groupVersionMisses'];
  return {runs: runs.length, frames, milliseconds, fps: frames * 1000 / milliseconds,
    ...distribution(runs.flatMap(r => r.intervals)),
    rhiWorkMs: runs.reduce((s, r) => s + r.rhiWorkMs * r.measurement.frames, 0) / frames,
    workload: Object.fromEntries(['drawsPerFrame', 'indirectDrawsPerFrame', 'dispatchesPerFrame'].map(k => [k,
      runs.reduce((s, r) => s + r.workload[k] * r.workload.sampleFrames, 0) / sampleFrames])),
    countersPerFrame: Object.fromEntries(counters.map(k => [k,
      runs.reduce((s, r) => s + r.after.occlusion[k] - r.before.occlusion[k], 0) / sampleFrames]))};
}
const comparisons = {binding: [], tlv: []};
const allRuns = [];
for (let fileIndex = 0; fileIndex < benchmarks.length; ++fileIndex) {
  const report = benchmarks[fileIndex]; assert(report.pass && report.performanceAccepted && report.throughput && !report.validateBindings);
  assert.equal(report.folder, diagnostics.folder); verified(report.source); verified(report.capturedSource);
  for (const item of report.packageFiles) verified(item);
  assert.equal(report.runs.length % 4, 0);
  for (let start = 0; start < report.runs.length; start += 4) {
    const runs = report.runs.slice(start, start + 4), candidates = runs.filter(r => r.throughputExperiment !== 'control');
    const label = candidates[0]?.throughputExperiment; assert(label && candidates.length === 2 && candidates.every(r => r.throughputExperiment === label));
    const control = aggregate(runs.filter(r => r.throughputExperiment === 'control')), candidate = aggregate(candidates);
    comparisons[label].push({source: benchmarkFiles[fileIndex], indices: runs.map(r => r.index),
      order: runs.map(r => r.throughputExperiment), control, candidate,
      fpsChangePercent: (candidate.fps / control.fps - 1) * 100,
      low1ChangePercent: (candidate.low1Fps / control.low1Fps - 1) * 100});
  }
  allRuns.push(...report.runs);
}
const experiments = {};
for (const [label, blocks] of Object.entries(comparisons)) {
  assert(blocks.length);
  const selected = blocks.flatMap(b => {
    const report = benchmarks[benchmarkFiles.indexOf(b.source)]; return b.indices.map(i => report.runs.find(r => r.index === i));
  });
  const control = aggregate(selected.filter(r => r.throughputExperiment === 'control'));
  const candidate = aggregate(selected.filter(r => r.throughputExperiment === label));
  experiments[label] = {control, candidate, fpsChangePercent: (candidate.fps / control.fps - 1) * 100,
    low1ChangePercent: (candidate.low1Fps / control.low1Fps - 1) * 100, blocks};
}
const result = {date: new Date().toISOString(), pass: diagnostics.pass && images.pass,
  experimentCompleted: true, acceptedForDefault: false,
  decision: 'Both single-variable ABBA experiments completed. Gains below 1% do not establish a stable benefit; keep both optimization cvars disabled by default. The strict image gate is reported independently and is not waived.',
  source: audit(__filename),
  package: audit(packageFile), build: packaged.build, buildSummary: {allocator: build.allocator, target: build.target,
    fullLinkAttempted: build.fullLinkAttempted, log: build.log},
  runtime: packaged.products.filter(p => /UEWebEngineThreads\.(js|wasm)$/.test(p.file)),
  cook: packaged.products.filter(p => /(?:content\.bin|content-files\.json|config-files\.json)$/.test(p.file)),
  browser: benchmarks[0].browser, camera: allRuns[0].before.camera, view: allRuns[0].before.view,
  settings: allRuns[0].before.settings, threads: allRuns[0].before.threads,
  diagnostics: {source: audit(diagnosticFile), volumeComparison, imageComparison: {artifact: audit(imageFile), ...images},
    bindingPlanValidations: diagnostics.final.occlusion.bindingPlanValidations,
    bindingEntriesValidated: diagnostics.final.occlusion.bindingEntriesValidated,
    streaming: diagnostics.churn.map(x => ({budget: x.budget, residentBytes: x.streaming.residentBytes, poolAllocatedBytes: x.streaming.poolAllocatedBytes})),
    tlvLogs: diagnostics.logs, gpuFrames: diagnostics.phases.map(p => ({mode: p.mode,
      totalPassMs: p.gpuFrames.map(f => f.totalPassMs)})), errors: diagnostics.errors},
  benchmarks: benchmarkFiles.map(audit), experiments, costs,
  boundary: 'Two opt-in runtime experiments. Same WASM/Cook/camera/quality/full threading. Each four-run block compares one variable in ABBA or BAAB order. Wall-time FPS and slowest-1%-interval low use completed RHI viewport presents. Correctness, readbacks, CPU profiling, GPU timestamps and image analysis are outside normal FPS windows. TLV pairs RDG passes and shares per-light preparation; it preserves all dispatches and shadow sampling. No claim about first-turn pipeline stalls, desktop parity or OS GPU utilization.'};
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({reportWritten: true, pass: result.pass, experimentCompleted: true, output, experiments: Object.fromEntries(Object.entries(experiments).map(([k, v]) => [k,
  {controlFps: v.control.fps, fps: v.candidate.fps, change: v.fpsChangePercent, controlLow: v.control.low1Fps, low: v.candidate.low1Fps}]))}, null, 2));
