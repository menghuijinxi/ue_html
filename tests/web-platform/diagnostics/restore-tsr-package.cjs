'use strict';
const {assertProjectOutput, assertProjectOutputTree, initializeProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const {finalizeDesktopRelease} = require('../web-release-defaults.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const base = path.resolve(__dirname, '..');
const folder = assertProjectOutputTree(path.join(base, 'build/villa-tsr-tiles-20261112'));
const snapshot = path.join(base, 'build/auto-prewarm-522a1c84-860a-436c-a58b-0f0e0883bf49');
const reportFile = path.join(base, 'results/web-project-triplex-virtual-distance-fields-threads-package-results.json');
const original = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
assert(original.pass && original.releaseDefaults.releaseReady);
assert.equal(fs.realpathSync(folder), folder, 'Restore only to a local directory');
assert.equal(fs.readdirSync(folder).length, 0, 'Refuse to overwrite existing files');
for (const entry of fs.readdirSync(snapshot)) {
  if (entry === 'asset-versions.json') continue;
  fs.copyFileSync(path.join(snapshot, entry), path.join(folder, entry));
}
const release = finalizeDesktopRelease(folder, {corpus:
  path.join(base, 'results/villa-startup-tsr-tiles-capture-retry-20261112/0-corpus.json')});
for (const item of original.products) {
  if (path.basename(item.file) === 'asset-versions.json') continue;
  assert.equal(audit(item.file).sha256, item.sha256, 'Recovered bytes differ: ' + item.file);
}
const oldManifest = original.products.find(p => path.basename(p.file) === 'asset-versions.json');
const manifest = writeVersions(folder, original.products.filter(p => p !== oldManifest));
const file = assertProjectOutput(path.join(base, 'results/tsr-package-recovery-20261112.json'));
assert(!fs.existsSync(file));
fs.writeFileSync(file, JSON.stringify({date: new Date().toISOString(), pass: true,
  source: audit(__filename), originalPackageReport: audit(reportFile),
  originalManifest: oldManifest, recoveredManifest: manifest, release,
  products: original.products.filter(p => p !== oldManifest), boundary:
    'External C drive cleanup removed the package and Cook directories. Restored from the retained H drive capture snapshot and actual recorded corpus. Every delivered file except the mtime-bearing manifest is SHA256-identical to the measured formal package. Manifest was reissued with new file mtimes. No performance report was rewritten.'}, null, 2));
console.log(JSON.stringify({pass: true, oldManifest, manifest, files: original.products.length - 1}));
