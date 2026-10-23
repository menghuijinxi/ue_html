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
  localDiskStreamingImplemented: true, perTextureNetworkStreaming: false,
  totalCpuMemoryBounded: false, editorParityVerified: false};
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) {
    const file = path.resolve(value.file);
    if (!checked.has(file)) checked.set(file, audit(file).sha256);
    assert.equal(checked.get(file), value.sha256, file);
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
  for (const name of ['web-engine-full-build-results.json',
    'web-project-triplex-house-villa-cook-results.json',
    'web-project-triplex-house-villa-stage-results.json', 'web-default-template-package-results.json',
    'web-default-scene-results.json', 'triplex-house-villa-local-io-surfaces-audit-results.json'])
    evidence(name);
  const packaged = evidence('web-project-triplex-house-villa-package-results.json');
  assert.equal(packaged.textureCompression, 'BC');
  const manifest = read(path.join(packaged.output, 'content-files.json'));
  assert.equal(manifest.localIoVersion, 1);
  const bulk = manifest.files.filter(file => file.path.endsWith('.ubulk'));
  report.bulkFiles = bulk.length;
  report.bulkDiskBytes = bulk.reduce((sum, file) => sum + file.size, 0);
  report.startupMemfsBytes = manifest.pack.size - report.bulkDiskBytes;
  assert.equal(report.bulkFiles, 621);
  const http = evidence('web-http-cache-results.json');
  assert.equal(http.unchangedStatus, 304);
  assert.equal(http.changedFileStatus, 200);
  assert.equal(http.staleVersionStatus, 409);
  assert(http.immutable && !http.cacheControl.includes('no-store'));
  report.browsers = [];
  for (const name of ['chrome', 'edge']) {
    const fixture = evidence(`web-local-io-${name}-results.json`).browsers[0];
    assert(fixture.corruptRejected && fixture.warm.callbacks === 0 &&
      fixture.warm.stats.persistentHits === 1 && fixture.warm.stats.downloadedBytes === 0 &&
      fixture.updated.stats.downloads === 1 && fixture.networkPackRequests === 2);
    assert(fixture.cold.evictions > 0 && fixture.cold.peakMemoryBytes <= 16 * 1024 * 1024 &&
      fixture.cold.peakActiveReads <= 4);
    const project = evidence(`web-project-local-io-${name}-results.json`);
    assert.equal(project.packageReport.sha256, audit(path.join(directory,
      'web-project-triplex-house-villa-package-results.json')).sha256);
    assert.equal(project.runs.length, 2);
    for (const run of project.runs) {
      assert.equal(run.errors.length, 0);
      assert.equal(run.requests.length, run.warm ? 0 : 2);
      assert(run.phases.length === 4 && run.phases.every(phase =>
        !phase.failure && !phase.streaming.pending && phase.streaming.supported &&
        phase.streaming.residentMips === phase.streaming.requestedMips &&
        phase.bulkFiles === report.bulkFiles && phase.bulkMemfsBytes === 0 &&
        phase.local.peakMemoryBytes <= phase.local.memoryLimit &&
        phase.local.memoryLimit === 16 * 1024 * 1024));
      const [spawn, high, low, recovered] = run.phases;
      assert.equal(spawn.local.downloads, run.warm ? 0 : 2);
      if (run.warm) assert(spawn.local.persistentHits >= 2 && !spawn.local.downloadedBytes);
      assert(low.streaming.residentBytes < high.streaming.residentBytes * 0.8 &&
        recovered.streaming.residentBytes > low.streaming.residentBytes * 1.25 &&
        recovered.local.diskReads > low.local.diskReads &&
        recovered.local.downloadedBytes === high.local.downloadedBytes);
      const image = PNG.sync.read(fs.readFileSync(run.screenshot.file));
      const colors = new Set();
      for (let offset = 0; offset < image.data.length; offset += 4)
        colors.add(image.data.readUInt32LE(offset));
      assert(colors.size > 1000, 'Scene screenshot is blank');
    }
    const stabilitySuffix = name === 'edge' ? 'local-io-stability-repeat' : 'local-io-stability';
    const stability = evidence(`web-project-triplex-house-villa-${stabilitySuffix}-${name}-results.json`);
    assert.equal(stability.packageReport.sha256, project.packageReport.sha256);
    assert(stability.seconds >= 180 && stability.final.frame > stability.initial.frame + 1000 &&
      !stability.errors.length && !stability.engineErrors.length);
    assert(stability.samples.every(sample => !sample.failure && sample.streaming?.supported &&
      !sample.gpu.errors.length && !sample.gpu.deviceLosses.length));
    report.browsers.push({browser: project.browser, coldDownloads: project.runs[0].requests.length,
      warmDownloads: project.runs[1].requests.length,
      offlineDiskReads: project.runs[1].phases[3].local.diskReads - project.runs[1].phases[2].local.diskReads,
      localBlockCacheLimit: project.runs[1].phases[3].local.memoryLimit,
      stabilityFrames: stability.final.frame - stability.initial.frame});
  }
  const failedFile = path.join(directory,
    'web-project-triplex-house-villa-local-io-stability-edge-sequence-failure-results.json');
  const failed = read(failedFile);
  assert(!failed.pass && /cannot be converted to a sequence/.test(failed.failure));
  visit(failed);
  report.unresolvedRenderingFailure = {...audit(failedFile), browser: 'Edge',
    frame: failed.samples.at(-1).frame, message: failed.errors[0],
    boundary: 'A repeated three-minute tour passed unchanged; the earlier binding exception remains unexplained.'};
  report.uniqueFiles = checked.size;
  report.boundary = 'Whole immutable content/WASM files are cached in OPFS on first use. Mip reads use local disk ' +
    'with a 16 MiB block LRU and at most four worker operations, without per-texture or HTTP Range requests. ' +
    'Startup uasset/uexp/config files, low mip tails, geometry and engine allocations still occupy memory; ' +
    'the LRU limit is not a total application or transient IO memory limit. Browser storage eviction, clearing ' +
    'site data, a new origin or changed content requires another whole-file download. ' +
    'Editor rendering parity, phone support and physical VRAM caps remain outside this acceptance. ' +
    'This is local IO acceptance, not a claim that the recorded intermittent Edge binding failure is fixed.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
const file = path.join(directory, 'triplex-house-villa-local-io-audit-results.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, browsers: report.browsers,
  bulkFiles: report.bulkFiles, bulkDiskBytes: report.bulkDiskBytes,
  startupMemfsBytes: report.startupMemfsBytes, uniqueFiles: report.uniqueFiles, failure: report.failure}, null, 2));
