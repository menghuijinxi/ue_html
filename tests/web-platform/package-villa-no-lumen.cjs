'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const profile = require('./villa-engine-comparison-no-lumen.json');
const original = require('./villa-engine-comparison.json');
const source = path.join(__dirname, 'build', profile.source);
const dest = path.join(__dirname, 'build', profile.startupBaseline);
const official = path.join(__dirname, 'build/ue59-official-villa-20261109');
const officialDest = path.join(official, 'no-lumen-20261110');
assert(!fs.existsSync(dest) && !fs.existsSync(officialDest), 'Published packages are immutable');
assert.deepEqual(Object.keys(profile.settings).filter(key => profile.settings[key] !== original.settings[key]).sort(),
  ['r.DynamicGlobalIlluminationMethod', 'r.Lumen.DiffuseIndirect.Allow', 'r.ReflectionMethod']);
const versions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
for (const [name, entry] of Object.entries(versions)) {
  assert.equal(name, path.basename(name));
  assert.equal(audit(path.join(source, name)).sha256, entry.sha256, name);
}
fs.mkdirSync(dest);
for (const name of Object.keys(versions))
  if (!['index.html', 'config-files.json', 'pipeline-prewarm.json', 'asset-versions.json'].includes(name))
    fs.linkSync(path.join(source, name), path.join(dest, name));
const configs = JSON.parse(fs.readFileSync(path.join(source, 'config-files.json')));
const ini = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
assert(ini);
const text = Buffer.from(ini.data, 'base64').toString() + '\n[SystemSettings]\n' +
  Object.entries(profile.settings).map(([key, value]) => key + '=' + value).join('\n') + '\n';
ini.data = Buffer.from(text).toString('base64');
ini.sha256 = crypto.createHash('sha256').update(text).digest('hex');
fs.writeFileSync(path.join(dest, 'config-files.json'), JSON.stringify(configs));
let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = JSON.parse(match[1]);
// Capture the new configuration's actual pipelines before creating its prewarm pack.
delete assets.pipelinePrewarm;
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';');
fs.writeFileSync(path.join(dest, 'index.html'), html);
writeVersions(dest, fs.readdirSync(dest).map(name => audit(path.join(dest, name))));
// Snapshot before creating a child stage; all linked files remain immutable.
const officialFiles = fs.readdirSync(official, {recursive: true, withFileTypes: true})
  .filter(entry => entry.isFile())
  .map(entry => path.relative(official, path.join(entry.parentPath, entry.name)));
fs.mkdirSync(officialDest);
for (const relative of officialFiles) {
  const target = path.join(officialDest, relative);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.linkSync(path.join(official, relative), target);
}
// The official server only serves root files or paths named by a root JSON list.
fs.writeFileSync(path.join(official, 'comparison-no-lumen-files.json'), JSON.stringify({
  files: officialFiles.filter(relative => !relative.endsWith('.br'))
    .map(relative => 'no-lumen-20261110/' + relative.replaceAll('\\', '/'))
}));
const report = {date: new Date().toISOString(), pass: true, profile,
  source: audit(__filename), baseline: audit(path.join(source, 'asset-versions.json')),
  capturePackage: audit(path.join(dest, 'asset-versions.json')),
  officialSource: official, officialStage: officialDest,
  officialFiles: officialFiles.map(relative => ({relative, ...audit(path.join(official, relative))})),
  boundary: 'Runtime configuration only; unchanged engine binaries and Cook. Capture package has no recorded prewarm yet. Install an independently captured official pack with the official atomic-replacement installer.'};
fs.writeFileSync(path.join(__dirname, 'results/villa-no-lumen-20261110-package.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({dest, officialDest, linkedOfficialFiles: officialFiles.length}));
