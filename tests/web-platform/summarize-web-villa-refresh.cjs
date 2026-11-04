'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const [memoryFile, gameplayFile, outputFile, previewFile] = process.argv.slice(2).map(file => path.resolve(file));
assert(memoryFile && gameplayFile && outputFile, 'Expected memory report, gameplay report and output');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const result = name => path.join(__dirname, 'results', name);
const buildFile = result('web-engine-full-thread-build-results.json');
const cookFile = result('web-project-triplex-project-lumen-desktop-cook-results.json');
const stageFile = result('web-project-triplex-project-lumen-desktop-stage-results.json');
const packageFile = result('web-project-triplex-project-lumen-distance-fields-threads-package-results.json');
const nativeFiles = ['native-rendercore-build-results.json', 'native-renderer-build-results.json'].map(result);
const nativeBuilds = nativeFiles.map(read);
const build = read(buildFile), cook = read(cookFile), stage = read(stageFile), packaged = read(packageFile);
for (const report of [build, cook, stage, packaged]) assert(report.pass, report.failure);
for (const report of nativeBuilds) {
  assert(report.pass && !report.disableHostOptimization && report.installedInputsUnmodified);
  assert(report.installedInputs.every(valid) && report.products.every(valid));
}
assert(build.buildSucceeded && build.fullLinkVerified && build.threads && build.allocator === 'mimalloc');
assert(build.sourceFiles.every(valid) && build.products.every(valid));
assert(build.objects.every(item => [item.object, item.response, item.definitions, item.source].every(valid)));
const compileOptimization = {};
for (const item of build.objects) {
  const response = fs.readFileSync(item.response.file, 'utf8');
  const flags = response.match(/(?<!\S)-O[0-3sz](?=\s|$)/g);
  assert(flags?.length === 1 && ['-O1', '-O2'].includes(flags[0]), 'Unexpected object optimization');
  compileOptimization[flags[0]] = (compileOptimization[flags[0]] || 0) + 1;
}
assert(cook.exitCode === 0 && cook.useProjectSettings && cook.lumen.enabled && !cook.shaderFailures.length);
assert(stage.useProjectSettings && packaged.useProjectSettings && packaged.products.every(valid));
assert.equal(packaged.map, '/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla');
assert.deepEqual(packaged.engineArguments, ['-webgpu', '-WebProjectMap=' + packaged.map]);
const policy = read(cook.projectSettings.file);
assert.deepEqual(policy.rendererOverrides, []);
const memory = read(memoryFile), gameplay = read(gameplayFile);
const preview = previewFile ? read(previewFile) : null;
assert(memory.pass && !memory.errors.length && !memory.settingsOverrides.length);
assert(memory.processMemoryIntervalMilliseconds === 2000 && memory.processMemory.length >= 30);
assert(gameplay.pass && !gameplay.settingsOverrides.length && gameplay.folder === memory.folder);
assert(path.basename(packaged.output) === memory.folder);
assert.deepEqual(memory.samples.map(item => item.label), ['startup', 'room', 'wall', 'room-return']);
for (const sample of memory.samples) {
  assert(!sample.memory.errors.length && sample.settings.gi === 1 && sample.settings.reflections === 1 &&
    sample.settings.antiAliasing === 4 && sample.distanceFields.meshes > 0);
  assert(sample.metadata.native && sample.metadata.nativeLoads > 0 && sample.metadata.domLoads === 0);
  assert(sample.occlusion.skipNoopRHITick && sample.occlusion.nativeStorageContracts &&
    sample.occlusion.revalidateStorageDescriptors);
}
assert(gameplay.requireRenderThreads && gameplay.requireGPUScene && gameplay.requireResourceTables &&
  gameplay.validateBindingCache && gameplay.nativeValidation);
for (const run of gameplay.runs) {
  assert(run.pass && !run.errors.length && run.maxTravelCm > 50 && run.maxTurnDegrees > 10);
  for (const sample of run.samples.filter(sample => sample.metadata))
    assert(sample.metadata.native && sample.metadata.domLoads === 0);
  const last = run.samples.at(-1);
  assert(last.metadata?.nativeLoads > 0 && last.metadata.domLoads === 0);
  assert(last.bindings.bindingEntriesValidated > 1000 && last.bindings.groupPreparationValidated > 1000);
}
const mean = values => values.reduce((total, value) => total + value, 0) / values.length;
const views = memory.samples.slice(1).map(sample => ({
  label: sample.label, frame: sample.frame, camera: sample.camera, settings: sample.settings,
  meanSubmissionFPS: 1000 / mean(sample.memory.frameMilliseconds),
  frameIntervals: sample.memory.frameMilliseconds.length,
  textureMiB: sample.memory.totals.texture / 1048576, bufferMiB: sample.memory.totals.buffer / 1048576,
  dedicatedMiB: sample.wddm.dedicated / 1048576, metadata: sample.metadata,
}));
const compile = build.compileExecution ? read(build.compileExecution.file) : null;
assert(!compile || compile.pass);
const revision = directory => cp.execFileSync('git', ['rev-parse', 'HEAD'], {cwd: directory, encoding: 'utf8'}).trim();
const report = {
  date: new Date().toISOString(), pass: true, rootRevision: revision(root),
  engineRevision: revision(path.join(root, 'reference-engine')), folder: memory.folder,
  projectSettingsPreserved: true, rendererOverrides: [], compileOptimization,
  allocator: build.allocator, finalLinkOptimization: build.linkOptimization,
  nativeBuilds: nativeBuilds.map(report => ({compilerVersion: report.compilerVersion,
    disableHostOptimization: report.disableHostOptimization, hostProcessorAffinity: report.hostProcessorAffinity})),
  compilerRetries: compile?.results.filter(item => item.attempts.length > 1).map(item => ({
    source: item.source, attempts: item.attempts.length, exitCode: item.code,
  })) || [],
  cook: {files: cook.products.length, bytes: cook.totalBytes, lumen: cook.lumen,
    convertedShaders: cook.shaderInventory?.detail?.shaders?.length ?? null},
  package: {files: packaged.products.length, bytes: packaged.totalBytes, products: packaged.products},
  browser: {width: memory.width, height: memory.height, startupMilliseconds: memory.startupMilliseconds,
    observedSeconds: memory.seconds, observedFrames: memory.samples.at(-1).frame, views,
    peakDedicatedMiB: Math.max(...memory.processMemory.map(item => item.dedicated)) / 1048576,
    memorySampleCount: memory.processMemory.length, settingsOverrides: memory.settingsOverrides},
  gameplay: gameplay.runs.map(run => ({pass: run.pass, maxTravelCm: run.maxTravelCm,
    maxTurnDegrees: run.maxTurnDegrees, finalFrame: run.samples.at(-1).frame,
    validatedBindings: run.samples.at(-1).bindings.bindingEntriesValidated,
    validatedGroups: run.samples.at(-1).bindings.groupPreparationValidated})),
  manualPreview: preview,
  boundaries: [
    'Startup, three fixed views, movement, turns, resize and native binding-cache validation only.',
    'Submission FPS is not physical display FPS or an equal-quality native performance comparison.',
    'GPU memory is sampled process dedicated memory; short peaks may be missed.',
    'Hardware ray tracing, all materials, long traversal and pixel parity are not certified.',
    ...(preview?.initialFailure ? ['An in-app preview device loss occurred once; its cause remains unresolved despite a successful independent retry.'] : []),
  ],
  sourceReports: [buildFile, ...nativeFiles, cookFile, stageFile, packageFile, memoryFile, gameplayFile,
    ...(previewFile ? [previewFile] : [])].map(audit),
  images: [0, 1, 2].map(index => audit(memoryFile.replace(/\.json$/, `-${index}.png`))),
  sourceFiles: [__filename, path.join(__dirname, 'probe-web-project-memory.cjs'),
    path.join(__dirname, 'probe-web-project-gameplay.cjs')].map(audit),
};
fs.mkdirSync(path.dirname(outputFile), {recursive: true});
fs.writeFileSync(outputFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output: outputFile, frames: report.browser.observedFrames,
  views: views.map(view => ({label: view.label, fps: view.meanSubmissionFPS})),
  peakDedicatedMiB: report.browser.peakDedicatedMiB}));
