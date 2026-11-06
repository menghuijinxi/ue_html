'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

// Read only the exception and its containing module, not a speculative stack.
function inspect(buffer) {
  const range = (offset, length) => {
    assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length) &&
      offset >= 0 && length >= 0 && offset + length <= buffer.length, 'Truncated minidump');
    return offset;
  };
  const u32 = offset => buffer.readUInt32LE(range(offset, 4));
  const u64 = offset => buffer.readBigUInt64LE(range(offset, 8));
  assert.equal(u32(0), 0x504d444d, 'Expected an MDMP file');
  const count = u32(8), directory = u32(12), streams = new Map();
  range(directory, count * 12);
  for (let index = 0; index < count; ++index) {
    const at = directory + index * 12;
    streams.set(u32(at), {offset: u32(at + 8), size: u32(at + 4)});
  }
  const stream = (type, minimum) => {
    const entry = streams.get(type);
    assert(entry && entry.size >= minimum, `Missing or truncated stream ${type}`);
    range(entry.offset, entry.size);
    return entry;
  };
  const exception = stream(6, 168), modules = stream(4, 4);
  const address = u64(exception.offset + 24), moduleCount = u32(modules.offset);
  assert(4 + moduleCount * 108 <= modules.size, 'Truncated module list');
  const hex = value => '0x' + value.toString(16);
  let module = null;
  for (let index = 0; index < moduleCount; ++index) {
    const at = modules.offset + 4 + index * 108;
    const base = u64(at), size = u32(at + 8);
    if (address < base || address >= base + BigInt(size)) continue;
    const nameOffset = u32(at + 20), nameLength = u32(nameOffset);
    assert.equal(nameLength % 2, 0, 'Invalid UTF-16 module name');
    range(nameOffset + 4, nameLength);
    module = {path: buffer.toString('utf16le', nameOffset + 4, nameOffset + 4 + nameLength),
      base: hex(base), size, offset: hex(address - base)};
    break;
  }
  const parameterCount = u32(exception.offset + 32);
  assert(parameterCount <= 15, 'Invalid exception parameter count');
  return {timestamp: new Date(u32(20) * 1000).toISOString(),
    threadId: u32(exception.offset), exceptionCode: hex(u32(exception.offset + 8)),
    address: hex(address),
    parameters: Array.from({length: parameterCount}, (_, index) =>
      hex(u64(exception.offset + 40 + index * 8))), module,
    boundary: 'Exception location only. Does not identify root cause, unwind a stack, or diagnose hardware health.'};
}

function inspectFile(file) {
  const buffer = fs.readFileSync(file);
  return {file: path.resolve(file), sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    ...inspect(buffer)};
}

module.exports = {inspect, inspectFile};
if (require.main === module) {
  assert(process.argv.length > 2, 'Usage: node inspect-minidump.cjs <dump> [dump...]');
  console.log(JSON.stringify(process.argv.slice(2).map(inspectFile), null, 2));
}
