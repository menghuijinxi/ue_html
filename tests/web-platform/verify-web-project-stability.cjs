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
  streamingImplemented: false, visualParityVerified: false, longTermStabilityVerified: false};
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) assert.equal(audit(value.file).sha256, value.sha256, value.file);
  for (const child of Object.values(value)) visit(child);
}
function evidence(name) {
  const file = path.join(directory, name), result = read(file);
  assert(result.pass, file);
  visit(result);
  report.reports.push(audit(file));
  return result;
}
try {
  const failureFile = path.join(directory, 'web-project-triplex-house-villa-crash-before-layout-edge-results.json');
  const failure = read(failureFile);
  assert(!failure.pass && failure.samples.some(sample => sample.gpu.errors.some(error =>
    error.message.includes('MobileCSMAndSpotLightShadowmap') &&
    error.message.includes('expected sample types (Float)'))));
  assert(failure.samples.some(sample => sample.failure === 'unreachable') &&
    failure.engineErrors.some(error => error.includes('FinalPreExposure > 0.0f')));
  report.historicalFailure = audit(failureFile);
  report.historicalFailureBoundary = 'The failed run used the previous binary and probe revision; their package/source references are historical.';
  const userFile = path.join(directory, 'user-startup-crash-20261023.json');
  const user = read(userFile);
  assert(user.failure === 'unreachable' && user.frames === 926 &&
    user.engineLog.some(line => line.includes('MobileCSMAndSpotLightShadowmap')) &&
    user.engineLog.some(line => line.includes('FinalPreExposure > 0.0f')));
  report.userDiagnostics = audit(userFile);
  execFileSync(process.execPath, [path.join(__dirname, 'verify-web-project-surfaces.cjs'),
    '--report=crash-shadow-surfaces', '--texture-probe=crash-shadow-native-texture',
    '--output=triplex-house-villa-crash-shadow-surfaces-audit-results'], {stdio: 'pipe'});
  evidence('triplex-house-villa-crash-shadow-surfaces-audit-results.json');
  const native = evidence('web-static-uniforms-native-results.json');
  report.nativeChecks = native.runs.reduce((sum, run) => {
    const result = read(run.runtime.file);
    return sum + (result.modes ? result.modes.reduce((total, mode) => total + mode.checks.length, 0) :
      result.material.checks.length);
  }, 0);
  const packaged = evidence('web-project-triplex-house-villa-package-results.json');
  report.browsers = [];
  for (const name of ['chrome', 'edge']) {
    const run = evidence(`web-project-triplex-house-villa-crash-shadow-fixed-${name}-results.json`);
    assert.equal(run.packageReport.sha256, audit(path.join(directory,
      'web-project-triplex-house-villa-package-results.json')).sha256);
    assert(run.mode === 'tour' && run.seconds >= 180 && run.viewport.width === user.screen.width &&
      run.viewport.height === user.screen.height && run.viewport.dpr === user.screen.dpr);
    const elapsedSeconds = run.samples.at(-1).elapsedSeconds;
    assert(run.final.frame > user.frames * 2 && elapsedSeconds >= 180);
    assert(run.samples.every(sample => !sample.failure && !sample.gpu.errors.length &&
      !sample.gpu.deviceLosses.length) && !run.errors.length && !run.engineErrors.length);
    assert(run.final.gpu.shadowLayouts.flat().some(item => item.binding === 6 &&
      item.layout.texture.sampleType === 'unfilterable-float' &&
      item.samplers.some(sampler => sampler.binding === 10 && sampler.sampler.type === 'non-filtering')));
    const image = PNG.sync.read(fs.readFileSync(run.screenshot.file));
    const colors = new Set();
    for (let offset = 0; offset < image.data.length; offset += 4) colors.add(image.data.readUInt32LE(offset));
    assert(colors.size > 1000 && image.width === run.final.canvas.width && image.height === run.final.canvas.height);
    report.browsers.push({browser: run.browser, frames: run.final.frame,
      elapsedSeconds, canvas: run.final.canvas, colors: colors.size,
      screenshot: run.screenshot});
  }
  assert.equal(packaged.textureCompression, 'BC');
  report.boundary = 'Reproduces the same shadow bind-group validation error and exposure assertion. ' +
    'Current hashes, native regressions, compressed textures, lighting controls, default scene and two high-DPI ' +
    'three-minute camera tours are verified. Does not establish indefinite stability, texture streaming, a VRAM budget or editor visual parity.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
}
const file = path.join(directory, 'triplex-house-villa-crash-stability-audit-results.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, nativeChecks: report.nativeChecks,
  browsers: report.browsers, failure: report.failure}, null, 2));
