'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const baseline = option('baseline') || 'villa-binding-groups-v4', name = option('output') || 'villa-live-fps-v3';
assert([baseline, name].every(value => /^[a-z0-9-]+$/.test(value)) && baseline !== name);
const source = path.join(__dirname, 'build', baseline), output = path.join(__dirname, 'build', name);
fs.mkdirSync(path.join(__dirname,'results'),{recursive:true});
assert(!fs.existsSync(output), 'Use a new output folder to retain existing measurement evidence');
const htmlSource = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const match = htmlSource.match(/const localRuntimeAssets = (\{[^\n]+\});/);
assert(match);
const assets = JSON.parse(match[1]);
assert(assets.threads && assets.renderer === 'desktop');
const helpers = ['web-engine-host.js', 'web-engine-worker.js'];
fs.mkdirSync(output);
for (const file of fs.readdirSync(source)) {
  const from = path.join(source, file), to = path.join(output, file);
  if (!fs.statSync(from).isFile() || ['index.html','asset-versions.json', ...helpers].includes(file)) continue;
  // Immutable runtime/Cook payloads share disk space; changed helpers and HTML are
  // separate files. Never write to a linked payload after creating this package.
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}
for (const file of helpers) {
  fs.copyFileSync(path.join(__dirname, file), path.join(output, file));
  assets.versions[file] = audit(path.join(output, file)).sha256;
}
fs.writeFileSync(path.join(output, 'index.html'), htmlSource.replace(match[0],
  'const localRuntimeAssets = ' + JSON.stringify(assets) + ';'));
const unchanged = ['content.bin','content-files.json','config-files.json', assets.runtime, assets.wasm.url].map(file => {
  const before = audit(path.join(source, file)), after = audit(path.join(output, file));
  assert.equal(before.sha256, after.sha256);
  return {name:file, sha256:after.sha256};
});
const products = fs.readdirSync(output).map(file => audit(path.join(output, file)));
writeVersions(output, products);
const report = {pass:true, date:new Date().toISOString(), baseline, output,
  unchanged, helpers:helpers.map(file => audit(path.join(output, file))),
  projectSettingsChanged:false, wasmRebuilt:false,
  boundary:'UI diagnostics only. FPS and Low use owner submission intervals; physical presentation timestamps are unavailable.'};
fs.writeFileSync(path.join(__dirname, 'results', name + '-package.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
