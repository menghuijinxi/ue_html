'use strict';
// A runtime-only benchmark must use the renderer matching its already cooked shaders.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), revision = process.argv[2];
assert(/^[a-f0-9]{7,40}$/.test(revision));
const repository = path.join(root, 'reference-engine');
const commit = cp.execFileSync('git', ['-C', repository, 'rev-parse', revision + '^{commit}'], {encoding:'utf8'}).trim();
const host = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime');
const paths = ['RenderCore/Public/WebShaderPlatform.h', 'Renderer/Private/TranslucentLighting.cpp', 'Renderer/Private/SystemTextures.cpp'];
const snapshot = path.join(root, '.tools/web-renderer-revisions', commit);
for (const file of paths) {
  const destination = path.join(host, file), saved = path.join(snapshot, file);
  assert(fs.realpathSync(destination) === destination && fs.statSync(destination).nlink === 1,
    'Renderer overrides must target isolated local build files');
  const bytes = cp.execFileSync('git', ['-C', repository, 'show', commit + ':Engine/Source/Runtime/' + file], {maxBuffer: 4*1024*1024});
  fs.mkdirSync(path.dirname(saved), {recursive:true}); fs.writeFileSync(saved, bytes);
  if (!fs.readFileSync(destination).equals(bytes)) fs.writeFileSync(destination, bytes);
}
console.log(JSON.stringify({commit, snapshot, paths}));
