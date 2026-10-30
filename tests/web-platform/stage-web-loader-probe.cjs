const fs = require('node:fs');
const path = require('node:path');
const {audit} = require('./content-file-metadata.cjs');
const source = path.join(__dirname, 'build/villa-performance-before');
const output = path.join(__dirname, 'build/villa-performance-fast-loader');
fs.mkdirSync(output, {recursive: true});
for (const name of fs.readdirSync(source)) {
  const from = path.join(source, name), to = path.join(output, name);
  if (name === 'content.bin') { if (!fs.existsSync(to)) fs.linkSync(from, to); }
  else fs.copyFileSync(from, to);
}
let text = fs.readFileSync(path.join(output, 'index.html'), 'utf8');
for (const name of ['web-content-io.js', 'web-content-worker.js']) {
  fs.copyFileSync(path.join(__dirname, name), path.join(output, name));
  text = text.replace(new RegExp(`("${name.replaceAll('.', '\\.')}":")[a-f0-9]{64}`),
    '$1' + audit(path.join(output, name)).sha256);
}
fs.writeFileSync(path.join(output, 'index.html'), text);
console.log(output);
