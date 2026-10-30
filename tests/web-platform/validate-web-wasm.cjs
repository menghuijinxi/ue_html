const fs = require('node:fs');
const assert = require('node:assert/strict');

const file = process.argv[2];
assert(file, 'Expected a WASM file');
new WebAssembly.Module(fs.readFileSync(file));
console.log(JSON.stringify({pass: true, file}));
