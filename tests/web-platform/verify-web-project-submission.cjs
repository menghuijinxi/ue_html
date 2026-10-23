const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), reports: [],
  visualParityVerified: false, streamingImplemented: false, longTermVramBudgetVerified: false};
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) assert.equal(audit(value.file).sha256, value.sha256, value.file);
  for (const child of Object.values(value)) visit(child);
}
function evidence(name) {
  const file = path.join(directory, name), value = read(file);
  assert(value.pass, file);
  visit(value);
  report.reports.push(audit(file));
  return value;
}
function browserMemory(profile, phase) {
  const existing = new Set(profile.before.wddmGpuProcesses.map(process => process.pid));
  const rows = phase.after.wddmGpuProcesses.filter(process => !existing.has(process.pid) && process.dedicated > 0);
  const ids = new Set(rows.map(process => process.pid));
  assert.equal(ids.size, 1, 'Expected exactly one new GPU process in this isolated browser run');
  return {pid: rows[0].pid, dedicatedBytes: rows.reduce((sum, row) => sum + row.dedicated, 0),
    sharedBytes: rows.reduce((sum, row) => sum + row.shared, 0),
    committedBytes: rows.reduce((sum, row) => sum + row.committed, 0)};
}
function imageDifference(a, b) {
  const first = PNG.sync.read(fs.readFileSync(a)), second = PNG.sync.read(fs.readFileSync(b));
  assert(first.width === second.width && first.height === second.height);
  let square = 0;
  for (let index = 0; index < first.data.length; ++index)
    if (index % 4 !== 3) square += (first.data[index] - second.data[index]) ** 2;
  return Math.sqrt(square / (first.width * first.height * 3));
}
try {
  execFileSync(process.execPath, [path.join(__dirname, 'verify-web-project-surfaces.cjs'),
    '--report=submission-final', '--texture-probe=submission-native-texture',
    '--output=triplex-house-villa-submission-surfaces-audit-results'], {stdio: 'pipe'});
  const surfaces = evidence('triplex-house-villa-submission-surfaces-audit-results.json');
  evidence('web-static-uniforms-native-results.json');
  const current = evidence('triplex-house-villa-submission-cached-profile-results.json');
  const baselineFile = path.join(directory, 'triplex-house-villa-submission-baseline-profile-results.json');
  const baseline = read(baselineFile);
  // Historical package references describe the previous binary, not the current package.
  assert(baseline.pass);
  report.historicalBaseline = audit(baselineFile);
  visit(baseline.phases[0].cpuProfile);
  report.before = baseline.phases[0];
  report.after = current.phases[0];
  for (const profile of [baseline, current]) {
    assert(profile.phases.length === 7);
    for (const phase of profile.phases)
      assert(phase.sample.frames > 0 && !phase.sample.errors.length && !phase.sample.deviceLosses.length);
  }
  assert(report.after.fps > report.before.fps * 2);
  assert(report.after.averageCallbackMs < report.before.averageCallbackMs * 0.5);
  assert(report.after.callsPerFrame['GPUDevice.createBuffer'] < report.before.callsPerFrame['GPUDevice.createBuffer'] * 0.1);
  report.beforeGpuProcess = browserMemory(baseline, baseline.phases[0]);
  report.afterGpuProcess = browserMemory(current, current.phases[0]);
  assert(report.afterGpuProcess.dedicatedBytes < report.beforeGpuProcess.dedicatedBytes * 0.6);
  const memorySamples = current.phases.map(phase => browserMemory(current, phase));
  assert(memorySamples.every(sample => sample.pid === report.afterGpuProcess.pid));
  report.peakBrowserDedicatedBytes = Math.max(...memorySamples.map(sample => sample.dedicatedBytes));
  report.browsers = surfaces.browsers;
  const previous = read(path.join(directory, 'web-project-triplex-house-villa-pbr-final-results.json'));
  report.visualStability = surfaces.browsers.map(run => {
    const before = previous.runs.find(candidate => candidate.browser === run.browser).screenshot;
    visit(before);
    const rms = imageDifference(before.file, run.screenshot.file);
    assert(rms < 3, `${run.browser} image changed after submission optimization`);
    return {browser: run.browser, before, after: run.screenshot, rms};
  });
  const rhiFile = path.resolve(__dirname,
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp');
  assert(fs.readFileSync(rhiFile, 'utf8').includes('GRHISupportsTextureStreaming = false;'));
  report.boundary = 'Current-source build, native snapshot/rebinding readbacks, browser controls, default scene, ' +
    'CPU profiles, before/after per-frame buffer allocations and WDDM GPU process memory verified. ' +
    'Global NVIDIA memory includes other applications. WDDM process identification requires a single new GPU PID. ' +
    'Texture streaming and room-scale indoor sky occlusion remain missing. Material appearance is unchanged; ' +
    'this is not PBR/editor parity or a long-term memory-budget acceptance.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
const file = path.join(directory, 'triplex-house-villa-submission-audit-results.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, beforeFps: report.before?.fps, afterFps: report.after?.fps,
  beforeGpuProcess: report.beforeGpuProcess, afterGpuProcess: report.afterGpuProcess, failure: report.failure}, null, 2));
