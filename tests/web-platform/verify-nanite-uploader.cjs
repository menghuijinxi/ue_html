'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert(process.argv[2] && process.argv[3], 'Pass uploader output and cooked asset directories');
const output = path.resolve(process.argv[2]), assetDir = path.resolve(process.argv[3]);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = read(path.join(output, 'uploader-results.json'));
const browser = read(path.join(assetDir, 'browser-results.json'));
const build = read(path.join(output, 'build.json'));
assert(build.pass);
for (const input of [...build.inputs, build.binary, build.log]) assert.equal(audit(input.file).sha256, input.sha256);
assert(browser.pass && browser.asset.webCookEnabled && browser.browsers.length);
for (const source of browser.sources) assert.equal(audit(source.file).sha256, source.sha256);
assert(report.pass);
assert.equal(report.policyChecks, 21);
assert.deepEqual(report.modes.map(m => m.bypass), [false, true]);
const products = [];
for (const mode of report.modes) {
  assert(mode.pass && mode.minimumWaveSize >= 32 && mode.maximumWaveSize >= mode.minimumWaveSize);
  assert.equal(mode.errors.length, 0);
  assert.deepEqual(mode.cases.map(c => c.index), [0, 1, 2, 3]);
  for (const c of mode.cases) {
    assert(c.pass && c.dispatches === [2, 2, 3, 4][c.index]);
    assert.equal(c.pages, c.index >= 2 ? 2 : 1);
    for (let i = 0; i < c.pages; ++i) {
      const page = audit(path.join(output, `page-${Number(mode.bypass)}-${c.index}-${i}.bin`));
      for (const b of browser.browsers) assert.equal(page.sha256, b.gpuPageSha256, 'Uploader differs from browser transcode/decode oracle');
      products.push(page);
    }
  }
}
const root = path.resolve(__dirname, '../..');
const generated = read(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/NaniteUploaderProbe/sources.json'));
for (const source of [...generated.sources, ...generated.generated]) assert.equal(audit(source.file).sha256, source.sha256);
const verified = {date: new Date().toISOString(), pass: true, ...report, products, build,
  browserOracle: audit(path.join(assetDir, 'browser-results.json')), generated,
  sources: [__filename, path.join(__dirname, 'probe-nanite-uploader.ps1'),
    ...['WebGPUNaniteUploaderProbe.cpp', 'WebGPUDynamicRHI.cpp', 'WebGPURHIProbe.cpp'].map(n => path.join(root,
      'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private', n))].map(audit),
  boundary: 'Runtime uploader source executed through UE RDG and native Dawn WebGPURHI; source symbols renamed to coexist with installed Engine. Fully resident cooked fixture, not browser UE uploader execution or complete Nanite renderer.'};
fs.writeFileSync(path.join(output, 'verified.json'), JSON.stringify(verified, null, 2) + '\n');
console.log(JSON.stringify({pass: true, pages: products.length, output}));
