'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert(process.argv[2], 'Pass a completed probe-nanite-cook results.json');
const file = path.resolve(process.argv[2]);
const report = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
assert(report.pass && report.installedInputsUnmodified);
assert.equal(report.packagedLevel, false);
assert.equal(report.runtimeNaniteEnabled, false);
assert.deepEqual(report.cases.map(c => c.name), ['sm5-stripped', 'sm5-retained', 'es31-stripped', 'null-stripped']);
for (const c of report.cases) {
  assert(c.result.pass && !c.result.runtimeNaniteEnabled);
  assert.equal(c.result.retained, c.name === 'sm5-retained');
  assert.equal(audit(c.resource.file).sha256, c.resource.sha256);
  assert.equal(c.result.clusters > 0, c.result.retained);
}
assert(report.browser.pass && report.browser.asset.webCookEnabled);
assert(report.browser.requestedChannels.length > 0);
assert.deepEqual(report.browser.browsers.map(b => b.channel), report.browser.requestedChannels);
for (const browser of report.browser.browsers) {
  assert(browser.pass && !browser.adapter.isFallbackAdapter && browser.errors.length === 0);
  assert.equal(browser.cases.length, 2);
  for (const c of browser.cases) assert(c.pass && c.guardsPreserved && c.windingPreserved);
}
for (const source of [...report.sources, ...report.browser.sources, report.renderCore])
  assert.equal(audit(source.file).sha256, source.sha256, `Stale input: ${source.file}`);
const root = path.resolve(__dirname, '../..');
const evidence = {...report, sourceReport: audit(file),
  referenceCommit: cp.execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  boundary: 'Cook resource serialization and reload followed by real UE page transcode/decode. No complete package load, Nanite rasterization, hierarchy culling, streaming or Lit scene acceptance.',
  sources: [...report.sources, ...[__filename, path.join(__dirname, 'cook-web-engine.ps1')].map(audit)]};
const destination = path.join(__dirname, 'evidence/nanite-cook-20261107.json');
fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, destination}));
