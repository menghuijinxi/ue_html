'use strict';
const fs = require('node:fs'), assert = require('node:assert/strict');
const {decodeMetadataBinary} = require('./web-shader-code.js');
const {audit} = require('./content-file-metadata.cjs');
const [jsonFile, binaryFile, output] = process.argv.slice(2);
assert(jsonFile && binaryFile && output, 'Usage: node verify-web-shader-metadata.cjs json-corpus cb-corpus report.json');
const json = fs.readFileSync(jsonFile), binary = fs.readFileSync(binaryFile);
let jsonCursor = 0, binaryCursor = 0, count = 0, first;
while (jsonCursor < json.length) {
  const jsonSize = json.readUInt32LE(jsonCursor), binarySize = binary.readUInt32LE(binaryCursor);
  jsonCursor += 4; binaryCursor += 4;
  assert(jsonCursor + jsonSize <= json.length && binaryCursor + binarySize <= binary.length);
  const bytes = binary.subarray(binaryCursor, binaryCursor + binarySize);
  assert.deepEqual(decodeMetadataBinary(bytes), JSON.parse(json.subarray(jsonCursor, jsonCursor + jsonSize).toString('utf8')));
  first ||= bytes;
  jsonCursor += jsonSize; binaryCursor += binarySize; ++count;
}
assert(count > 0 && jsonCursor === json.length && binaryCursor === binary.length);
let rejected = 0;
for (const size of [0, 1, Math.floor(first.length / 2), first.length - 1]) {
  assert.throws(() => decodeMetadataBinary(first.subarray(0, size))); ++rejected;
}
assert.throws(() => decodeMetadataBinary(Buffer.concat([first, Buffer.from([0])]))); ++rejected;
const report = {pass: true, count, malformedInputsRejected: rejected,
  sources: [__filename, require.resolve('./web-shader-code.js'), jsonFile, binaryFile].map(audit),
  boundary: 'UE native writer/reader also checks semantic equality against FJsonSerializer. This independently checks the diagnostic JavaScript reader against every original JSON object.'};
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: true, count, rejected}));
