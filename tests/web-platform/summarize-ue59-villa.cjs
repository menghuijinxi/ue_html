'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const engine = 'E:/UE59WebBenchmark/engine-5.9';
const archive = 'E:/UE59WebBenchmark/package/Wasm';
const stage = path.join(__dirname, 'build', 'ue59-official-villa-20261109');
const results = path.join(__dirname, 'results', 'ue59-official-villa');
const commit = '589a52b5abcf7b0ee0e2fd9de58b4d2872672f21';
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (file, algorithm = 'sha256') => {
  const digest = crypto.createHash(algorithm);
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
};
const git = (...args) => execFileSync('git', ['-C', engine, ...args], { encoding: 'utf8', windowsHide: true }).trim();
assert.equal(git('rev-parse', 'HEAD'), commit);
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Official engine tracked files changed');

function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(directory, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
}

const archivedFiles = files(archive);
for (const relative of archivedFiles) {
  assert.equal(hash(path.join(archive, relative), 'sha1'), hash(path.join(stage, relative), 'sha1'), relative);
}
const manifests = {};
for (const name of ['wasm-manifest.json', 'wasm-cache.json']) {
  const entries = json(path.join(stage, name));
  for (const entry of entries) {
    const file = path.join(stage, entry.url);
    assert.equal(fs.statSync(file).size, entry.size, entry.url);
    if (entry.sha1) assert.equal(hash(file, 'sha1'), entry.sha1, entry.url);
    if (entry.br) assert.equal(fs.statSync(file + '.br').size, entry.br, entry.url);
  }
  manifests[name] = { entries: entries.length, sizesAndHashesMatch: true };
}
const inputs = json('E:/UE59WebBenchmark/TriplexHouseVilla/ue59-benchmark-inputs.json');
for (const input of inputs.sourceFiles) {
  assert.equal(hash(path.join(path.dirname(inputs.sourceProject), input.path)), input.sha256, input.path);
}

const measurements = [];
for (const tag of ['official-defaults-20261109', 'normal-page-desktop-20261109', 'desktop-native1080-20261109']) {
  const directory = path.join(results, tag);
  const reportFile = path.join(directory, 'results.json');
  const report = json(reportFile);
  assert(report.pass && report.performanceEligible !== false, `${tag} failed or was a diagnostic run`);
  const diagnostics = json(path.join(directory, 'saved-engine-diagnostics.json'));
  const runs = report.results.map(run => {
    const sampleFile = path.join(directory, `${run.tierRan}-${run.run}-samples.json`);
    const samples = json(sampleFile);
    assert.equal(samples.times.length, run.timing.frames);
    const fps = samples.times.length * 1000 / (samples.measureEndMs - samples.measureStartMs);
    assert(Math.abs(fps - run.timing.fps) < 1e-8);
    assert(run.counterAgreement && run.errors.length === 0 && run.pass);
    return {
      tier: run.tierRan, run: run.run, cache: run.cache, browserVersion: run.browserVersion,
      firstCanvasSeconds: run.firstCanvasSeconds, readySeconds: run.readySeconds,
      dimensions: run.dimensions, timing: run.timing, wasmMemory: run.memory,
      workingSetSumBytes: run.browserMemory.workingSetSumBytes, privateBytesSum: run.browserMemory.privateBytesSum,
      actualArguments: run.engineArguments, pageConfiguration: run.pageConfiguration,
      interaction: run.interaction, counterAgreement: run.counterAgreement, errors: run.errors,
      samplesSha256: hash(sampleFile), screenshotSha256: hash(path.join(directory, `${run.tierRan}-${run.run}.png`)),
    };
  });
  measurements.push({
    tag, reportSha256: hash(reportFile), seconds: report.seconds, warmup: report.warmup,
    bootMode: report.bootMode, qualityOverrides: report.qualityOverrides, runs, diagnostics,
  });
}
const diagnostic = json(path.join(results, 'desktop-diagnostics-v2-20261109', 'results.json'));
assert(diagnostic.pass && diagnostic.performanceEligible === false);
const diagnosticRun = diagnostic.results[0];
assert(diagnosticRun.interaction.distanceCm > 5 && diagnosticRun.interaction.turnDegrees > 1);
const stamp = json(path.join(stage, 'build-stamp.json'));
assert.equal(stamp.tree.commit, commit);
assert.equal(stamp.tree.dirty, false);
const evidence = {
  recordedAt: new Date().toISOString(), engine, commit, trackedEngineClean: true,
  machine: { cpu: 'Intel Core i9-14900KF', ramGiB: 64, gpu: 'NVIDIA GeForce RTX 3070', driver: '610.88',
    browserScheduling: 'default; no CPU affinity override', output: [1920, 1080], deviceScaleFactor: 1 },
  configuration: 'Development, official Emscripten 6.0.10, C++ O2/link O1, all three Wasm shader platforms',
  originalInputs: { count: inputs.sourceFiles.length, sha256Unchanged: true },
  archiveCopy: { files: archivedFiles.length, sha1Matches: true,
    bytes: archivedFiles.reduce((sum, relative) => sum + fs.statSync(path.join(archive, relative)).size, 0) },
  manifests, stamp,
  publicReleaseScan: json(path.join(results, 'stage-check-status.json')),
  measurements,
  separateDiagnostics: { performanceExcluded: true, textureSizes: diagnosticRun.textureSizes, interaction: diagnosticRun.interaction },
  boundaries: [
    'Final canvas CPU submission intervals cross-checked against official RHI present counts, not physical display or GPU completion FPS.',
    'Fresh browser profiles are not cold OS files or cold GPU-driver shader caches. Local unshaped HTTP only.',
    'Two stationary entry-view runs per baseline; the normal page has one supplementary run. No whole-villa performance average.',
    'Default frame gate 2 follows browser animation frames; observed approximately 120 FPS cap in this display environment.',
    'Desktop default auto resolution allocates 1400x792 SceneColor/Depth; 1920x1080 is the canvas output. The separate 100-percent run is explicit.',
    'Desktop is experimental; Lumen reflections are disabled by the official device profile. No native Windows visual parity acceptance.',
    'Texture pool warnings and unbuilt lighting remain. Forward M_GlassBlur falls back to default material; runtime engine warnings remain.',
    'First camera-diagnostic attempt failed in the measurement helper; its results are excluded. The corrected v2 run passed.',
    'Browser working-set sums may double-count shared pages; private bytes measure committed private memory.',
    'No direct performance ratio against the historical customized 5.8 builds. No public deployment.',
  ],
};
const destination = path.join(__dirname, 'evidence', 'ue59-official-villa-20261109.json');
fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ destination, originalInputs: evidence.originalInputs, archiveCopy: evidence.archiveCopy,
  manifests, measurementGroups: measurements.length, passed: true }));
