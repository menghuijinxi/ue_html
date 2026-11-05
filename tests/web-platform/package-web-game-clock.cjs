'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const vm = require('node:vm');
const observe = require('./web-game-clock-observer.cjs');
const tag = process.argv.find(v => v.startsWith('--tag='))?.slice(6);
assert(tag && /^[a-z0-9-]+$/.test(tag));
const baseline = 'triplex-project-lumen-shadows-fixed-20261104';
const folder = 'triplex-game-clock-' + tag;
const pageRAF = process.argv.includes('--page-raf');
const base = path.join(__dirname, 'build', baseline), output = path.join(__dirname, 'build', folder);
const versions = JSON.parse(fs.readFileSync(path.join(base, 'asset-versions.json'), 'utf8'));
assert(!fs.existsSync(output));
for (const [name, item] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(base, name)).sha256, item.sha256);
}
fs.mkdirSync(output);
const changed = ['index.html', 'UEWebEngineThreads.js', ...(pageRAF ? ['web-engine-host.js', 'web-engine-worker.js'] : [])];
for (const name of Object.keys(versions)) if (!changed.includes(name)) {
  try {fs.linkSync(path.join(base, name), path.join(output, name));}
  catch {fs.copyFileSync(path.join(base, name), path.join(output, name));}
}
const marker = 'var WebThreadBridge = () => {';
let runtime = fs.readFileSync(path.join(base, 'UEWebEngineThreads.js'), 'utf8');
if (pageRAF) {
  let library;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,
    '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'), 'utf8'),
  {addToLibrary: value => {library = value;}});
  const begin = runtime.indexOf(marker), end = runtime.indexOf('\nvar findCanvasEventTarget = ', begin);
  assert(begin >= 0 && end > begin);
  runtime = runtime.slice(0, begin) + 'var WebThreadBridge = ' + library.$WebThreadBridge.toString() +
    ';\n' + runtime.slice(end);
  for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
    fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
}
assert.equal(runtime.split(marker).length, 2);
fs.writeFileSync(path.join(output, 'UEWebEngineThreads.js'), runtime.replace(marker,
  `${marker}\n(${observe.toString()})();`));
let html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
if (pageRAF) assets.gameFrameBridge = 'page-raf';
assets.versions['UEWebEngineThreads.js'] = audit(path.join(output, 'UEWebEngineThreads.js')).sha256;
for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
  if (pageRAF) assets.versions[name] = audit(path.join(output, name)).sha256;
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
fs.writeFileSync(path.join(output, 'index.html'), html);
const products = Object.keys(versions).map(name => audit(path.join(output, name)));
for (const product of products) if (!changed.includes(path.basename(product.file)))
  assert.equal(product.sha256, versions[path.basename(product.file)].sha256);
products.push(writeVersions(output, products));
const report = {pass: true, date: new Date().toISOString(), baseline, folder, pageRAF,
  sources: [__filename, path.join(__dirname, 'web-game-clock-observer.cjs'),
    ...(pageRAF ? [path.join(__dirname, 'web-engine-host.js'), path.join(__dirname, 'web-engine-worker.js'),
      path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js')] : [])].map(audit), products,
  boundary: pageRAF ? 'Diagnostic page-provided native RAF timestamps; original owner-forwarded input, WASM, shaders and Cook. No FPS cap or clock manipulation.' :
    'Diagnostic main-loop timestamps only. Original input, RAF, WASM, shaders and Cook remain unchanged.'};
fs.writeFileSync(path.join(__dirname, 'results', `game-clock-${tag}-package.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, folder}));
