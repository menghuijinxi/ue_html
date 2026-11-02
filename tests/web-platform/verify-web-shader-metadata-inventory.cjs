'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const [baselineFile, binaryFile, output] = process.argv.slice(2);
assert(baselineFile && binaryFile && output, 'Usage: node verify-web-shader-metadata-inventory.cjs baseline.json binary.json report.json');
const baseline = JSON.parse(fs.readFileSync(baselineFile)), binary = JSON.parse(fs.readFileSync(binaryFile));
assert.equal(baseline.libraries.length, binary.libraries.length);
const libraries = [];
for (const before of baseline.libraries) {
  const after = binary.libraries.find(row => path.basename(row.path) === path.basename(before.path));
  assert(after, 'Missing binary library: ' + before.path);
  assert.equal(before.encodings.json, before.shaders);
  assert.equal(after.encodings.binary, after.shaders);
  assert.equal(after.shaders, before.shaders, 'Shader count changed');
  assert.equal(after.wgslInventorySha256, before.wgslInventorySha256, 'WGSL programs changed');
  assert.equal(after.semanticInventorySha256, before.semanticInventorySha256, 'Reflection values changed');
  libraries.push({path: after.path, shaders: after.shaders, jsonBytes: before.metadataBytes,
    binaryBytes: after.metadataBytes, wgslInventorySha256: after.wgslInventorySha256,
    semanticInventorySha256: after.semanticInventorySha256});
}
const report = {pass: true, sources: [__filename, baselineFile, binaryFile].map(audit), libraries,
  boundary: 'Compares every WGSL program and reflection value, excluding only schema and formatVersion. Shader/Cook hashes must change for the new wire format.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, shaders: libraries.reduce((sum, row) => sum + row.shaders, 0)}));
