const fs = require('node:fs');
const crypto = require('node:crypto');
const blockSize = 256 * 1024;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function metadata(file, url) {
  const descriptor = fs.openSync(file, 'r');
  const blocks = [], hash = crypto.createHash('sha256'), buffer = Buffer.alloc(blockSize);
  let size = 0;
  try {
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, size);
      if (!length) break;
      const bytes = buffer.subarray(0, length);
      blocks.push(sha(bytes));
      hash.update(bytes);
      size += length;
    }
  } finally { fs.closeSync(descriptor); }
  return {url, size, sha256: hash.digest('hex'), blockSize, blocks};
}
function audit(file) {
  const descriptor = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(blockSize);
  try {
    for (;;) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!length) break;
      hash.update(buffer.subarray(0, length));
    }
  } finally { fs.closeSync(descriptor); }
  return {file, sha256: hash.digest('hex')};
}
module.exports = {metadata, audit};
