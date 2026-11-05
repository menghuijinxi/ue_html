'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const baseline = option('base') || 'villa-scheduling-latest-v71', folder = option('target');
const defaultAhead = Number(option('default-ahead') || 0);
const budgetMode = option('budget-mode') || 'submitted';
assert(['submitted', 'pipeline'].includes(budgetMode));
assert([baseline, folder].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(Number.isInteger(defaultAhead) && defaultAhead >= 0 && defaultAhead <= 8);
const base = path.join(__dirname, 'build', baseline), output = path.join(__dirname, 'build', folder);
assert(!fs.existsSync(output), 'Use a new package directory');
const versions = JSON.parse(fs.readFileSync(path.join(base, 'asset-versions.json'), 'utf8'));
for (const [name, item] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(base, name)).sha256, item.sha256);
}
const bridgeFile = path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js');
let library;
vm.runInNewContext(fs.readFileSync(bridgeFile, 'utf8'), {addToLibrary: value => {library = value;}});
let runtime = fs.readFileSync(path.join(base, 'UEWebEngineThreads.js'), 'utf8');
const begin = runtime.indexOf('var WebThreadBridge = '), end = runtime.indexOf('\nvar findCanvasEventTarget = ', begin);
assert(begin >= 0 && end > begin && runtime.includes('__webAttachFrameScheduler'));
runtime = runtime.slice(0, begin) + 'var WebThreadBridge = ' + library.$WebThreadBridge.toString() + ';\n' + runtime.slice(end);
const changed = ['index.html', 'UEWebEngineThreads.js', 'web-engine-host.js', 'web-engine-worker.js', 'comparison.html', 'package-info.json'];
fs.mkdirSync(output);
for (const name of Object.keys(versions)) if (!changed.includes(name)) {
  try {fs.linkSync(path.join(base, name), path.join(output, name));}
  catch {fs.copyFileSync(path.join(base, name), path.join(output, name));}
}
fs.writeFileSync(path.join(output, 'UEWebEngineThreads.js'), runtime);
for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
  fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
let html = fs.readFileSync(path.join(base, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = JSON.parse(match[1]);
assets.localFrameBudget = defaultAhead;
assets.localFrameBudgetMode = budgetMode;
for (const name of ['UEWebEngineThreads.js', 'web-engine-host.js', 'web-engine-worker.js'])
  assets.versions[name] = audit(path.join(output, name)).sha256;
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
fs.writeFileSync(path.join(output, 'index.html'), html);
const cases = budgetMode === 'pipeline' ?
  [['Local, full pipeline budget 3', 'local', 3, 'pipeline'],
    ['Local, full pipeline budget 3 + direct input', 'local', 3, 'pipeline', 'direct-game-thread'],
    ['Previous version: submitted GPU threshold 4', 'local', 4, 'submitted'],
    ['Owner rAF', 'owner', 0, 'submitted'],
    ['Local, full pipeline budget 4', 'local', 4, 'pipeline']] :
  [['Owner rAF', 'owner', 0, 'submitted'], ['Local, unbounded', 'local', 0, 'submitted'],
    ['Local, GPU threshold 2', 'local', 2, 'submitted'], ['Local, GPU threshold 4', 'local', 4, 'submitted'],
    ['Local, GPU threshold 8', 'local', 8, 'submitted']];
fs.writeFileSync(path.join(output, 'comparison.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Local scheduling comparison</title>
<style>body{font:16px system-ui;margin:32px;color:#222;background:#fff}li{margin:20px 0}a{color:#0865b1}</style>
<h1>Local scheduling comparison</h1><ul>${cases.map(([label, clock, ahead, mode, input = 'owner-forwarded']) =>
  `<li><a href="index.html?occlusion=history&clock=${clock}&gpuahead=${ahead}&gpumode=${mode}&input=${input}&rhiwake=priority">${label}</a></li>`).join('')}</ul></html>`);
const sources = [__filename, bridgeFile, path.join(__dirname, 'web-engine-host.js'), path.join(__dirname, 'web-engine-worker.js')].map(audit);
const boundary = 'Opt-in local GPU backpressure; original WASM, Cook, shaders and rendering configuration. Only bridge JS, host/worker helpers and package metadata changed. Submitted mode permits GT/RT overshoot; pipeline mode counts every started Game tick until GPU completion. GPU feedback includes callback delivery. Performance requires moving-camera and cross-device acceptance.';
fs.writeFileSync(path.join(output, 'package-info.json'), JSON.stringify({
  date: new Date().toISOString(), folder, baseline, defaultAhead, budgetMode, sources, boundary,
  basePackage: JSON.parse(fs.readFileSync(path.join(base, 'package-info.json'), 'utf8')),
}, null, 2) + '\n');
const names = [...new Set([...Object.keys(versions), 'comparison.html', 'package-info.json'])];
const products = names.map(name => audit(path.join(output, name)));
for (const product of products) if (!changed.includes(path.basename(product.file)))
  assert.equal(product.sha256, versions[path.basename(product.file)].sha256);
products.push(writeVersions(output, products));
const report = {pass: true, date: new Date().toISOString(), baseline, folder, defaultAhead, budgetMode, sources, products, boundary};
fs.writeFileSync(path.join(__dirname, 'results', folder + '-package.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, folder, output}));
