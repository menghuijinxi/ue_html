'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
const {audit} = require('../content-file-metadata.cjs');
const {writeVersions} = require('../asset-versions.cjs');
const {readPage, writePage} = require('../web-pipeline-prewarm-package.cjs');
const overrideAtlas = require('./villa-distance-field-atlas.cjs');

initializeProjectOutput();
const build = path.resolve(__dirname, '../build');
const source = assertProjectOutputTree(path.join(build, 'villa-nanite-merged-20261118-raw-mouse'));
const output = assertProjectOutputTree(path.join(build, 'villa-nanite-merged-20261118-atlas-r8'));
assert(!fs.existsSync(output), 'Diagnostic package already exists: ' + output);
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json'), 'utf8'));
const page = readPage(source);
const worker = 'web-engine-worker.js';
const originalWorker = path.join(source, worker);
assert.equal(audit(originalWorker).sha256, page.assets.versions[worker]);
const stage = fs.mkdtempSync(assertProjectOutput(output + '.staging-'));
const products = [];
for (const [name, entry] of Object.entries(manifest)) {
  assert.equal(name, path.basename(name));
  if (name === worker || name === 'index.html') continue;
  const from = path.join(source, name);
  const file = assertProjectOutput(path.join(stage, name));
  if (name === 'content.bin' || name === 'UEWebEngineThreads.wasm') fs.linkSync(from, file);
  else fs.copyFileSync(from, file);
  const product = audit(file);
  assert.equal(product.sha256, entry.sha256, name);
  products.push(product);
}
const targetWorker = assertProjectOutput(path.join(stage, worker));
fs.writeFileSync(targetWorker, `'use strict';\n(${overrideAtlas})('r8unorm');\n` + fs.readFileSync(originalWorker, 'utf8'));
const workerProduct = audit(targetWorker);
page.assets.versions[worker] = workerProduct.sha256;
writePage(stage, page);
products.push(workerProduct, audit(path.join(stage, 'index.html')));
writeVersions(stage, products);
fs.renameSync(stage, output);
console.log(output);
