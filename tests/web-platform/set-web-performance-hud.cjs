'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {finalizeDesktopRelease} = require('./web-release-defaults.cjs');
const {replaceFile} = require('./web-pipeline-prewarm-package.cjs');
const folder = process.argv.find(value => value.startsWith('--folder='))?.slice(9);
assert(folder && /^[a-z0-9-]+$/.test(folder));
const output = path.join(__dirname, 'build', folder), index = path.join(output, 'index.html');
const before = audit(index), config = audit(path.join(output, 'config-files.json'));
const versions = JSON.parse(fs.readFileSync(path.join(output, 'asset-versions.json')));
for (const [name, item] of Object.entries(versions))
  assert.equal(audit(path.join(output, name)).sha256, item.sha256, name);
const html = fs.readFileSync(index, 'utf8').replace(
  /\/\* Presentation: keep the scene free of the performance\/debug overlay\. \*\/\r?\n#web-performance-hud \{ display: none !important; \}\r?\n/g, '');
assert(!/#web-performance-hud\s*\{[^}]*display:\s*none/.test(html));
replaceFile(index, html);
const optimizationBuild = process.argv.includes('--audit-current-build') ? JSON.parse(fs.readFileSync(
  path.join(__dirname,'results/web-engine-full-thread-build-results.json'),'utf8').replace(/^\uFEFF/,'')) : undefined;
const release = finalizeDesktopRelease(output,{optimizationBuild});
assert.equal(audit(config.file).sha256, config.sha256);
const products = [...new Set([...Object.keys(versions), ...release.files])].map(name => audit(path.join(output, name)));
products.push(writeVersions(output, products));
const report = {date: new Date().toISOString(), pass: true, output, before,
  performanceHUDVisible: true, projectConfigurationPreserved: true, release, products,
  sources:[__filename,...['web-release-defaults.cjs','web-pipeline-prewarm-package.cjs','web-optimization-contract.cjs',
    'probe-villa-startup.cjs'].map(name=>path.join(__dirname,name))].map(audit)};
const reportFile = path.join(__dirname, 'results', folder + '-hud-restored.json');
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, output, reportFile, prewarm: release.prewarm.selection}));
