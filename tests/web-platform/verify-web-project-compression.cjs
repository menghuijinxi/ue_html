const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
assert.equal(id, 'triplex-house-villa', 'This acceptance gate uses the fixed villa baseline');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const cache = new Map();
const sha = file => {
  const absolute = path.resolve(file);
  if (!cache.has(absolute))
    cache.set(absolute, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  return cache.get(absolute);
};
const audit = file => ({file, sha256: sha(file)});
const report = {date: new Date().toISOString(), pass: false, entries: 0, reports: [], mismatches: [],
  source: audit(__filename), performanceAccepted: false, vramBudgetVerified: false};
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) {
    ++report.entries;
    try {
      if (sha(value.file) !== value.sha256) report.mismatches.push(value.file);
    } catch (error) { report.mismatches.push(value.file + ': ' + error.message); }
  }
  for (const child of Object.values(value)) visit(child);
}
try {
  const names = ['web-engine-full-build-results.json',
    'web-engine-webgpu-es31-default-cook-results.json', 'web-engine-webgpu-es31-default-stage-results.json',
    'web-default-template-package-results.json', 'web-default-scene-results.json',
    ...['prepare', 'cook', 'stage', 'package', 'bc-final', 'bc-preflight']
      .map(name => `web-project-${id}-${name}-results.json`),
    'web-startup-transfers-bc-current-results.json', 'triplex-textures-bc-final.json', 'triplex-textures-uncompressed.json'];
  for (const name of names) {
    const file = path.join(directory, name), result = read(file);
    assert.equal(result.pass, true, name);
    visit(result);
    report.reports.push(audit(file));
  }
  const nativeFile = path.join(__dirname, 'build/bc-native-texture/texture-srv-results.json');
  const native = read(nativeFile);
  assert(native.pass && native.modes.length === 2 && native.modes.every(mode =>
    mode.pass && mode.checks.length === 80 && mode.checks.every(check => check.pass) && !mode.errors.length));
  report.nativeChecks = native.modes.reduce((sum, mode) => sum + mode.checks.length, 0);
  report.nativeValues = native.modes.reduce((sum, mode) => sum + mode.checkedValues, 0);
  report.native = [nativeFile, path.join(__dirname, 'results/bc-native-texture.log'),
    ...['Private/WebGPUTextureSRVProbe.cpp', 'Private/WebGPUDynamicRHI.cpp'].map(name =>
      path.resolve(__dirname, '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', name)),
    path.resolve(__dirname, '../ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll')].map(audit);
  const before = read(path.join(directory, 'triplex-textures-uncompressed.json'));
  const after = read(path.join(directory, 'triplex-textures-bc-final.json'));
  for (const product of read(before.cookReport.file).products) visit(product);
  assert.equal(before.count, after.count);
  const old = new Map(before.textures.map(item => [item.file, item]));
  for (const item of after.textures) {
    const prior = old.get(item.file);
    assert(prior && prior.width === item.width && prior.height === item.height &&
      prior.mips === item.mips && prior.faces === item.faces, item.file);
  }
  assert(after.estimatedBytes < before.estimatedBytes * 0.2);
  report.textureBytes = {before: before.estimatedBytes, after: after.estimatedBytes,
    reduction: 1 - after.estimatedBytes / before.estimatedBytes};
  const runtime = read(path.join(directory, `web-project-${id}-bc-final-results.json`));
  assert.equal(runtime.runs.length, 2);
  assert(runtime.runs.every(run => run.textureCompressionVerified && !run.gpu.errors.length &&
    !run.gpu.deviceLosses.length && Object.keys(run.gpu.textureFormats).some(format => format.startsWith('bc6h-'))));
  report.browsers = runtime.runs.map(run => ({browser: run.browser,
    textureDescriptorBytesCreated: run.gpu.textureDescriptorBytesCreated,
    expandedEquivalentBytes: run.gpu.textureUncompressedEquivalentBytesCreated,
    fps: run.performance.engineFps, contentCompatibilityPass: run.contentCompatibilityPass}));
  assert.equal(report.mismatches.length, 0, JSON.stringify(report.mismatches));
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
}
report.uniqueFiles = cache.size;
fs.writeFileSync(path.join(directory, 'triplex-bc-final-audit-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, entries: report.entries, uniqueFiles: report.uniqueFiles,
  nativeChecks: report.nativeChecks, mismatches: report.mismatches, failure: report.failure}, null, 2));
