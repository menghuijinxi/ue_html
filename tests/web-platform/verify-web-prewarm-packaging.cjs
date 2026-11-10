'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {prepareRecordedPrewarm, installRecordedPrewarm} = require('./web-pipeline-prewarm-package.cjs');

const root = fs.mkdtempSync(path.join(__dirname, 'build/prewarm-packaging-'));
const source = path.join(root, 'source'), output = path.join(root, 'output');
fs.mkdirSync(source); fs.mkdirSync(output);
const core = ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'content.bin', 'config-files.json'];
for (const name of core) fs.writeFileSync(path.join(source, name), 'fixture:' + name);
const sourceProducts = core.map(name => audit(path.join(source, name)));
for (const name of core) fs.copyFileSync(path.join(source, name), path.join(output, name));
const assets = {threads: true, renderer: 'desktop', versions: {},
  wasm: {sha256: sourceProducts[0].sha256}, gameFrameClock: 'page', pageFrameBudget: 3};
const args = ['-webgpu', '-WebProjectMap=/Game/Fixture', '-WebPSOPrecacheTest'];
const htmlFile = path.join(output, 'index.html');
fs.writeFileSync(htmlFile, 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';\n' +
  'arguments: ' + JSON.stringify(args) + ',\n');
fs.copyFileSync(htmlFile, path.join(source, 'index.html'));
const versionFile = writeVersions(source, [...sourceProducts, audit(path.join(source, 'index.html'))]);
const capture = {pass: true, capture: true, cvars: '', package: versionFile};
const captureFile = path.join(root, 'result.json'), corpusFile = path.join(root, '0-corpus.json');
fs.writeFileSync(captureFile, JSON.stringify(capture));
fs.writeFileSync(corpusFile, JSON.stringify({version: 1, devices: [{id: 1, descriptor: {}}],
  modules: [], layouts: [], descriptors: [{deviceId: 1, kind: 'compute', descriptor: {}}]}));
const prepared = prepareRecordedPrewarm(output, corpusFile);
const result = installRecordedPrewarm(output, prepared);
assert.equal(result.mode, 'recorded');
assert.deepEqual(result.engineArguments, args.slice(0, 2));
for (const item of sourceProducts)
  assert.equal(audit(path.join(output, path.basename(item.file))).sha256, item.sha256);
const installed = JSON.parse(fs.readFileSync(htmlFile, 'utf8').match(/const localRuntimeAssets = (\{[^\n]+\});/)[1]);
assert.equal(installed.gameFrameClock, assets.gameFrameClock);
assert.equal(installed.pageFrameBudget, assets.pageFrameBudget);
assert.equal(installed.pipelinePrewarm.sha256, audit(path.join(output, 'pipeline-prewarm.json')).sha256);
assert.equal(installed.pipelinePrewarm.content, sourceProducts[2].sha256);
assert.equal(installed.pipelinePrewarm.config, sourceProducts[3].sha256);
assert.equal(installed.versions['web-pipeline-prewarm.js'], audit(path.join(output, 'web-pipeline-prewarm.js')).sha256);
for (const name of core) {
  fs.appendFileSync(path.join(output, name), 'changed');
  assert.throws(() => prepareRecordedPrewarm(output, corpusFile), /Capture differs/);
  fs.copyFileSync(path.join(source, name), path.join(output, name));
}
for (const changed of [{...capture, pass: false}, {...capture, cvars: 'r.Shadow.Virtual.Enable=0'}]) {
  fs.writeFileSync(captureFile, JSON.stringify(changed));
  assert.throws(() => prepareRecordedPrewarm(output, corpusFile));
}
fs.writeFileSync(captureFile, JSON.stringify(capture));
fs.appendFileSync(versionFile.file, ' ');
assert.throws(() => prepareRecordedPrewarm(output, corpusFile), /Captured package has changed/);

console.log(JSON.stringify({pass: true, coreFilesUnchanged: core.length,
  mismatchedCapturesRejected: true}));
