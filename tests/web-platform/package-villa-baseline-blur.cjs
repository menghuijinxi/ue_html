'use strict';
// Historical A/B fixture. Keep the archived browser host as well as the old WASM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {initializeProjectOutput, assertProjectOutputTree, assertProjectOutput} = require('./project-output.cjs');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {readPage, writePage, replaceFile, prepareRecordedPrewarm} = require('./web-pipeline-prewarm-package.cjs');

const phase = process.argv[2];
const corpus = process.argv[3];
assert((phase === 'capture' && !corpus) || (phase === 'test' && corpus));
initializeProjectOutput();
const build = path.join(__dirname, 'build');
const name = 'villa-baseline-motion-blur-4-20261119';
const source = path.join(build, 'villa-pso-eager-20261117-d', 'release');
const folder = assertProjectOutputTree(path.join(build, name + (phase === 'capture' ? '-capture' : '')));
assert(!fs.existsSync(folder), 'Use a new name for an existing package');
const versions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
// The historical manifest includes the hash of its predecessor under its own name.
const files = Object.keys(versions).filter(file => file !== 'asset-versions.json');
for (const file of files) {
  assert.equal(path.basename(file), file);
  assert.equal(audit(path.join(source, file)).sha256, versions[file].sha256, file);
}
const page = readPage(source);
assert(page.args.includes('-WebPSOPrecache') && page.assets.pipelinePrewarm.source === 'automatic-collectors');
fs.mkdirSync(folder);
for (const file of files) {
  if (!['release-report.json', 'config-files.json', 'pipeline-prewarm.json', 'index.html'].includes(file))
    fs.linkSync(path.join(source, file), path.join(folder, file));
}
const configs = JSON.parse(fs.readFileSync(path.join(source, 'config-files.json')));
const ini = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
const original = Buffer.from(ini.data, 'base64').toString('utf8');
const setting = /^r\.MotionBlurQuality=0(?=\r?$)/gm;
assert.equal([...original.matchAll(setting)].length, 1);
const updated = original.replace(setting, 'r.MotionBlurQuality=4');
ini.data = Buffer.from(updated).toString('base64');
ini.sha256 = crypto.createHash('sha256').update(updated).digest('hex');
replaceFile(path.join(folder, 'config-files.json'), JSON.stringify(configs));

const recorded = page.assets.pipelinePrewarm;
delete page.assets.pipelinePrewarm;
writePage(folder, page);
if (phase === 'test') {
  const prepared = prepareRecordedPrewarm(folder, assertProjectOutput(corpus));
  assert.equal(prepared.source, 'automatic-collectors');
  const file = path.join(folder, recorded.url);
  replaceFile(file, JSON.stringify(prepared.pack));
  const testPage = readPage(folder);
  testPage.assets.pipelinePrewarm = {...recorded, sha256: audit(file).sha256, config: prepared.pack.config};
  writePage(folder, testPage);
}
writeVersions(folder, fs.readdirSync(folder).map(file => audit(path.join(folder, file))));
console.log(JSON.stringify({phase, folder, quality: 4}));
