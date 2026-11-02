'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
assert(process.argv[2], 'Pass the installed engine directory');
const stock = path.resolve(process.argv[2], 'Engine/Source/Runtime/RHI');
const destination = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/RHI');
assert(destination.startsWith(root + path.sep));
if (fs.lstatSync(destination).isSymbolicLink()) {
  assert.equal(fs.realpathSync(destination), fs.realpathSync(stock));
  fs.unlinkSync(destination); // Remove only the checked junction, never its target.
}
fs.mkdirSync(destination, {recursive: true});
assert.equal(fs.realpathSync(destination), destination);
const marker = path.join(destination, '.web-local-copy');
if (!fs.existsSync(marker)) {
  fs.cpSync(stock, destination, {recursive: true});
  fs.writeFileSync(marker, stock);
}
const source = path.join(root, 'reference-engine/Engine/Source/Runtime/RHI/Private/PipelineStateCache.cpp');
const target = path.join(destination, 'Private/PipelineStateCache.cpp');
assert.equal(fs.statSync(target).nlink, 1);
fs.chmodSync(target, 0o666);
if (!fs.readFileSync(source).equals(fs.readFileSync(target))) fs.copyFileSync(source, target);
console.log('Prepared local RHI pipeline cache overlay');
