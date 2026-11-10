'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {prepareRecordedPrewarm, installRecordedPrewarm} = require('./web-pipeline-prewarm-package.cjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'), input = option('corpus');
assert(tag && /^[a-z0-9-]+$/.test(tag) && input);
const profile = require('./villa-engine-comparison.json');
const sourceName = option('source') || profile.startupBaseline || profile.ours;
assert(/^[a-z0-9-]+$/.test(sourceName));
const source = path.join(__dirname, 'build', sourceName), dest = path.join(__dirname, 'build', tag);
assert(!fs.existsSync(dest), 'Published packages are immutable');
const versions = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
for (const [name, entry] of Object.entries(versions)) {
  assert.equal(name, path.basename(name));
  assert.equal(audit(path.join(source, name)).sha256, entry.sha256, name);
}
const prepared = prepareRecordedPrewarm(source, input);
fs.mkdirSync(dest);
for (const name of Object.keys(versions)) {
  if (['index.html', 'web-engine-worker.js', 'web-engine-host.js', 'web-content-worker.js', 'web-pipeline-prewarm.js',
    'pipeline-prewarm.json', 'asset-versions.json'].includes(name)) continue;
  fs.linkSync(path.join(source, name), path.join(dest, name));
}
fs.copyFileSync(path.join(source, 'index.html'), path.join(dest, 'index.html'));
const startupPrewarm = installRecordedPrewarm(dest, prepared);
writeVersions(dest, fs.readdirSync(dest).map(name => audit(path.join(dest, name))));
fs.writeFileSync(path.join(__dirname, 'results', tag + '-package.json'), JSON.stringify({
  date: new Date().toISOString(), pass: true, output: dest, source: audit(__filename),
  capture: prepared.capture, corpus: prepared.corpus, startupPrewarm,
  products: fs.readdirSync(dest).map(name => audit(path.join(dest, name))),
  boundary: 'Recorded pipelines replace speculative startup precaching only in this opt-in package. Unrecorded pipelines still compile on demand.'
}, null, 2));
console.log(JSON.stringify({dest, modules: startupPrewarm.modules, pipelines: startupPrewarm.pipelines}));
