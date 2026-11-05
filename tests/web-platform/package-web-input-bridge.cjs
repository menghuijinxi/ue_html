'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
assert(tag && /^[a-z0-9-]+$/.test(tag));
const baseline = 'triplex-project-lumen-shadows-fixed-20261104';
const base = path.join(__dirname, 'build', baseline);
const versions = JSON.parse(fs.readFileSync(path.join(base, 'asset-versions.json'), 'utf8'));
for (const [name, item] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(base, name)).sha256, item.sha256, 'Baseline must remain intact');
}
const bridgeSource = path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js');
let library;
vm.runInNewContext(fs.readFileSync(bridgeSource, 'utf8'), {addToLibrary: value => {library = value;}});
const originalRuntime = fs.readFileSync(path.join(base, 'UEWebEngineThreads.js'), 'utf8');
const begin = originalRuntime.indexOf('var WebThreadBridge = () => {');
const end = originalRuntime.indexOf('\nvar findCanvasEventTarget = ', begin);
assert(begin >= 0 && end > begin && originalRuntime.indexOf('var WebThreadBridge = ', begin + 1) === -1);
// Both arms receive the same JS bridge. WASM, Cook resources and game RAF remain identical.
const runtime = originalRuntime.slice(0, begin) + 'var WebThreadBridge = ' +
  library.$WebThreadBridge.toString() + ';\n' + originalRuntime.slice(end);
const changed = ['index.html', 'web-engine-host.js', 'web-engine-worker.js', 'UEWebEngineThreads.js'];
const report = {date: new Date().toISOString(), pass: false, baseline,
  sources: [__filename, bridgeSource, path.join(__dirname, 'web-engine-host.js'),
    path.join(__dirname, 'web-engine-worker.js')].map(audit),
  cases: [], boundary: 'Diagnostic JS-only input bridge experiment; no WASM rebuild, Cook, rendering settings or game RAF changes. Both arms use the same bridge implementation; only transport and page scheduling differ.'};
for (const mode of ['owner-forwarded', 'direct-game-thread']) {
  const folder = `triplex-input-${mode === 'owner-forwarded' ? 'owner' : 'direct'}-${tag}`;
  const directory = path.join(__dirname, 'build', folder);
  assert(!fs.existsSync(directory), 'Use a fresh tag');
  fs.mkdirSync(directory);
  for (const name of Object.keys(versions)) {
    if (changed.includes(name)) continue;
    try {fs.linkSync(path.join(base, name), path.join(directory, name));}
    catch {fs.copyFileSync(path.join(base, name), path.join(directory, name));}
  }
  for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
    fs.copyFileSync(path.join(__dirname, name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'UEWebEngineThreads.js'), runtime);
  let html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
  assert(match);
  const assets = JSON.parse(match[1]);
  assets.inputBridge = mode; assets.inputTrace = true;
  for (const name of changed.filter(v => v !== 'index.html'))
    assets.versions[name] = audit(path.join(directory, name)).sha256;
  html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';')
    .replace('<title>TriplexHouseVilla</title>', `<title>Triplex Input ${mode}</title>`);
  fs.writeFileSync(path.join(directory, 'index.html'), html);
  const products = Object.keys(versions).map(name => audit(path.join(directory, name)));
  for (const product of products) if (!changed.includes(path.basename(product.file)))
    assert.equal(product.sha256, versions[path.basename(product.file)].sha256);
  products.push(writeVersions(directory, products));
  report.cases.push({mode, folder, products, url: `http://127.0.0.1:8765/build/${folder}/index.html`});
}
report.pass = true;
fs.writeFileSync(path.join(__dirname, 'results', `input-bridge-${tag}-package.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, cases: report.cases.map(({mode, url}) => ({mode, url}))}));
