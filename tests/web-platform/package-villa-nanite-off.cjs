'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const source = path.join(__dirname, 'build/nanite-core-scene');
const output = path.join(__dirname, 'build/villa-nanite-off-20261111');
const packageFile = path.join(source, 'package.json');
const baseline = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
assert(baseline.pass && baseline.fullScene);
for (const item of baseline.products) assert.equal(audit(item.file).sha256, item.sha256, item.file);
assert(!fs.existsSync(output), 'Keep previous packages intact; use a fresh destination');
fs.mkdirSync(output);
// Only immutable payloads share disk allocation. HTML, configuration and
// version metadata are independent files because this variant edits them.
const shared = [];
for (const item of baseline.products) {
  const name = path.basename(item.file);
  if (['index.html', 'config-files.json', 'asset-versions.json'].includes(name)) continue;
  const target = path.join(output, name);
  fs.linkSync(item.file, target); // Fail rather than silently duplicate gigabytes.
  shared.push({name, sha256: item.sha256, bytes: fs.statSync(target).size});
}
const configs = JSON.parse(fs.readFileSync(path.join(source, 'config-files.json'), 'utf8'));
const config = configs.find(c => c.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
assert(config);
const original = Buffer.from(config.data, 'base64').toString('utf8');
assert(!/^r\.Nanite=/mi.test(original));
const text = original + '\n[SystemSettings]\nr.Nanite=0\n';
config.data = Buffer.from(text).toString('base64');
config.sha256 = crypto.createHash('sha256').update(text).digest('hex');
fs.writeFileSync(path.join(output, 'config-files.json'), JSON.stringify(configs));
let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const match = html.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
const assets = JSON.parse(match[1]);
assets.versions['config-files.json'] = audit(path.join(output, 'config-files.json')).sha256;
html = html.replace(match[0], 'const localRuntimeAssets = ' + JSON.stringify(assets) + ';')
  .replace(/<title>[^<]*<\/title>/, '<title>Villa - Nanite 已关闭</title>');
assert(html.includes('"-WebNaniteScene"')); // Keep the same runtime route; disable its native CVar at startup.
fs.writeFileSync(path.join(output, 'index.html'), html);
const products = fs.readdirSync(output).map(name => audit(path.join(output, name)));
products.push(writeVersions(output, products));
const report = {pass: true, date: new Date().toISOString(), source: audit(__filename), output,
  baseline: audit(packageFile), settingsOverrides: {'r.Nanite': 0}, shared, products,
  url: 'http://127.0.0.1:8765/build/villa-nanite-off-20261111/index.html',
  additionalFileBytes: ['index.html', 'config-files.json', 'asset-versions.json']
    .reduce((sum, name) => sum + fs.statSync(path.join(output, name)).size, 0),
  boundary: 'Current Villa runtime and Cook payloads, Nanite disabled from startup through the native r.Nanite setting. '
    + 'Uses existing fallback geometry; this is not the November 7 binary or a Nanite performance fix. '
    + 'Hard-linked payloads must remain immutable. Browser startup and reload validation is recorded separately.'};
const file = path.join(__dirname, 'results/villa-nanite-off-20261111-package.json');
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log({pass: true, output, url: report.url, additionalFileBytes: report.additionalFileBytes});
