'use strict';
require('./project-output.cjs').initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {applyAcceptedDefaults, runtimeAssets} = require('./web-accepted-defaults.cjs');
const {coreFiles, readPage, writePage, prepareRecordedPrewarm} = require('./web-pipeline-prewarm-package.cjs');
const {releaseOptions, finalizeDesktopRelease, verifyDesktopRelease} = require('./web-release-defaults.cjs');
const {resolveWebRenderSize} = require('./web-engine-host.js');
const root = fs.mkdtempSync(path.join(__dirname, 'build/release-defaults-'));
const resultsDirectory = path.join(root, 'results'); fs.mkdirSync(resultsDirectory);
function fixture(name, applyDefaults = true) {
  const folder = path.join(root, name); fs.mkdirSync(folder);
  for (const file of coreFiles) fs.writeFileSync(path.join(folder, file),
    file === 'config-files.json' ? JSON.stringify([{
      path: '/Engine/Platforms/Web/Config/WebEngine.ini',
      data: Buffer.from('[SystemSettings]\nr.WebGPU.IndirectDrawReuse=0\n').toString('base64'),
    }]) : 'fixture:' + file);
  const assets = {threads: true, renderer: 'desktop', versions: {},
    wasm: {sha256: audit(path.join(folder, coreFiles[0])).sha256}};
  fs.writeFileSync(path.join(folder, 'index.html'), 'const localRuntimeAssets = ' + JSON.stringify(assets) +
    ';\narguments: ["-webgpu","-WebProjectMap=/Game/Fixture","-WebPSOPrecacheTest"],\n');
  if (applyDefaults) applyAcceptedDefaults(folder);
  return folder;
}
let captures = 0;
function capture(folder, withoutSubgroups = false) {
  const snapshot = path.join(root, 'capture-' + ++captures); fs.mkdirSync(snapshot);
  for (const name of [...coreFiles, 'index.html']) fs.copyFileSync(path.join(folder, name), path.join(snapshot, name));
  const versions = writeVersions(snapshot, fs.readdirSync(snapshot).map(name => audit(path.join(snapshot, name))));
  const directory = path.join(resultsDirectory, 'villa-startup-' + captures); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'result.json'),
    JSON.stringify({pass: true, capture: true, package: versions, withoutSubgroups,
      runs: [{pass: true, last: {worker: {pso: {enabled: true, active: 0}, pending: 0,
        rhi: {asyncPrecacheRequested: 1, asyncPrecacheCompleted: 1, asyncPrecacheFailed: 0}}}}]}));
  const file = path.join(directory, '0-corpus.json');
  fs.writeFileSync(file, JSON.stringify({version: 1, devices: [{id: 1, descriptor: {}}],
    modules: [], layouts: [], descriptors: [{id: 1, deviceId: 1, kind: 'compute', descriptor: {}}],
    requests: [{name: 'createComputePipelineAsync', descriptorId: 1, success: true}]}));
  return file;
}
const source = fixture('source');
const project = fixture('project-settings', false);
const projectConfigFile = path.join(project, 'config-files.json');
const projectConfig = fs.readFileSync(projectConfigFile);
const projectPage = readPage(project);
projectPage.assets.gameFrameBridge = 'page-raf';
projectPage.args.push('-WebGameLocalClock', '-WebFrameScheduler=1');
writePage(project, projectPage);
applyAcceptedDefaults(project, {preserveProjectSettings: true});
const preparedProjectPage = readPage(project);
assert(fs.readFileSync(projectConfigFile).equals(projectConfig), 'Preserve staged project INIs byte for byte');
for (const [key, value] of Object.entries(runtimeAssets))
  assert.equal(preparedProjectPage.assets[key], value, 'Project-settings package lost ' + key);
assert(!preparedProjectPage.assets.gameFrameBridge, 'Remove the obsolete page bridge');
assert.deepEqual(preparedProjectPage.args, ['-webgpu', '-WebProjectMap=/Game/Fixture']);
applyAcceptedDefaults(project, {preserveProjectSettings: true, disableMouseSmoothing: true});
const mouseConfig = JSON.parse(fs.readFileSync(projectConfigFile));
const inputPath = '/Engine/Programs/UEWebEngine/Config/DefaultInput.ini';
const inputConfig = mouseConfig.find(item => item.path === inputPath);
assert(Buffer.from(inputConfig.data, 'base64').toString().endsWith('\nbEnableMouseSmoothing=False\n'));
assert.deepEqual(mouseConfig.filter(item => item.path !== inputPath), JSON.parse(projectConfig),
  'The desktop mouse override can only change the packaged input configuration');
const blurProject = fixture('project-motion-blur', false);
applyAcceptedDefaults(blurProject, {preserveProjectSettings: true, disableMotionBlur: true});
const blurConfig = JSON.parse(fs.readFileSync(path.join(blurProject, 'config-files.json')));
assert.deepEqual(blurConfig.map(item => item.path), JSON.parse(projectConfig).map(item => item.path));
const originalIni = Buffer.from(JSON.parse(projectConfig)[0].data, 'base64').toString();
assert.equal(Buffer.from(blurConfig[0].data, 'base64').toString(),
  originalIni + '\n[SystemSettings]\nr.MotionBlurQuality=0\n');
assert.equal(require('./web-accepted-defaults.cjs').settings['r.WebGPU.IndirectDrawReuse'], 2,
  'The corrected manual result restores accepted indirect reuse in ordinary releases');
assert.equal(require('./web-accepted-defaults.cjs').settings['r.WebGPU.VSMPageOptimization'], 3);
assert.equal(require('./web-accepted-defaults.cjs').settings['r.WebGPU.TSRLargeTiles'], 0,
  'Unaccepted TSR large tiles must stay opt-in in ordinary releases');
const sourceConfig = JSON.parse(fs.readFileSync(path.join(source, 'config-files.json')));
const effectiveTSR = Buffer.from(sourceConfig.find(item =>
  item.path === '/Engine/Platforms/Web/Config/WebEngine.ini').data, 'base64').toString()
  .match(/^r\.WebGPU\.TSRLargeTiles=(\d+)$/gm)?.at(-1);
assert.equal(effectiveTSR, 'r.WebGPU.TSRLargeTiles=0',
  'The actual published configuration must restore the accepted small tiles');
const effectiveIndirectReuse = Buffer.from(sourceConfig.find(item =>
  item.path === '/Engine/Platforms/Web/Config/WebEngine.ini').data, 'base64').toString()
  .match(/^r\.WebGPU\.IndirectDrawReuse=(\d+)$/gm)?.at(-1);
assert.equal(effectiveIndirectReuse, 'r.WebGPU.IndirectDrawReuse=2',
  'Published defaults must override inherited indirect reuse settings');
assert(!readPage(source).args.includes('-WebPSOPrecacheTest'), 'Accepted defaults must not request speculative PSOs');
const corpus = capture(source);
const automaticSource = readPage(source);
automaticSource.args.push('-WebPSOPrecache');
writePage(source, automaticSource);
const automaticCorpus = capture(source);
const dest = fixture('dest');
const coreHashes = coreFiles.map(name => audit(path.join(dest, name)).sha256);
// A repackager can inherit old workers and even an HTML file through hardlinks.
fs.writeFileSync(path.join(source, 'web-content-worker.js'), 'archived worker');
fs.linkSync(path.join(source, 'web-content-worker.js'), path.join(dest, 'web-content-worker.js'));
fs.unlinkSync(path.join(dest, 'index.html'));
fs.linkSync(path.join(source, 'index.html'), path.join(dest, 'index.html'));
const archivedHTML = audit(path.join(source, 'index.html')).sha256;
let calls = 0;
const options = {resultsDirectory, capture(folder) {++calls; return capture(folder);}};
const reused = finalizeDesktopRelease(dest, options);
assert(reused.releaseReady);
assert.equal(reused.prewarm.selection, 'automatic-reuse');
assert.equal(calls, 0, 'A matching capture needs no browser run');
assert.equal(reused.prewarm.source, 'automatic-collectors');
assert(readPage(dest).args.includes('-WebPSOPrecache'));
assert(!readPage(dest).args.includes('-WebPSOPrecacheTest'));
assert.equal(reused.renderSizing, 'css-dpr-once');
assert.equal(fs.readFileSync(path.join(source, 'web-content-worker.js'), 'utf8'), 'archived worker');
assert.equal(audit(path.join(source, 'index.html')).sha256, archivedHTML, 'Archived hardlink was overwritten');
assert.deepEqual(coreFiles.map(name => audit(path.join(dest, name)).sha256), coreHashes);
verifyDesktopRelease(dest, reused);
fs.appendFileSync(path.join(dest, 'web-content-worker.js'), 'stale');
assert.throws(() => verifyDesktopRelease(dest, reused), /Stale release runtime/);
finalizeDesktopRelease(dest, options);
const page = readPage(dest);
page.args.push('-ResX=1920', '-ResY=1080', '-ForceRes');
writePage(dest, page);
assert.throws(() => prepareRecordedPrewarm(dest, automaticCorpus), /render size differ/);
const fixed = finalizeDesktopRelease(dest, options);
assert.equal(calls, 1, 'Different startup sizing must capture again');
assert.equal(fixed.prewarm.selection, 'automatic-capture');
assert.deepEqual(readPage(dest).assets.fixedRenderSize, {width: 1920, height: 1080});
assert.equal(fixed.renderSizing, 'fixed-physical-pixels');
fs.appendFileSync(path.join(dest, 'config-files.json'), ' ');
finalizeDesktopRelease(dest, options);
assert.equal(calls, 2, 'Configuration changes invalidate prewarm');
const changedMap = readPage(dest);
changedMap.args = changedMap.args.map(arg => arg === '-WebProjectMap=/Game/Fixture' ? '-WebProjectMap=/Game/Other' : arg);
writePage(dest, changedMap);
finalizeDesktopRelease(dest, options);
assert.equal(calls, 3, 'Different startup map must capture again');
assert.throws(() => finalizeDesktopRelease(dest, {...options, refresh: true, capture() {throw Error('GPU unavailable');}}),
  /GPU unavailable/, 'Capture failure must not silently enable speculative precaching');
assert(!readPage(dest).assets.pipelinePrewarm);
assert(!readPage(dest).args.includes('-WebPSOPrecacheTest'));
const diagnostic = finalizeDesktopRelease(dest, {legacyPrecache: true});
assert(!diagnostic.releaseReady && readPage(dest).args.includes('-WebPSOPrecacheTest'));
assert(!readPage(dest).args.includes('-WebPSOPrecache'));
const captureOnly = finalizeDesktopRelease(dest, {captureOnly: true});
assert(!captureOnly.releaseReady && !readPage(dest).args.includes('-WebPSOPrecacheTest'));
assert(!readPage(dest).args.includes('-WebPSOPrecache'));
assert.throws(() => releaseOptions(['--capture-prewarm', '--legacy-precache']));
assert.throws(() => releaseOptions(['--render-size=1920,1080']));
assert.throws(() => releaseOptions(['--render-size=9999x1080']));
assert.deepEqual(releaseOptions(['--render-size=1920x1080']).renderSize, {width: 1920, height: 1080});
const explicitSize = finalizeDesktopRelease(dest, {captureOnly: true, renderSize: {width: 1600, height: 900}});
assert.deepEqual(explicitSize.fixedRenderSize, {width: 1600, height: 900});
assert.deepEqual(readPage(dest).args.slice(-3), ['-ResX=1600', '-ResY=900', '-ForceRes']);
assert.throws(() => resolveWebRenderSize({}, ['-ForceRes', '-ResX=1920']));
assert.throws(() => resolveWebRenderSize({fixedRenderSize: {width: 1, height: 1}},
  ['-ForceRes', '-ResX=1920', '-ResY=1080']), /disagrees/);
const maskedCorpus = capture(source, true);
assert.throws(() => prepareRecordedPrewarm(source, maskedCorpus), /masked-device capture/);
const incompleteFile = path.join(path.dirname(automaticCorpus), 'result.json');
const completeCapture = JSON.parse(fs.readFileSync(incompleteFile));
for (const change of [
  run => {run.last.worker.pso.active = 1;},
  run => {run.last.worker.rhi.asyncPrecacheFailed = 1;},
  run => {run.precacheRejections = ['unaccounted pipeline failure'];},
  run => {run.last.worker.calls = {createComputePipelineAsync: {failed: 1}};},
]) {
  const incomplete = structuredClone(completeCapture);
  change(incomplete.runs[0]);
  fs.writeFileSync(incompleteFile, JSON.stringify(incomplete));
  assert.throws(() => prepareRecordedPrewarm(source, automaticCorpus),
    /collectors and browser compiles must complete|native failures or unaccounted pipeline rejections/);
}
fs.writeFileSync(incompleteFile, JSON.stringify(completeCapture));
const movement = fixture('movement'), movementPage = readPage(movement);
movementPage.args = movementPage.args.map(arg => arg === '-WebProjectMap=/Game/Fixture' ?
  '-WebProjectMap=/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla' : arg);
movementPage.assets.pipelineWarmup = {modes: [3, 2, 1], seconds: 20};
writePage(movement, movementPage);
const movementCorpus = capture(movement), movementResult = path.join(path.dirname(movementCorpus), 'result.json');
assert.throws(() => prepareRecordedPrewarm(movement, movementCorpus), /movement coverage/);
const movementCapture = JSON.parse(fs.readFileSync(movementResult));
Object.assign(movementCapture, {scriptedMotionModes:[3,2,1], scriptedMotionSeconds:20,
  runs:[{engine:'ours',pass:true,scriptedMotion:[3,2,1].map(mode => ({motion:{mode,elapsed:20,completed:true,updates:600}}))}]});
fs.writeFileSync(movementResult, JSON.stringify(movementCapture));
prepareRecordedPrewarm(movement, movementCorpus);
movementCapture.runs[0].scriptedMotion[0].motion.completed = false;
fs.writeFileSync(movementResult, JSON.stringify(movementCapture));
assert.throws(() => prepareRecordedPrewarm(movement, movementCorpus), /routes did not complete/);
const villa = finalizeDesktopRelease(movement, {resultsDirectory, capture(folder) {
  assert(!readPage(folder).assets.pipelineWarmup, 'Ordinary Villa capture must not move the camera');
  return capture(folder);
}});
assert.equal(villa.prewarm.source, 'automatic-collectors');
const acceptedConfigs = JSON.parse(fs.readFileSync(path.join(source, 'config-files.json')));
assert(acceptedConfigs.some(item => Buffer.from(item.data, 'base64').toString()
  .includes('r.Shadow.Virtual.SMRT.AdaptiveRayCount=1')));
assert(acceptedConfigs.some(item => Buffer.from(item.data, 'base64').toString()
  .includes('r.WebGPU.IndirectDrawReuse=2')));
console.log(JSON.stringify({pass: true, automaticReuse: true, invalidatedCaptures: calls,
  hardlinksPreserved: true, staleWorkersRejected: true, captureFailureBlocksRelease: true,
  forcedPhysicalSize: fixed.fixedRenderSize, diagnosticsRequireExplicitFlags: true,
  automaticCollectorCompletionRequired: true, nativeFailuresRejected: true,
  maskedCapturesRejected: true, adaptiveDefault: true, acceptedIndirectReuseRestored: true,
  inheritedIndirectReuseOverridden: true, startupOnlyVillaCaptureRejected:true, unfinishedRoutesRejected:true}));
