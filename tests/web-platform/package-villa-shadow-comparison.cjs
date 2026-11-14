'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {readPage, writePage, replaceFile} = require('./web-pipeline-prewarm-package.cjs');
const {finalizeDesktopRelease} = require('./web-release-defaults.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const mode = option('mode'), phase = option('phase');
assert(['on', 'off'].includes(mode) && ['prepare', 'release'].includes(phase));
const version = option('version') || '20261111';
const input = option('source') || 'villa-shadow-ab-20261111-diagnostic';
assert(/^[a-z0-9-]+$/.test(version) && /^[a-z0-9-]+$/.test(input));
const base = 'villa-shadow-' + mode + '-' + version;
const source = path.join(__dirname, 'build', phase === 'prepare' ?
  input : base + '-capture');
const destination = path.join(__dirname, 'build', base + (phase === 'prepare' ? '-capture' : ''));
assert(!fs.existsSync(destination), 'Keep existing packages immutable');
const sourceManifest = path.join(source, 'asset-versions.json');
const versions = JSON.parse(fs.readFileSync(sourceManifest));
for (const [name, entry] of Object.entries(versions)) {
  assert.equal(path.basename(name), name);
  assert.equal(audit(path.join(source, name)).sha256, entry.sha256, 'Source changed: ' + name);
}
fs.mkdirSync(destination);
for (const name of Object.keys(versions)) {
  if (['asset-versions.json', 'pipeline-prewarm.json'].includes(name)) continue;
  if (['index.html', 'config-files.json'].includes(name))
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
  else fs.linkSync(path.join(source, name), path.join(destination, name));
}
if (phase === 'prepare') {
  const file = path.join(destination, 'config-files.json'), configs = JSON.parse(fs.readFileSync(file));
  const ini = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini'); assert(ini);
  const text = Buffer.from(ini.data, 'base64').toString('utf8') +
    '\n[SystemSettings]\nr.Shadow.Virtual.Enable=' + Number(mode === 'on') + '\n';
  ini.data = Buffer.from(text).toString('base64');
  ini.sha256 = crypto.createHash('sha256').update(text).digest('hex');
  replaceFile(file, JSON.stringify(configs));
  const page = readPage(destination);
  page.assets.fixedRenderSize = {width: 1920, height: 1080};
  writePage(destination, page);
}
const defaults = finalizeDesktopRelease(destination, phase === 'prepare' ?
  {captureOnly: true} : {corpus: option('corpus')});
assert.equal(defaults.releaseReady, phase === 'release');
const manifest = writeVersions(destination, fs.readdirSync(destination).map(name => audit(path.join(destination, name))));
const report = {date: new Date().toISOString(), pass: true, mode, phase, source: audit(__filename),
  sourceManifest: audit(sourceManifest), destination, manifest, releaseDefaults: defaults,
  boundary: 'Both modes use the same verified source runtime and Cook; only VSM config differs. Fixed physical output, current host/cache worker, and configuration-matched actual pipeline capture via the shared release finalizer.'};
fs.writeFileSync(path.join(__dirname, 'results', base + '-' + phase + '.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({destination, releaseReady: defaults.releaseReady}));
