const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const engine = path.resolve(process.argv[2]);
const source = path.join(engine, 'Engine/Plugins/EnhancedInput/Source/EnhancedInput');
const output = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime/EnhancedInput');
const walk = directory => fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
fs.mkdirSync(output, {recursive: true});
assert.equal(fs.realpathSync(output), output, 'Enhanced Input must use an isolated module copy');
const copies = walk(source).map(file => {
  const target = path.join(output, path.relative(source, file));
  const original = audit(file);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  if (!fs.existsSync(target) || audit(target).sha256 !== original.sha256) {
    if (fs.existsSync(target)) fs.chmodSync(target, 0o666);
    fs.copyFileSync(file, target);
  }
  assert.equal(audit(target).sha256, original.sha256);
  return {source: original, copied: audit(target)};
});
fs.writeFileSync(path.join(__dirname, 'results/web-enhanced-input-host.json'),
  JSON.stringify({pass: true, copies}, null, 2));
console.log(JSON.stringify({enhancedInput: copies.length, pass: true}));
