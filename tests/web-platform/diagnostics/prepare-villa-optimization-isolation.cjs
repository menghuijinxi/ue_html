'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('../content-file-metadata.cjs');
const {readPage, writePage} = require('../web-pipeline-prewarm-package.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const {settings} = require('../web-accepted-defaults.cjs');
const base = path.resolve(__dirname, '..'), source = path.join(base, 'build/villa-tsr-tiles-20261112');
const original = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
const variants = {
  off: {folder: 'villa-added-optimizations-off-20261112', overrides: {
    'r.WebGPU.IndirectDrawReuse': 0, 'r.WebGPU.VSMPageOptimization': 0, 'r.WebGPU.TSRLargeTiles': 0}},
  plain: {folder: 'villa-web-optimizations-off-20261112', overrides:
    Object.fromEntries(Object.keys(settings).filter(key => /^r\.Web(GPU)?\./.test(key)).map(key => [key, 0]))},
};
const output = assertProjectOutput(path.join(base, 'results/villa-optimization-isolation-packages-20261112.json'));
assert(!fs.existsSync(output));
for (const variant of Object.values(variants)) {
  variant.path = assertProjectOutputTree(path.join(base, 'build', variant.folder));
  assert(!fs.existsSync(variant.path), 'Preserve existing diagnostic packages');
}
for (const [name, record] of Object.entries(original))
  assert.equal(audit(path.join(source, name)).sha256, record.sha256, 'Source package changed: ' + name);
const report = {date: new Date().toISOString(), pass: false, diagnosticOnly: true,
  source: audit(__filename), package: audit(path.join(source, 'asset-versions.json')), variants,
  boundary: 'Startup-only isolation packages use immutable shared content and runtime files. ' +
    'The original actual prewarm is replayed; diagnostic overrides may create additional pipelines at startup. ' +
    'These packages are not formal releases or matching release prewarm corpora.'};
try {
  for (const [mode, variant] of Object.entries(variants)) {
    fs.mkdirSync(variant.path);
    for (const name of [...Object.keys(original), 'asset-versions.json']) {
      if (['asset-versions.json', 'web-engine-worker.js', 'index.html'].includes(name)) continue;
      fs.linkSync(path.join(source, name), path.join(variant.path, name));
    }
    fs.copyFileSync(path.join(source, 'index.html'), path.join(variant.path, 'index.html'));
    const marker = "        removeRunDependency('worker-content');";
    let worker = fs.readFileSync(path.join(source, 'web-engine-worker.js'), 'utf8');
    assert.equal(worker.split(marker).length, 2);
    const ini = '\n[SystemSettings]\n' + Object.entries(variant.overrides).map(([key, value]) =>
      key + '=' + value).join('\n') + '\n';
    worker = worker.replace(marker, `        const isolationIni = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(isolationIni, FS.readFile(isolationIni, {encoding: 'utf8'}) + ${JSON.stringify(ini)});
        globalThis.__villaOptimizationIsolation = ${JSON.stringify({mode, diagnosticOnly: true, overrides: variant.overrides})};
${marker}`);
    worker = worker.replace('const diagnosticStateKeys = [', "const diagnosticStateKeys = ['__villaOptimizationIsolation',");
    fs.writeFileSync(path.join(variant.path, 'web-engine-worker.js'), worker);
    const page = readPage(variant.path);
    page.assets.diagnosticOnly = true;
    page.assets.optimizationIsolation = mode;
    page.assets.versions['web-engine-worker.js'] = audit(path.join(variant.path, 'web-engine-worker.js')).sha256;
    writePage(variant.path, page);
    const products = Object.keys(original).map(name => audit(path.join(variant.path, name)));
    variant.manifest = writeVersions(variant.path, products);
  }
  report.pass = true;
} catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
finally {fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');}
