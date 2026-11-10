'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'), input = option('corpus');
assert(tag && /^[a-z0-9-]+$/.test(tag) && input);
const profile = require('./villa-engine-comparison.json');
const sourceName = option('source') || profile.startupBaseline || profile.ours;
assert(/^[a-z0-9-]+$/.test(sourceName));
const source = path.join(__dirname, 'build', sourceName), dest = path.join(__dirname, 'build', tag);
assert(!fs.existsSync(dest), 'Published packages are immutable');
const versions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
for (const [name, entry] of Object.entries(versions)) {
  assert.equal(name, path.basename(name));
  assert.equal(audit(path.join(source, name)).sha256, entry.sha256, name);
}
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
const capturedVersions = JSON.parse(fs.readFileSync(capture.package.file));
for (const name of ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'config-files.json', 'content.bin'])
  assert.equal(capturedVersions[name].sha256, versions[name].sha256, 'Capture differs: ' + name);
const pack = {version: 1, wasm: versions['UEWebEngineThreads.wasm'].sha256,
  content: versions['content.bin'].sha256, config: versions['config-files.json'].sha256,
  devices: corpus.devices, modules: corpus.modules, layouts: corpus.layouts,
  descriptors: corpus.descriptors};
fs.mkdirSync(dest);
for (const name of Object.keys(versions)) {
  if (['index.html', 'web-engine-worker.js', 'web-engine-host.js', 'web-content-worker.js', 'web-pipeline-prewarm.js',
    'pipeline-prewarm.json', 'asset-versions.json'].includes(name)) continue;
  fs.linkSync(path.join(source, name), path.join(dest, name));
}
for (const name of ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'])
  fs.copyFileSync(path.join(__dirname, name), path.join(dest, name));
const packName = 'pipeline-prewarm.json';
fs.writeFileSync(path.join(dest, packName), JSON.stringify(pack));
let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = JSON.parse(match[1]);
for (const name of ['web-engine-host.js', 'web-engine-worker.js', 'web-content-worker.js', 'web-pipeline-prewarm.js'])
  assets.versions[name] = audit(path.join(dest, name)).sha256;
assets.pipelinePrewarm = {url: packName, sha256: audit(path.join(dest, packName)).sha256,
  content: pack.content, config: pack.config};
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
const argsMatch = html.match(/arguments: (\[[^\n]+\]),/); assert(argsMatch);
const args = JSON.parse(argsMatch[1]).filter(arg => arg !== '-WebPSOPrecacheTest');
html = html.replace(argsMatch[0], 'arguments: ' + JSON.stringify(args) + ',');
fs.writeFileSync(path.join(dest, 'index.html'), html);
writeVersions(dest, fs.readdirSync(dest).map(name => audit(path.join(dest, name))));
fs.writeFileSync(path.join(__dirname, 'results', tag + '-package.json'), JSON.stringify({
  date: new Date().toISOString(), pass: true, output: dest, source: audit(__filename),
  capture: audit(captureFile), corpus: audit(path.resolve(input)),
  products: fs.readdirSync(dest).map(name => audit(path.join(dest, name))),
  boundary: 'Recorded pipelines replace speculative startup precaching only in this opt-in package. Unrecorded pipelines still compile on demand.'
}, null, 2));
console.log(JSON.stringify({dest, modules: pack.modules.length, pipelines: pack.descriptors.length}));
