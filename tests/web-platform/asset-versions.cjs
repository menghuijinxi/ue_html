const fs = require('node:fs');
const path = require('node:path');
const {audit} = require('./content-file-metadata.cjs');

function writeVersions(directory, products) {
  const versions = Object.fromEntries(products.map(product => {
    const stat = fs.statSync(product.file);
    return [path.basename(product.file), {sha256: product.sha256, size: stat.size, mtimeMs: stat.mtimeMs}];
  }));
  const file = path.join(directory, 'asset-versions.json');
  fs.writeFileSync(file, JSON.stringify(versions));
  return audit(file);
}
module.exports = {writeVersions};
