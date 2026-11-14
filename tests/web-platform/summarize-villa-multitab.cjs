'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..'), files = [];
function read(relative) {
  const file = path.join(__dirname, relative); files.push(audit(file));
  return JSON.parse(fs.readFileSync(file));
}
const before = read('results/content-multitab-20261110-before.json');
const after = read('results/content-multitab-20261110-final.json');
const chrome = read('results/villa-multitab-20261110-fixed-chrome/result.json');
const edge = read('results/villa-multitab-20261110-fixed-edge/result.json');
const packaged = read('results/villa-prewarm-20261110-v4-package.json');
const oldVersions = read('build/villa-prewarm-20261109-v3/asset-versions.json');
const versions = read('build/villa-prewarm-20261110-v4/asset-versions.json');
const profile = read('villa-engine-comparison.json');
assert(!before.pass && before.resumesWhenFirstCloses && after.pass && chrome.pass && edge.pass && packaged.pass);
assert(before.blockedLocks.held.some(lock => lock.mode === 'shared'));
assert(before.blockedLocks.pending.some(lock => lock.mode === 'exclusive'));
assert.equal(profile.ours, 'villa-prewarm-20261110-v4');
assert.equal(audit(path.join(__dirname, 'web-content-worker.js')).sha256, versions['web-content-worker.js'].sha256);
assert.deepEqual(Object.keys(versions).filter(name => oldVersions[name]?.sha256 !== versions[name].sha256).sort(),
  ['index.html', 'web-content-worker.js']);
for (const item of packaged.products) assert.equal(audit(item.file).sha256, item.sha256, item.file);
for (const run of [chrome, edge]) {
  assert.deepEqual(run.errors, []);
  assert.equal(run.states.length, 6);
  const second = run.states.find(state => state.label === 'second-ready-while-first-open');
  assert(second.shown && second.ready && !second.failure);
  assert.equal(second.io.downloads, 0); assert.equal(second.io.persistentHits, 2);
  assert.equal(second.locks.pending.length, 0);
  for (const state of run.states) {
    assert(state.frames >= 30 && state.view.width === 1920 && state.view.height === 1080);
    assert.deepEqual(state.settings, run.states[0].settings);
  }
}
for (const name of ['web-content-worker.js', 'package-villa-prewarm.cjs',
  'verify-web-content-multitab.cjs', 'verify-villa-multitab.cjs'])
  files.push(audit(path.join(__dirname, name)));
const summary = report => ({
  channel: report.channel, pass: report.pass, errors: report.errors,
  states: report.states.map(state => ({label: state.label, frames: state.frames,
    elapsedMs: state.elapsedMs, downloads: state.io.downloads, persistentHits: state.io.persistentHits,
    heldLocks: state.locks.held.map(({name, mode}) => ({name, mode})),
    pendingLocks: state.locks.pending.length}))
});
const evidence = {
  date: '2026-11-10', pass: true, folder: profile.ours,
  diagnosis: 'Every cache hit previously requested an exclusive content lock before acquiring a lifetime shared lease. A second tab waited behind the first tab until it closed. A short preparation lock now serializes checking/downloading; cache hits take shared leases directly.',
  reproduced: {pass: before.pass, error: before.error, blockedLocks: before.blockedLocks,
    resumesWhenFirstCloses: before.resumesWhenFirstCloses},
  cacheRegression: after.cases, browsers: [summary(chrome), summary(edge)],
  unchanged: Object.fromEntries(['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'content.bin',
    'config-files.json', 'pipeline-prewarm.json'].map(name => [name, versions[name].sha256])),
  files: files.map(item => ({file: path.relative(root, item.file).replaceAll('\\', '/'), sha256: item.sha256})),
  boundary: 'Fixes cache-lock blocking of a second same-origin page. Two live villa pages, foreground rendering/input, closing the first, and reloading the second passed on Chrome and Edge. Does not fix native GPU/compiler crashes or guarantee performance with multiple heavy scenes. An in-use cache that requires repair or full-verification upgrade reports an explicit error until other readers close. Existing old-version blocked tabs must be closed or refreshed to cancel queued legacy writers.'
};
fs.writeFileSync(path.join(__dirname, 'evidence/villa-multitab-20261110.json'),
  JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, folder: profile.ours, cacheCases: after.cases.length,
  browsers: [chrome.channel, edge.channel]}));
