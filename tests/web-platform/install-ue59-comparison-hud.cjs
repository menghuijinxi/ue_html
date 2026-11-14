'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const stage = path.resolve(__dirname, 'build/ue59-official-villa-20261109');
const index = path.join(stage, 'index.html');
const marker = '<script src="wasm-profile.js"></script>';
let html = fs.readFileSync(index, 'utf8');
assert(html.includes(marker), 'Official page template changed');
// Replace directory entries so a staged hardlink cannot change the original archive.
function replace(file, data) {
  const temp = file + '.comparison-tmp';
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}
const scripts = ['web-engine-host.js', 'ue59-performance-hud.js'].map(name => {
  const data = fs.readFileSync(path.join(__dirname, name));
  const hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  const target = 'comparison-' + path.basename(name, '.js') + '.' + hash + '.js';
  replace(path.join(stage, target), data);
  return `<script src="${target}"></script>`;
});
html = html.replace(/<!-- comparison-hud:start -->[\s\S]*?<!-- comparison-hud:end -->\r?\n?/g, '');
html = html.replace(marker, '<!-- comparison-hud:start -->\n' + scripts.join('\n') +
  '\n<!-- comparison-hud:end -->\n' + marker);
replace(index, html);
replace(index + '.br', zlib.brotliCompressSync(Buffer.from(html)));
console.log(JSON.stringify({stage, scripts, compressedIndex: true}));
