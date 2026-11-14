'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {resolveWebRenderSize} = require('./web-engine-host.js');
const coreFiles = ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'config-files.json', 'content.bin'];
const runtimeFiles = ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'];

function readPage(folder) {
  const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
  const assetsMatch = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
  const argsMatch = html.match(/arguments: (\[[^\n]+\]),/);
  assert(assetsMatch && argsMatch, 'Missing runtime configuration');
  // The stock template uses single quotes; generated packages use JSON.
  assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(argsMatch[1]));
  const args = [...argsMatch[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(match => match[1]);
  return {html, assetsMatch, argsMatch, assets: JSON.parse(assetsMatch[1]), args};
}

function replaceFile(file, bytes) {
  // Renaming a new file also detaches inherited hardlinks to archived packages.
  const temporary = file + '.' + require('node:crypto').randomUUID() + '.tmp';
  try {fs.writeFileSync(temporary, bytes); fs.renameSync(temporary, file);}
  finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
}

function writePage(folder, page) {
  replaceFile(path.join(folder, 'index.html'), page.html
    .replace(page.assetsMatch[0], 'const localRuntimeAssets = ' + JSON.stringify(page.assets) + ';')
    .replace(page.argsMatch[0], 'arguments: ' + JSON.stringify(page.args) + ','));
}

function startupContext(folder) {
  const {assets, args} = readPage(folder);
  return {args: args.filter(arg => arg !== '-WebPSOPrecacheTest'),
    fixedRenderSize: resolveWebRenderSize(assets, args) || null};
}

function prepareRecordedPrewarm(folder, input) {
  const corpus = JSON.parse(fs.readFileSync(input));
  assert.equal(corpus.version, 1);
  assert.equal(corpus.devices.length, 1);
  assert(corpus.descriptors.length && corpus.descriptors.every(item =>
    item.deviceId === corpus.devices[0].id && ['render', 'compute'].includes(item.kind)));
  const captureFile = path.join(path.dirname(path.resolve(input)), 'result.json');
  const capture = JSON.parse(fs.readFileSync(captureFile));
  assert(capture.pass && capture.capture, 'Require a successful capture');
  assert(!capture.withoutSubgroups, 'A masked-device capture is not a normal release capture');
  assert(!capture.cvars, 'Do not publish a capture made with configuration overrides');
  assert(capture.package && audit(capture.package.file).sha256 === capture.package.sha256,
    'Captured package has changed');
  const versions = JSON.parse(fs.readFileSync(capture.package.file));
  for (const name of coreFiles)
    assert.equal(audit(path.join(folder, name)).sha256, versions[name].sha256, 'Capture differs: ' + name);
  const capturedFolder = path.dirname(capture.package.file);
  assert.equal(audit(path.join(capturedFolder, 'index.html')).sha256, versions['index.html']?.sha256,
    'Captured entry page has changed');
  assert.deepEqual(startupContext(folder), startupContext(capturedFolder), 'Capture startup arguments or render size differ');
  return {
    pack: {version: 1, wasm: versions[coreFiles[0]].sha256, content: versions['content.bin'].sha256,
      config: versions['config-files.json'].sha256, devices: corpus.devices,
      modules: corpus.modules, layouts: corpus.layouts, descriptors: corpus.descriptors},
    capture: audit(captureFile), corpus: audit(path.resolve(input)),
  };
}

function installRecordedPrewarm(folder, prepared) {
  const {pack, capture, corpus} = prepared;
  const page = readPage(folder), assets = page.assets;
  assert(assets.threads && assets.renderer === 'desktop');
  assert.equal(assets.wasm.sha256, pack.wasm, 'HTML runtime does not match capture');
  const args = page.args = page.args.filter(arg => arg !== '-WebPSOPrecacheTest');
  for (const name of runtimeFiles) {
    replaceFile(path.join(folder, name), fs.readFileSync(path.join(__dirname, name)));
    assets.versions[name] = audit(path.join(folder, name)).sha256;
  }
  const name = 'pipeline-prewarm.json', packFile = path.join(folder, name);
  replaceFile(packFile, JSON.stringify(pack));
  assets.pipelinePrewarm = {url: name, sha256: audit(packFile).sha256, content: pack.content, config: pack.config};
  writePage(folder, page);
  return {mode: 'recorded', concurrency: 2, modules: pack.modules.length, pipelines: pack.descriptors.length,
    capture, corpus, pack: audit(packFile), engineArguments: args,
    files: [...runtimeFiles, name]};
}

module.exports = {prepareRecordedPrewarm, installRecordedPrewarm, readPage, writePage, replaceFile,
  startupContext, coreFiles, runtimeFiles};
