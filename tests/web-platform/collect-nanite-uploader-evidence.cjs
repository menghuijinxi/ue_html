'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert(process.argv[2] && process.argv[3], 'Pass uploader verified.json and Cook results.json');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const verify = item => assert.equal(audit(item.file).sha256, item.sha256, `Stale file: ${item.file}`);
const uploaderFile = path.resolve(process.argv[2]), cookFile = path.resolve(process.argv[3]);
const uploader = read(uploaderFile), cook = read(cookFile);
const wasmFile = path.join(__dirname, 'results/nanite-uploader-wasm/results.json');
const wasm = read(wasmFile);
assert(uploader.pass && uploader.build.pass && uploader.policyChecks === 21);
assert.deepEqual(uploader.modes.map(m => m.bypass), [false, true]);
assert.equal(uploader.products.length, 12);
for (const mode of uploader.modes) {
  assert(mode.pass && mode.minimumWaveSize >= 32 && mode.maximumWaveSize >= mode.minimumWaveSize);
  assert.deepEqual(mode.errors, []);
  assert.deepEqual(mode.cases.map(c => c.dispatches), [2, 2, 3, 4]);
  for (const test of mode.cases) assert(test.pass);
}
for (const input of [...uploader.sources, ...uploader.products, ...uploader.generated.sources,
  ...uploader.generated.generated, ...uploader.build.inputs, uploader.build.binary,
  uploader.build.log, uploader.browserOracle]) verify(input);
assert(wasm.pass && wasm.rhi.pass && wasm.compileOnly && !wasm.linked);
assert(wasm.sourcesUnmodified && wasm.installedInputsUnmodified);
for (const input of [...wasm.inputs, ...wasm.installed, wasm.log, wasm.object,
  ...wasm.rhi.inputs, wasm.rhi.log, wasm.rhi.object]) verify(input);
assert(cook.pass && cook.installedInputsUnmodified && !cook.packagedLevel && !cook.runtimeNaniteEnabled);
assert.deepEqual(cook.cases.map(c => c.name), ['sm5-stripped', 'sm5-retained', 'es31-stripped', 'null-stripped']);
for (const test of cook.cases) {
  assert(test.result.pass && !test.result.runtimeNaniteEnabled);
  assert.equal(test.result.retained, test.name === 'sm5-retained');
  verify(test.resource);
}
assert(cook.browser.pass && cook.browser.asset.webCookEnabled && cook.browser.browsers.length);
assert.deepEqual(cook.browser.browsers.map(b => b.channel), cook.browser.requestedChannels);
// PowerShell ConvertFrom/To-Json normalizes ISO timestamps (e.g. .230 -> .23).
const normalizeDate = report => ({...report, date: new Date(report.date).toISOString()});
assert.deepEqual(normalizeDate(read(uploader.browserOracle.file)), normalizeDate(cook.browser),
  'Uploader and Cook must use the same browser oracle');
for (const browser of cook.browser.browsers) {
  assert(browser.pass && !browser.adapter.isFallbackAdapter && browser.errors.length === 0);
  assert.equal(browser.cases.length, 2);
  for (const test of browser.cases) assert(test.pass && test.guardsPreserved && test.windingPreserved);
  for (const page of uploader.products) assert.equal(page.sha256, browser.gpuPageSha256);
}
for (const input of [...cook.sources, ...cook.browser.sources, cook.renderCore]) verify(input);
const evidence = {date: new Date().toISOString(), pass: true,
  referenceCommit: cp.execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  uploader: {...uploader, sourceReport: audit(uploaderFile),
    logs: ['rhi.log', 'console.log'].map(n => audit(path.join(path.dirname(uploaderFile), n)))},
  wasm: {...wasm, sourceReport: audit(wasmFile)},
  cookRegression: {sourceReport: audit(cookFile), cases: cook.cases, browser: cook.browser,
    installedInputsUnmodified: cook.installedInputsUnmodified},
  sources: [__filename, path.join(root, 'UE58_WEBGPU_NANITE_IMPLEMENTATION.md'),
    ...['prepare-web-core-host.ps1', 'link-web-engine-webgpu.ps1'].map(n => path.join(__dirname, n))].map(audit),
  boundary: 'Actual runtime uploader source, renamed only to coexist with installed Engine, executed on native Dawn via UE RDG. Fully resident cooked fixture and synthetic dependency ordering; no actual cross-page references/fixups, browser UE uploader execution, linked package or complete Nanite renderer.'};
const destination = path.join(__dirname, 'evidence/nanite-uploader-20261107.json');
fs.writeFileSync(destination, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({pass: true, destination}));
