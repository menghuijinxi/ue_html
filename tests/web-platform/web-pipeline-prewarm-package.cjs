'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const coreFiles = ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'config-files.json', 'content.bin'];
const runtimeFiles = ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'];

function prepareRecordedPrewarm(folder, input) {
  const corpus = JSON.parse(fs.readFileSync(input));
  assert.equal(corpus.version, 1);
  assert.equal(corpus.devices.length, 1);
  assert(corpus.descriptors.length && corpus.descriptors.every(item =>
    item.deviceId === corpus.devices[0].id && ['render', 'compute'].includes(item.kind)));
  const captureFile = path.join(path.dirname(path.resolve(input)), 'result.json');
  const capture = JSON.parse(fs.readFileSync(captureFile));
  assert(capture.pass && capture.capture, 'Require a successful capture');
  assert(!capture.cvars, 'Do not publish a capture made with configuration overrides');
  assert(capture.package && audit(capture.package.file).sha256 === capture.package.sha256,
    'Captured package has changed');
  const versions = JSON.parse(fs.readFileSync(capture.package.file));
  for (const name of coreFiles)
    assert.equal(audit(path.join(folder, name)).sha256, versions[name].sha256, 'Capture differs: ' + name);
  return {
    pack: {version: 1, wasm: versions[coreFiles[0]].sha256, content: versions['content.bin'].sha256,
      config: versions['config-files.json'].sha256, devices: corpus.devices,
      modules: corpus.modules, layouts: corpus.layouts, descriptors: corpus.descriptors},
    capture: audit(captureFile), corpus: audit(path.resolve(input)),
  };
}

function installRecordedPrewarm(folder, prepared) {
  const {pack, capture, corpus} = prepared;
  const htmlFile = path.join(folder, 'index.html');
  let html = fs.readFileSync(htmlFile, 'utf8');
  const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
  const argsMatch = html.match(/arguments: (\[[^\n]+\]),/);
  assert(match && argsMatch);
  const assets = JSON.parse(match[1]);
  assert(assets.threads && assets.renderer === 'desktop');
  assert.equal(assets.wasm.sha256, pack.wasm, 'HTML runtime does not match capture');
  const args = JSON.parse(argsMatch[1]).filter(arg => arg !== '-WebPSOPrecacheTest');
  for (const name of runtimeFiles) {
    fs.copyFileSync(path.join(__dirname, name), path.join(folder, name));
    assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  const name = 'pipeline-prewarm.json', packFile = path.join(folder, name);
  fs.writeFileSync(packFile, JSON.stringify(pack));
  assets.pipelinePrewarm = {url: name, sha256: audit(packFile).sha256, content: pack.content, config: pack.config};
  html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';')
    .replace(argsMatch[0], 'arguments: ' + JSON.stringify(args) + ',');
  fs.writeFileSync(htmlFile, html);
  return {mode: 'recorded', concurrency: 2, modules: pack.modules.length, pipelines: pack.descriptors.length,
    capture, corpus, pack: audit(packFile), engineArguments: args,
    files: [...runtimeFiles, name]};
}

module.exports = {prepareRecordedPrewarm, installRecordedPrewarm};
