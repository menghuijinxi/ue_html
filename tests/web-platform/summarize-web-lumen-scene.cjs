'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert.equal(process.argv.length, 6, 'Expected browser report, native capture, native system report and output');
const [webFile, nativeFile, systemFile, output] = process.argv.slice(2).map(file => path.resolve(file));
const read = file => {
  const bytes = fs.readFileSync(file);
  return JSON.parse(bytes.toString(bytes[0] === 255 && bytes[1] === 254 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, ''));
};
const valid = item => audit(item.file).sha256 === item.sha256;
const average = values => values.reduce((total, value) => total + value, 0) / values.length;
const web = read(webFile), native = read(nativeFile), system = read(systemFile);
assert(web.pass && !web.errors.length && !web.settingsOverrides.length &&
  web.width === 1280 && web.height === 720 && web.seconds === 90);
assert.deepEqual(web.samples.map(item => item.label), ['startup', 'room', 'wall', 'room-return']);
assert(web.samples.at(-1).frame - web.samples[0].frame > 1000);
for (const sample of web.samples) {
  assert(!sample.memory.errors.length && sample.settings.gi === 1 &&
    sample.settings.reflections === 1 && sample.settings.antiAliasing === 4);
  assert(sample.view.width === 1280 && sample.view.height === 720 && sample.distanceFields.meshes > 0);
}
assert(native.completed && system.exitCode === 0 && system.hostProcessorAffinity === 0);
assert(native.runs.every(item => item.giMethod === 1 && item.reflectionMethod === 1 &&
  item.antiAliasingMethod === 4 && item.viewWidth === 1280 && item.viewHeight === 720));
assert(web.processMemoryIntervalMilliseconds === 2000 && web.processMemory.length >= 30);
const nativePeak = Math.max(...system.gpu.map(item =>
  (item.process || []).reduce((total, row) => total + row.DedicatedUsage, 0)));
const webPeak = Math.max(...web.processMemory.map(item => item.dedicated));
assert(nativePeak > 0 && webPeak > 0);
const webViews = web.samples.slice(1).map(sample => ({
  label: sample.label, frame: sample.frame, camera: sample.camera,
  meanFrameMilliseconds: average(sample.memory.frameMilliseconds),
  meanFPS: 1000 / average(sample.memory.frameMilliseconds),
  frameIntervals: sample.memory.frameMilliseconds.length,
  textureMiB: sample.memory.totals.texture / 1048576, bufferMiB: sample.memory.totals.buffer / 1048576,
  liveResources: sample.memory.live.length, processDedicatedMiB: sample.wddm.dedicated / 1048576,
}));
const nativeViews = native.runs.map(item => ({
  name: item.case.name, camera: item.case, meanGPUms: average(item.gpuMs),
  meanWallMilliseconds: average(item.wallFrameMs), meanFPS: 1000 / average(item.wallFrameMs),
  frameIntervals: item.wallFrameMs.length,
}));
for (const [index, nativeIndex] of [[0, 0], [1, 1], [2, 0]]) {
  for (const key of ['x', 'y', 'z', 'pitch'])
    assert(Math.abs(webViews[index].camera[key] - nativeViews[nativeIndex].camera[key]) < 0.00001);
  const difference = webViews[index].camera.yaw - nativeViews[nativeIndex].camera.yaw;
  assert(Math.abs(difference / 360 - Math.round(difference / 360)) < 0.00001);
}
const reportNames = [
  'web-project-triplex-project-lumen-desktop-cook-results.json',
  'web-project-triplex-project-lumen-desktop-stage-results.json',
  'web-project-triplex-project-lumen-distance-fields-threads-package-results.json',
  'lumen-sampling-cooked-modules-gpu.json',
];
const reports = reportNames.map(name => path.join(__dirname, 'results', name));
for (const file of reports) assert(read(file).pass);
const modules = read(reports.at(-1));
assert(modules.modules.length === 1682 && modules.modules.every(item =>
  !item.errors.length && item.sourceFiles.every(valid)) && modules.sourceFiles.every(valid));
const first = webViews[0], last = webViews.at(-1);
const screenshots = [0, 1, 2].map(index => webFile.replace(/\.json$/, `-${index}.png`));
const report = {
  date: new Date().toISOString(), pass: true, fullVillaRunPassed: true, fullFeatureCompatibility: false,
  visualParityAccepted: false, rendererOverrides: [], width: 1280, height: 720,
  browserStartupMilliseconds: web.startupMilliseconds, observedFrames: web.samples.at(-1).frame,
  browserViews: webViews, nativeViews, adapter: native.adapter,
  sampling: {
    browser: 'Last 600 engine submission intervals per view, GPU allocation observer enabled; not physical display timings.',
    native: '300 warmup frames, then 180 samples per view; wall time and GPU queries.',
    processMemory: 'WDDM dedicated memory for isolated browser process tree and native editor, sampled every 2 seconds.',
  },
  processMemory: {browserSampleCount: web.processMemory.length, nativeSampleCount: system.gpu.length,
    browserPeakMiB: webPeak / 1048576, nativePeakMiB: nativePeak / 1048576,
    differenceMiB: (webPeak - nativePeak) / 1048576, differencePercent: (webPeak / nativePeak - 1) * 100,
    roomReturnLogicalDeltaMiB: last.textureMiB + last.bufferMiB - first.textureMiB - first.bufferMiB,
    roomReturnResourceDelta: last.liveResources - first.liveResources},
  tracingBoundary: {
    browser: 'Software distance fields, WebGPU desktop SM5 path.',
    native: 'Native SM6; project r.RayTracing=1 and hardware tracing capabilities differ.',
    performanceParity: 'The FPS values are observations, not proof of equal image quality or a renderer speed ranking.',
  },
  remaining: [
    'Hardware ray tracing is not implemented in this Web target.',
    'Hair, heightfield and other trace permutations can exceed storage-buffer limits.',
    'Automatic PSO precaching remains gated by WebPSOPrecacheTest and was disabled in this run.',
    'Long-duration traversal, all materials and exact visual parity remain unverified.',
    'Two-second memory sampling can miss brief driver allocation peaks; resource-pool release on runtime Lumen disable is unmeasured.',
  ],
  sourceReports: [webFile, nativeFile, systemFile, ...reports].map(audit),
  images: [...screenshots, ...native.runs.map(item => item.image)].map(audit),
  sourceFiles: [__filename, 'probe-web-project-memory.cjs', 'web-gpu-memory-observer.cjs',
    'gpu-process-memory.cjs', 'capture-villa-distance-fields.ps1'].map(file => audit(path.resolve(__dirname, file))),
};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, frames: report.observedFrames, memory: report.processMemory}));
