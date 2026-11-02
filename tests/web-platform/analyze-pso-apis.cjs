'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const mainTag = process.argv[2], controlTag = process.argv[3];
assert([mainTag, controlTag].every(x => /^[a-z0-9-]+$/.test(x)));
const file = tag => path.join(__dirname, 'results', tag + '.json');
const primary = JSON.parse(fs.readFileSync(file(mainTag))), control = JSON.parse(fs.readFileSync(file(controlTag)));
assert(primary.pass && control.pass && !primary.noDiskCache && control.noDiskCache && control.webOnly);
assert.equal(primary.SEED, control.SEED); assert.equal(primary.N, control.N);
assert.deepEqual(primary.source, control.source);
function stats(values) {
  const a = values.sort((a, b) => a - b); assert(a.length);
  return {count: a.length, values: a, mean: a.reduce((s, n) => s + n, 0) / a.length,
    median: a[Math.floor(a.length / 2)], min: a[0], max: a.at(-1)};
}
for (const input of [primary, control]) for (const run of input.runs) {
  assert(run.outputVerified && run.pipelines === 128);
  if (run.backend === 'WebGPU') {
    assert.equal(run.createdDuringRuntime, 0);
    assert.equal(run.created, 128); assert.equal(run.errors.length, 0);
  }
}
const warmWeb = input => input.runs.filter(r => r.backend === 'WebGPU' && ['page-reload', 'browser-reopen'].includes(r.state));
const native = primary.runs.filter(r => r.backend === 'D3D12' && r.state.startsWith('library-reopen'));
const nativeBlobs = primary.runs.filter(r => r.backend === 'D3D12' && r.state.startsWith('blobs-reopen'));
assert(nativeBlobs.length >= 2 && nativeBlobs.every(r => r.cachedBlobsProvided === 128 && r.cachedBlobsSucceeded === 128));
assert(native.length >= 2 && native.every(r => r.libraryHits === 128 && r.created === 0 && r.libraryInputBytes > 0));
const web = warmWeb(primary), webControl = warmWeb(control);
assert(web.length >= 3 && webControl.length >= 3);
const result = {date: new Date().toISOString(), pass: false, inputs: [file(mainTag), file(controlTag)],
  webRestartPipelineCreationMs: stats(web.map(x => x.creationWallMs)),
  webReloadPipelineCreationMs: stats(web.filter(x => x.state === 'page-reload').map(x => x.creationWallMs)),
  webReopenPipelineCreationMs: stats(web.filter(x => x.state === 'browser-reopen').map(x => x.creationWallMs)),
  nativeLibraryLoadPipelineMs: stats(native.map(x => x.creationWallMs)),
  nativeLibraryLoadIncludingReadAndInitMs: stats(native.map(x => x.creationWallMs + x.libraryReadMs + x.libraryInitMs)),
  nativeCachedBlobIncludingReadMs: stats(nativeBlobs.map(x => x.creationWallMs)),
  webDiskDisabledRestartPipelineMs: stats(webControl.map(x => x.creationWallMs)), runtime: []};
result.restartMeanRatioWebToDX12 = result.webRestartPipelineCreationMs.mean / result.nativeLibraryLoadIncludingReadAndInitMs.mean;
result.restartMeanRatioWebToDX12Blob = result.webRestartPipelineCreationMs.mean / result.nativeCachedBlobIncludingReadMs.mean;
result.diskDisabledToEnabledMeanRatio = result.webDiskDisabledRestartPipelineMs.mean / result.webRestartPipelineCreationMs.mean;
for (const [backend, runs] of [['WebGPU', web], ['D3D12', native]]) for (const kind of ['graphics', 'compute']) for (let mode = 0; mode < 3; mode++) {
  const samples = runs.flatMap(r => r.runtime.filter(x => x.kind === kind && x.mode === mode));
  assert(samples.length >= 2 && samples.every(x => x.encode.count === 80 && x.bindOnly.count === 80));
  result.runtime.push({backend, kind, mode,
    bindOnlyCpuMsPer1000: stats(samples.map(s => s.bindOnly.medianMs / 10)),
    encodeCpuMsPer1000: stats(samples.map(s => s.encode.medianMs)),
    finishSubmitAndWaitMs: stats(samples.map(s => s.closeSubmitFence.medianMs))});
}
result.traceDiagnostics = primary.runs.concat(control.runs).filter(x => x.state === 'cache-trace-diagnostic').map(x => ({
  noDiskCache: control.runs.includes(x), browserRound: x.browserRound, ...x.trace}));
result.pass = true;
const output = path.join(__dirname, 'results', mainTag + '-comparison.json');
fs.writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
