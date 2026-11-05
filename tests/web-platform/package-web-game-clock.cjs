'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const vm = require('node:vm');
const observe = require('./web-game-clock-observer.cjs');
const tag = process.argv.find(v => v.startsWith('--tag='))?.slice(6);
assert(tag && /^[a-z0-9-]+$/.test(tag));
const baseline = 'triplex-project-lumen-shadows-fixed-20261104';
const folder = 'triplex-game-clock-' + tag;
const pageRAF = process.argv.includes('--page-raf');
const cpu = process.argv.includes('--cpu-params');
const syncFrame = process.argv.includes('--sync-frame');
assert(!cpu || !pageRAF, 'Keep the native CPU diagnostic separate from RAF transport experiments');
assert(!syncFrame || cpu, '--sync-frame requires the native CPU diagnostic');
const base = path.join(__dirname, 'build', baseline), output = path.join(__dirname, 'build', folder);
const versions = JSON.parse(fs.readFileSync(path.join(base, 'asset-versions.json'), 'utf8'));
assert(!fs.existsSync(output));
for (const [name, item] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(base, name)).sha256, item.sha256);
}
fs.mkdirSync(output);
const changed = ['index.html', 'UEWebEngineThreads.js',
  ...(cpu ? ['UEWebEngineThreads.wasm', 'config-files.json'] : []),
  ...(pageRAF ? ['web-engine-host.js', 'web-engine-worker.js'] : [])];
for (const name of Object.keys(versions)) if (!changed.includes(name)) {
  try {fs.linkSync(path.join(base, name), path.join(output, name));}
  catch {fs.copyFileSync(path.join(base, name), path.join(output, name));}
}
const marker = 'var WebThreadBridge = () => {';
const native = path.resolve(__dirname, '../ue-web-smoke/Binaries/Web');
let nativeBuild;
if (cpu) {
  const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
  const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  assert(build.pass && build.threads && build.fullLinkAttempted && build.wasmValidated);
  for (const product of build.products) assert.equal(audit(product.file).sha256, product.sha256);
  const snapshot = path.join(__dirname, 'results', `game-clock-${tag}-build.json`);
  assert(!fs.existsSync(snapshot));
  fs.copyFileSync(buildFile, snapshot);
  nativeBuild = audit(snapshot);
}
let runtime = fs.readFileSync(path.join(cpu ? native : base, 'UEWebEngineThreads.js'), 'utf8');
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
if (cpu) {
  assert(runtime.includes('__webMotionBlurCPU'), 'Native runtime must include CPU diagnostics');
  fs.copyFileSync(path.join(native, 'UEWebEngineThreads.wasm'), path.join(output, 'UEWebEngineThreads.wasm'));
  const configs = JSON.parse(fs.readFileSync(path.join(base, 'config-files.json'), 'utf8'));
  const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
  assert(config);
  const text = Buffer.from(config.data, 'base64').toString('utf8') + '\n[SystemSettings]\nr.Web.MotionBlurTrace=1\n' +
    (syncFrame ? 'r.OneFrameThreadLag=0\n' : '');
  config.data = Buffer.from(text).toString('base64');
  config.sha256 = require('node:crypto').createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(output, 'config-files.json'), JSON.stringify(configs));
}
let html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
if (pageRAF) assets.gameFrameBridge = 'page-raf';
assets.versions['UEWebEngineThreads.js'] = audit(path.join(output, 'UEWebEngineThreads.js')).sha256;
if (cpu) {
  assets.wasm = metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
  assets.versions['UEWebEngineThreads.wasm'] = assets.wasm.sha256;
}
for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
  if (pageRAF) assets.versions[name] = audit(path.join(output, name)).sha256;
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
fs.writeFileSync(path.join(output, 'index.html'), html);
const products = Object.keys(versions).map(name => audit(path.join(output, name)));
for (const product of products) if (!changed.includes(path.basename(product.file)))
  assert.equal(product.sha256, versions[path.basename(product.file)].sha256);
products.push(writeVersions(output, products));
const report = {pass: true, date: new Date().toISOString(), baseline, folder, pageRAF, cpu, syncFrame, nativeBuild,
  sources: [__filename, path.join(__dirname, 'web-game-clock-observer.cjs'),
    ...(cpu ? [path.resolve(__dirname, '../../reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessMotionBlur.cpp')] : []),
    ...(pageRAF ? [path.join(__dirname, 'web-engine-host.js'), path.join(__dirname, 'web-engine-worker.js'),
      path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js')] : [])].map(audit), products,
  boundary: cpu ? 'Rebuilt native CPU motion blur diagnostics; optional r.OneFrameThreadLag=0. Original owner input/RAF, shaders and Cook. Bounded per-pthread traces, no clock or rendering formula changes.' :
    pageRAF ? 'Diagnostic page-provided native RAF timestamps; original owner-forwarded input, WASM, shaders and Cook. No FPS cap or clock manipulation.' :
    'Diagnostic main-loop timestamps only. Original input, RAF, WASM, shaders and Cook remain unchanged.'};
fs.writeFileSync(path.join(__dirname, 'results', `game-clock-${tag}-package.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, folder}));
