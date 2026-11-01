'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');

module.exports = function prepareManualFetchConfig(root) {
  const source = path.join(root, 'reference-engine/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini');
  const before = fs.readFileSync(source, 'utf8');
  const section = /(\[ShaderPlatform SP_WEBGPU_SM5\][\s\S]*?)(?=\[ShaderPlatform|$)/;
  const match = before.match(section);
  assert(match && match[0].includes('bSupportsManualVertexFetch=false'));
  const after = before.replace(section, value => value.replace('bSupportsManualVertexFetch=false', 'bSupportsManualVertexFetch=true'));
  const file = path.join(root, '.tools/web-manual-vertex-fetch/DataDrivenPlatformInfo.ini');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, after);
  return {file, sources: [source, __filename].map(audit), product: audit(file)};
};
