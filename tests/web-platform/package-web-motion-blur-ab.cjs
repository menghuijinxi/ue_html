'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option('baseline') || 'triplex-project-lumen-shadows-fixed-20261104';
const tag = option('tag') || '20261104';
assert([baseline, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const base = path.join(__dirname, 'build', baseline);
const versions = JSON.parse(fs.readFileSync(path.join(base, 'asset-versions.json'), 'utf8'));
const sourceProducts = Object.entries(versions).map(([name, expected]) => {
  assert.equal(path.basename(name), name);
  const product = audit(path.join(base, name));
  assert.equal(product.sha256, expected.sha256, `Baseline changed: ${name}`);
  return product;
});
const frameSyncOnly = process.argv.includes('--frame-sync-only');
const aaMatrix = process.argv.includes('--render-matrix');
const motionMatrix = process.argv.includes('--motion-matrix');
const renderMatrix = aaMatrix || motionMatrix;
assert([frameSyncOnly, aaMatrix, motionMatrix].filter(Boolean).length <= 1, 'Choose one comparison set');
const matrixSettings = (lumen, aa, lag) => ({
  'r.DynamicGlobalIlluminationMethod': lumen,
  'r.ReflectionMethod': lumen,
  'r.Lumen.DiffuseIndirect.Allow': lumen,
  'r.Lumen.Reflections.Allow': lumen,
  'r.AntiAliasingMethod': aa,
  'r.OneFrameThreadLag': lag,
  't.MaxFPS': 0,
});
const motionSettings = (lumen, blur, lag) => ({
  ...matrixSettings(lumen, 4, lag),
  'r.MotionBlurQuality': blur ? 4 : 0,
});
const cases = motionMatrix ? [
  {name: 'no-lumen-blur', title: 'A - Lumen OFF - Motion Blur ON - Lag 1', settings: motionSettings(0, true, 1)},
  {name: 'lumen-no-blur', title: 'B - Lumen ON - Motion Blur OFF - Lag 1', settings: motionSettings(1, false, 1)},
  {name: 'lumen-blur-lag0', title: 'C - Lumen ON - Motion Blur ON - Lag 0', settings: motionSettings(1, true, 0)},
  {name: 'lumen-blur-lag1', title: 'D - Lumen ON - Motion Blur ON - Lag 1', settings: motionSettings(1, true, 1)},
] : aaMatrix ? [
  {name: 'no-lumen-aa', title: 'A - Lumen OFF - TSR ON - Lag 1', settings: matrixSettings(0, 4, 1)},
  {name: 'lumen-no-aa', title: 'B - Lumen ON - AA OFF - Lag 1', settings: matrixSettings(1, 0, 1)},
  {name: 'lumen-aa-lag0', title: 'C - Lumen ON - TSR ON - Lag 0', settings: matrixSettings(1, 4, 0)},
  {name: 'lumen-aa-lag1', title: 'D - Lumen ON - TSR ON - Lag 1', settings: matrixSettings(1, 4, 1)},
] : frameSyncOnly ? [
  {name: 'frame-sync', title: 'Lumen ON - Motion Blur ON - Frame Sync', settings: {
    'r.OneFrameThreadLag': 0,
  }},
] : [
  {name: 'no-lumen-10fps', title: 'A - Lumen OFF - 10 FPS - Motion Blur ON', settings: {
    'r.DynamicGlobalIlluminationMethod': 0,
    'r.ReflectionMethod': 0,
    'r.Lumen.DiffuseIndirect.Allow': 0,
    'r.Lumen.Reflections.Allow': 0,
    't.MaxFPS': 10,
  }},
  {name: 'no-motion-blur', title: 'B - Lumen ON - Motion Blur OFF', settings: {
    'r.MotionBlurQuality': 0,
  }},
];
function installTestFrameLimit(fps) {
  const request = globalThis.requestAnimationFrame.bind(globalThis);
  const cancel = globalThis.cancelAnimationFrame.bind(globalThis);
  const pending = new Map();
  const interval = 1000 / fps;
  let sequence = 0, last = -Infinity;
  const state = globalThis.__webMotionABFrameLimit = {fps, delivered: 0,
    boundary: 'Diagnostic owner RAF gate limits game-thread callbacks; simulation uses actual elapsed time.'};
  globalThis.requestAnimationFrame = callback => {
    const id = ++sequence;
    const item = {};
    pending.set(id, item);
    const tick = time => {
      if (!pending.has(id)) return;
      if (time - last < interval - 0.5) {
        item.native = request(tick);
        return;
      }
      last = time;
      pending.delete(id);
      state.delivered++;
      callback(time);
    };
    item.native = request(tick);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    const item = pending.get(id);
    if (item) {cancel(item.native); pending.delete(id);}
  };
}
const report = {date: new Date().toISOString(), baseline, renderMatrix, source: audit(__filename),
  comparisonAxis: motionMatrix ? 'motion-blur' : aaMatrix ? 'anti-aliasing' : null,
  baselineProducts: sourceProducts, cases: [], pass: false,
  boundary: motionMatrix ?
    'Corrected four-case Lumen/motion-blur/thread-lag comparison. TSR stays enabled in every case. Identical runtime, Cook, input and resolution settings; no frame cap. Motion blur ON retains baseline quality 4 and project amount. The first two cases use lag=1. Manual mouse-stutter comparison remains pending.' : aaMatrix ?
    'Four user-requested Lumen/TSR/thread-lag configurations. Identical runtime, Cook, input, resolution settings and original motion blur; no frame cap. The first two cases explicitly use lag=1. Perceived mouse stutter and shaking require manual comparison.' : frameSyncOnly ?
    'Frame synchronization candidate: only r.OneFrameThreadLag=0. Original shadow-fixed WASM/runtime, Cook, input, Lumen and motion blur. No frame-rate cap or time manipulation. Visual acceptance pending.' :
    'User-requested diagnostic variants. Same shadow-fixed WASM/runtime, Cook content, TSR and input code. A additionally gates the owner RAF used by the game thread because t.MaxFPS alone did not enforce a browser frame cap. Perceived shaking still requires user review.'};
for (const entry of cases) {
  const folder = `triplex-motion-${entry.name}-${tag}`;
  const directory = path.join(__dirname, 'build', folder);
  assert(!fs.existsSync(directory), 'Use a fresh tag to preserve earlier tests');
  fs.mkdirSync(directory);
  const limited = entry.name === 'no-lumen-10fps';
  const changed = ['config-files.json', 'index.html', ...(limited ? ['web-engine-worker.js'] : [])];
  // Every edited file is a private copy; immutable multi-GB content is shared.
  for (const name of Object.keys(versions)) {
    if (changed.includes(name)) continue;
    const source = path.join(base, name), destination = path.join(directory, name);
    try { fs.linkSync(source, destination); } catch { fs.copyFileSync(source, destination); }
  }
  const configs = JSON.parse(fs.readFileSync(path.join(base, 'config-files.json'), 'utf8'));
  const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
  assert(config);
  let text = Buffer.from(config.data, 'base64').toString('utf8');
  for (const name of Object.keys(entry.settings)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert(!new RegExp(`^\\s*${escaped}\\s*=`, 'mi').test(text), `Unexpected baseline override: ${name}`);
  }
  text += '\n[SystemSettings]\n' +
    Object.entries(entry.settings).map(([name, value]) => `${name}=${value}`).join('\n') + '\n';
  config.data = Buffer.from(text).toString('base64');
  config.sha256 = crypto.createHash('sha256').update(text).digest('hex');
  fs.writeFileSync(path.join(directory, 'config-files.json'), JSON.stringify(configs));
  if (limited) fs.writeFileSync(path.join(directory, 'web-engine-worker.js'),
    `(${installTestFrameLimit.toString()})(10);\n` + fs.readFileSync(path.join(base, 'web-engine-worker.js'), 'utf8'));
  let html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
  assert(html.includes('<title>TriplexHouseVilla</title>'));
  if (limited) {
    const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/);
    assert(match);
    const assets = JSON.parse(match[1]);
    assets.versions['web-engine-worker.js'] = audit(path.join(directory, 'web-engine-worker.js')).sha256;
    html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
  }
  fs.writeFileSync(path.join(directory, 'index.html'),
    html.replace('<title>TriplexHouseVilla</title>', `<title>${entry.title}</title>`));
  const products = Object.keys(versions).map(name => audit(path.join(directory, name)));
  for (const item of products) {
    const name = path.basename(item.file);
    if (!changed.includes(name))
      assert.equal(item.sha256, versions[name].sha256, `Shared asset changed: ${name}`);
  }
  products.push(writeVersions(directory, products));
  report.cases.push({...entry, folder, ownerRAFMaxFPS: limited ? 10 : null, changed, products,
    url: `http://127.0.0.1:8765/build/${folder}/index.html`});
}
report.pass = true;
const file = path.join(__dirname, 'results', `motion-blur-ab-${tag}-package.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, file, cases: report.cases.map(({name, folder, settings, url}) =>
  ({name, folder, settings, url}))}));
