'use strict';
// Audit the actual uncompressed UE shader libraries without loading content.bin.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {audit} = require('./content-file-metadata.cjs');
const {decodeMetadataBinary} = require('./web-shader-code.js');
const folder = process.argv[2], output = process.argv[3];
const corpus = process.argv[4] ? fs.openSync(process.argv[4], 'wx') : null;
assert(folder && output, 'Usage: node analyze-web-shader-metadata.cjs package-directory output.json');
const manifestFile = path.join(folder, 'content-files.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile));
const fd = fs.openSync(path.join(folder, manifest.pack.url), 'r');
const read = (offset, size) => {
  const bytes = Buffer.alloc(size);
  assert.equal(fs.readSync(fd, bytes, 0, size, offset), size);
  return bytes;
};
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const report = {sources: [audit(__filename), audit(require.resolve('./web-shader-code.js')), audit(manifestFile)], libraries: [],
  boundary: 'Whole Cook inventory, not the set of shaders loaded during startup. Field bytes use compact JSON and exclude root keys/separators.'};
try {
  for (const file of manifest.files.filter(f => f.path.endsWith('.ushaderbytecode'))) {
    assert.equal(read(file.offset, 4).readUInt32LE(), 3);
    let cursor = 4;
    const arrays = {};
    for (const [name, stride] of [['mapsHash', 8], ['shadersHash', 8], ['maps', 16], ['shaders', 17], ['preload', 16], ['indices', 4]]) {
      const count = read(file.offset + cursor, 4).readUInt32LE();
      assert(count > 0 && cursor + 4 + count * stride <= file.size);
      cursor += 4; arrays[name] = {count, offset: cursor}; cursor += count * stride;
    }
    const entries = read(file.offset + arrays.shaders.offset, arrays.shaders.count * 17);
    const row = {path: file.path, sha256: file.sha256, shaders: arrays.shaders.count,
      metadataBytes: 0, withoutIndentationBytes: 0, compactJSONBytes: 0, wgslBytes: 0, encodings: {json: 0, binary: 0}, fields: {}};
    const semanticSignatures = [], wgslSignatures = [];
    for (let index = 0; index < arrays.shaders.count; ++index) {
      const entry = index * 17, start = Number(entries.readBigUInt64LE(entry));
      const size = entries.readUInt32LE(entry + 8), uncompressed = entries.readUInt32LE(entry + 12);
      assert.equal(size, uncompressed, 'This audit requires uncompressed Web shader storage');
      assert(cursor + start + size <= file.size);
      const header = read(file.offset + cursor + start, 28);
      assert.equal(header.readUInt32LE(), 0x53475057);
      const schema = header.readUInt32LE(4); assert([1, 2].includes(schema));
      const metadataSize = header.readUInt32LE(20), wgslSize = header.readUInt32LE(24);
      assert(28 + metadataSize + wgslSize <= size);
      const metadata = read(file.offset + cursor + start + 28, metadataSize);
      const value = schema === 2 ? decodeMetadataBinary(metadata) : JSON.parse(metadata.toString('utf8'));
      const text = schema === 2 ? JSON.stringify(value) : metadata.toString('utf8');
      ++row.encodings[schema === 2 ? 'binary' : 'json'];
      const wgsl = read(file.offset + cursor + start + 28 + metadataSize, wgslSize);
      const {schema: omittedSchema, formatVersion: omittedVersion, ...semantic} = value;
      const wgslHash = digest(wgsl);
      wgslSignatures.push(wgslHash);
      semanticSignatures.push(digest(wgslHash + JSON.stringify(canonical(semantic))));
      if (corpus !== null) {
        const bytes = Buffer.from(text), length = Buffer.alloc(4);
        length.writeUInt32LE(bytes.length); fs.writeSync(corpus, length); fs.writeSync(corpus, bytes);
      }
      const withoutIndentation = text.replace(/^[\t ]+/gm, '');
      assert.deepEqual(JSON.parse(withoutIndentation), value);
      row.metadataBytes += metadataSize; row.withoutIndentationBytes += Buffer.byteLength(withoutIndentation);
      row.compactJSONBytes += Buffer.byteLength(JSON.stringify(value)); row.wgslBytes += wgslSize;
      for (const [name, field] of Object.entries(value))
        row.fields[name] = (row.fields[name] || 0) + Buffer.byteLength(JSON.stringify(field));
    }
    row.fields = Object.fromEntries(Object.entries(row.fields).sort((a, b) => b[1] - a[1]));
    row.wgslInventorySha256 = digest(wgslSignatures.sort().join('\n'));
    row.semanticInventorySha256 = digest(semanticSignatures.sort().join('\n'));
    report.libraries.push(row);
  }
  assert(report.libraries.length > 0);
} finally {fs.closeSync(fd); if (corpus !== null) fs.closeSync(corpus);}
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
