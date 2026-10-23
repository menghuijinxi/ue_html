const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const checked = new Map();
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), reports: [],
  streamingImplemented: true, httpStreamingImplemented: false, editorParityVerified: false,
  physicalVramBudgetVerified: false};
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) {
    if (!checked.has(value.file)) checked.set(value.file, audit(value.file).sha256);
    assert.equal(checked.get(value.file), value.sha256, value.file);
  }
  for (const child of Object.values(value)) visit(child);
}
function evidence(name) {
  const file = path.join(directory, name), value = read(file);
  assert(value.pass, file);
  visit(value);
  report.reports.push(audit(file));
  return value;
}
try {
  for (const name of ['web-engine-full-build-results.json', 'web-texture-streaming-native-results.json',
    'web-static-uniforms-native-results.json', 'triplex-house-villa-streaming-surfaces-audit-results.json'])
    evidence(name);
  const native = read(path.join(__dirname, 'build/streaming-native-texture/texture-srv-results.json'));
  report.nativeTextureChecks = native.modes.reduce((sum, mode) => sum + mode.checks.length, 0);
  assert.equal(report.nativeTextureChecks, 362);
  const packaged = evidence('web-project-triplex-house-villa-package-results.json');
  assert.equal(packaged.textureCompression, 'BC');
  const cook = evidence('web-project-triplex-house-villa-cook-results.json');
  report.streamedBulkFiles = cook.products.filter(item => item.file.endsWith('.ubulk')).length;
  assert(report.streamedBulkFiles >= 600);
  const inventory = evidence('triplex-textures-streaming.json');
  assert.equal(inventory.count, 667);
  assert.equal(inventory.multiMip, 607);
  const historical = read(path.join(directory, 'web-project-triplex-house-villa-streaming-first-chrome-results.json'));
  assert(!historical.pass && historical.diagnostics.streaming.pending > 100 &&
    historical.diagnostics.streaming.residentBytes < 3 * 1024 * 1024);
  report.historicalIoStall = audit(path.join(directory, 'web-project-triplex-house-villa-streaming-first-chrome-results.json'));
  report.browsers = [];
  for (const name of ['chrome', 'edge']) {
    const run = evidence(`web-project-triplex-house-villa-streaming-final-${name}-results.json`);
    assert.equal(run.packageReport.sha256, audit(path.join(directory,
      'web-project-triplex-house-villa-package-results.json')).sha256);
    assert(run.phases.length >= 9 && run.errors.length === 0 && run.engineErrors.length === 0);
    assert(run.phases.every(phase => !phase.failure && phase.streaming.supported &&
      phase.streaming.streamable > 600 && !phase.streaming.pending &&
      phase.streaming.residentMips === phase.streaming.requestedMips &&
      !phase.gpu.errors.length && !phase.gpu.deviceLosses.length));
    const high = run.phases.find(phase => phase.label === 'room-256');
    const low = run.phases.find(phase => phase.label === 'room-64');
    const restored = run.phases.find(phase => phase.label === 'restored-256');
    assert(low.streaming.residentBytes < high.streaming.residentBytes * 0.8);
    assert(restored.streaming.residentBytes > low.streaming.residentBytes * 1.25);
    assert(restored.gpu.writes > low.gpu.writes && restored.gpu.copies > low.gpu.copies);
    const image = PNG.sync.read(fs.readFileSync(run.screenshot.file));
    const colors = new Set();
    for (let offset = 0; offset < image.data.length; offset += 4) colors.add(image.data.readUInt32LE(offset));
    assert(colors.size > 1000);
    const memory = run.phases.flatMap(phase => phase.gpuProcesses || []);
    if (name === 'chrome') {
      assert(run.cycles >= 8 && new Set(memory.map(row => row.pid)).size === 1);
      const recoveries = run.phases.filter(phase => /^cycle-\d+-256$/.test(phase.label));
      const early = recoveries[0].gpuProcesses.reduce((sum, row) => sum + row.dedicated, 0);
      const late = recoveries.at(-1).gpuProcesses.reduce((sum, row) => sum + row.dedicated, 0);
      assert(late < early + 128 * 1024 * 1024, 'Repeated mip reallocations keep growing driver memory');
    }
    report.browsers.push({browser: run.browser, cycles: run.cycles,
      highResidentBytes: high.streaming.residentBytes, lowResidentBytes: low.streaming.residentBytes,
      restoredResidentBytes: restored.streaming.residentBytes,
      peakProcessDedicatedBytes: memory.length ? Math.max(...memory.map(row => row.dedicated)) : null,
      screenshot: run.screenshot});
  }
  for (const name of ['chrome', 'edge']) {
    const stable = evidence(`web-project-triplex-house-villa-streaming-stability-${name}-results.json`);
    assert(stable.seconds >= 180 && stable.final.frame > stable.initial.frame + 1000);
    assert(stable.samples.every(sample => !sample.failure && !sample.gpu.errors.length &&
      !sample.gpu.deviceLosses.length && sample.streaming?.supported));
    assert(stable.final.gpu.shadowLayouts.flat().some(item =>
      item.layout?.texture?.sampleType === 'unfilterable-float'));
  }
  report.uniqueFiles = checked.size;
  report.boundary = 'UE view-distance/budget mip streaming from the preloaded MEMFS pack, BC mip uploads, shared-mip copies, ' +
    'repeated budget eviction/recovery and browser camera tours are verified. The configured pool also includes fixed ' +
    'non-streaming sampled textures; these and minimum mip tails cannot be evicted to meet an unrealistically small pool. ' +
    'WDDM process measurements include render targets, geometry, shaders and driver caches. ' +
    'HTTP partial downloads, bounded CPU pack memory, physical VRAM caps and editor appearance remain unverified.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
const file = path.join(directory, 'triplex-house-villa-streaming-audit-results.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, browsers: report.browsers,
  nativeTextureChecks: report.nativeTextureChecks, failure: report.failure}, null, 2));
