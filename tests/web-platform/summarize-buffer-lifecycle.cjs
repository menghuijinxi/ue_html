'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verified = item => {assert.equal(audit(item.file).sha256, item.sha256, item.file); return item;};
const benchmarkFile = option('benchmark'), diagnosticFile = option('diagnostic'), imagesFile = option('images'), output = option('output');
assert(benchmarkFile && diagnosticFile && imagesFile && output && !fs.existsSync(output));
const benchmark = read(benchmarkFile), diagnostic = read(diagnosticFile), images = read(imagesFile);
assert(benchmark.pass && benchmark.performanceAccepted && !benchmark.validateBindings);
assert(diagnostic.pass && diagnostic.validation.length === 3 && diagnostic.resizes.length === 2);
assert(benchmark.folder === diagnostic.folder && !benchmark.errors?.length && !diagnostic.errors.length);
verified(benchmark.source); verified(benchmark.capturedSource); diagnostic.sources.forEach(verified);
verified(images.source); verified(images.diagnostic);
const imageInput = read(images.diagnostic.file); assert(imageInput.pass && imageInput.folder === diagnostic.folder); verified(imageInput.source);
const packageFile = path.join(__dirname, 'results', diagnostic.folder + '-package.json'), packaged = read(packageFile);
assert(packaged.pass); packaged.products.forEach(verified); verified(packaged.build);
const build = read(packaged.build.file); assert(build.pass && build.allocator === 'mimalloc');
build.sourceFiles.forEach(verified);
build.objects.forEach(unit => ['object', 'source', 'definitions', 'response'].forEach(key => verified(unit[key])));
benchmark.packageFiles.forEach(verified);
function aggregate(mode) {
  const runs = benchmark.runs.filter(r => r.throughputExperiment === mode); assert.equal(runs.length, 2);
  const frames = runs.reduce((s, r) => s + r.measurement.frames, 0);
  const ms = runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0);
  const intervals = runs.flatMap(r => r.intervals).toSorted((a, b) => b - a), tail = intervals.slice(0, Math.ceil(intervals.length * .01));
  const sampleFrames = runs.reduce((s, r) => s + r.workload.sampleFrames, 0);
  return {runs: runs.map(r => ({index: r.index, fps: r.fps, low1Fps: r.frameMs.low1Fps, rhiWorkMs: r.rhiWorkMs})),
    frames, milliseconds: ms, fps: frames * 1000 / ms,
    low1Fps: 1000 * tail.length / tail.reduce((s, n) => s + n, 0), maximumMs: intervals[0],
    over50: intervals.filter(n => n > 50).length,
    rhiWorkMs: runs.reduce((s, r) => s + r.rhiWorkMs * r.measurement.frames, 0) / frames,
    workload: Object.fromEntries(['drawsPerFrame', 'indirectDrawsPerFrame', 'dispatchesPerFrame'].map(key => [key,
      runs.reduce((s, r) => s + r.workload[key] * r.workload.sampleFrames, 0) / sampleFrames])),
    staging: runs.map(r => ({before: r.before.uploadStaging, after: r.after.uploadStaging}))};
}
const control = aggregate('control'), candidate = aggregate('staging');
const allocations = diagnostic.phases.map(phase => {
  const usage = {};
  for (const group of phase.groups) {
    const entry = usage[group.usage] ||= {count: 0, bytes: 0};
    entry.count += group.newCount; entry.bytes += group.newCount * group.size;
  }
  return {name: phase.name, frames: phase.frames, createdPerFrame: phase.createdPerFrame,
    byUsage: Object.fromEntries(Object.entries(usage).map(([key, value]) => [key,
      {...value, perFrame: value.count / phase.frames, descriptorBytesPerFrame: value.bytes / phase.frames}])),
    liveDescriptorBytesBefore: phase.before.lifecycle.liveBytes, liveDescriptorBytesAfter: phase.after.lifecycle.liveBytes,
    stagingBefore: phase.before.uploadStaging, stagingAfter: phase.after.uploadStaging};
});
const validation = [...diagnostic.validation, ...diagnostic.resizes];
assert(validation.every(v => !v.result.errors.length && v.result.completed === v.result.requested));
assert(validation.every(v => v.state.uploadStaging.retainedBytes <= 4 * 1048576));
const report = {date: new Date().toISOString(), experimentCompleted: true, pass: images.pass,
  gpuUploadCopiesVerified: true, acceptedForDefault: false, performanceBenefitEstablished: false,
  sources: [__filename, benchmarkFile, diagnosticFile, imagesFile, packageFile].map(audit),
  package: {folder: diagnostic.folder, build: packaged.build, runtime: packaged.products.filter(p => /\.(js|wasm)$/.test(p.file)),
    baselineEvidence: packaged.baselineEvidence, originalCook: packaged.products.filter(p => /(?:content\.bin|content-files\.json|config-files\.json)$/.test(p.file))},
  settings: {browser: benchmark.browser, view: benchmark.runs[0].before.view, camera: benchmark.runs[0].before.camera,
    threads: benchmark.runs[0].before.threads, renderer: benchmark.runs[0].before.settings, qualityOverrides: benchmark.qualityOverrides},
  order: benchmark.runs.map(r => r.throughputExperiment), control, candidate,
  fpsChangePercent: (candidate.fps / control.fps - 1) * 100,
  low1ChangePercent: (candidate.low1Fps / control.low1Fps - 1) * 100,
  rhiChangePercent: (candidate.rhiWorkMs / control.rhiWorkMs - 1) * 100,
  allocations, gpuByteValidation: {copies: validation.reduce((s, v) => s + v.result.completed, 0),
    bytes: validation.reduce((s, v) => s + v.result.bytes, 0),
    nonzeroOffsets: validation.reduce((s, v) => s + v.result.nonzeroOffsets, 0),
    checks: validation.map(v => ({enabled: v.enabled, size: v.size, ...v.result, staging: v.state.uploadStaging}))},
  churn: diagnostic.churn.map(c => ({budget: c.budget, streaming: c.state.streaming, staging: c.state.uploadStaging})),
  images, boundary: 'One normal ABBA, same runtime/Cook and spawn. Allocation and GPU byte checks run separately. A small FPS difference is not established performance benefit. Upload pages retain at most 4 MiB of descriptor capacity, not driver allocation. The measured workload used one page; large-upload fallback and multi-page overflow were not exercised. No default promotion, first-use PSO improvement, OS GPU utilization or native frame-time claim.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: report.pass, fpsChangePercent: report.fpsChangePercent, low1ChangePercent: report.low1ChangePercent,
  rhiChangePercent: report.rhiChangePercent, copies: report.gpuByteValidation.copies, bytes: report.gpuByteValidation.bytes}));
