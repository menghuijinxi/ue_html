'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {finalizeDesktopRelease} = require('./web-release-defaults.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const sourceName = option('source') || 'villa-project-settings-20261115';
const outputName = option('output') || 'villa-presentation-20261115';
for (const name of [sourceName, outputName]) assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name));
const source = path.join(__dirname, 'build', sourceName), output = path.join(__dirname, 'build', outputName);
assert(!fs.existsSync(output), 'Keep existing packages; choose a new output name');
const originalVersions = audit(path.join(source, 'asset-versions.json'));
const versions = JSON.parse(fs.readFileSync(originalVersions.file));
for (const [name, item] of Object.entries(versions)) {
  assert.equal(name, path.basename(name));
  assert.equal(audit(path.join(source, name)).sha256, item.sha256, 'Source changed: ' + name);
}
fs.mkdirSync(output);
for (const name of Object.keys(versions))
  fs.copyFileSync(path.join(source, name), path.join(output, name), fs.constants.COPYFILE_FICLONE);
const index = path.join(output, 'index.html');
const html = fs.readFileSync(index, 'utf8');
assert(html.includes('</style>'));
fs.writeFileSync(index, html.replace('</style>',
  '/* Presentation: keep the scene free of the performance/debug overlay. */\n#web-performance-hud { display: none !important; }\n</style>'));
const releaseDefaults = finalizeDesktopRelease(output);
for (const name of ['UEWebEngineThreads.wasm', 'UEWebEngineThreads.js', 'content.bin', 'content-files.json', 'config-files.json'])
  assert.equal(audit(path.join(output, name)).sha256, versions[name].sha256, 'Presentation changed scene or configuration: ' + name);
assert.equal(audit(originalVersions.file).sha256, originalVersions.sha256);
for (const [name, item] of Object.entries(versions))
  assert.equal(audit(path.join(source, name)).sha256, item.sha256, 'Source package was modified: ' + name);
const products = Object.keys(versions).map(name => audit(path.join(output, name)));
products.push(writeVersions(output, products));
const report = {date: new Date().toISOString(), pass: true, source: originalVersions, output,
  performanceHUDVisible: false, sceneAndProjectConfigurationPreserved: true, releaseDefaults, products};
fs.writeFileSync(path.join(__dirname, 'results', outputName + '-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, prewarm: releaseDefaults.prewarm.selection, files: products.length}));
