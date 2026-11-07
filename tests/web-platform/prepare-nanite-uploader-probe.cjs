'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'reference-engine/Engine/Source/Runtime/Engine/Private/Nanite');
const output = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Intermediate/NaniteUploaderProbe');
fs.mkdirSync(output, {recursive: true});
// Module-only UBT builds do not stage RuntimeDependencies. The early shader
// registration needs Dawn's host DLL before commandlet initialization.
const hostDLL = path.join(root, '.tools/ue58-dawn-host/WebGPUHost.dll');
const stagedDLL = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/WebGPUHost.dll');
if (fs.existsSync(stagedDLL)) {
  assert.equal(fs.statSync(stagedDLL).nlink, 1);
  assert.equal(fs.realpathSync(stagedDLL).toLowerCase(), stagedDLL.toLowerCase());
}
if (!fs.existsSync(stagedDLL) || audit(hostDLL).sha256 !== audit(stagedDLL).sha256) fs.copyFileSync(hostDLL, stagedDLL);
// Compile the runtime uploader verbatim in the diagnostic module. Only symbol
// and console names change, to coexist with the installed Engine DLL. No
// allocation, ordering, shader selection, parameter binding or dispatch is replaced.
const rename = text => text.replaceAll('FStreamingPageUploader', 'FWebProbeStreamingPageUploader')
  .replaceAll('FTranscodePageToGPU_CS', 'FWebProbeTranscodePageToGPU_CS')
  .replaceAll('r.Nanite.Streaming.', 'r.WebProbe.Nanite.Streaming.');
for (const name of ['NaniteStreamingPageUploader.h', 'NaniteStreamingPageUploader.cpp']) {
  const file = path.join(output, name), text = rename(fs.readFileSync(path.join(source, name), 'utf8'));
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text);
}
fs.writeFileSync(path.join(output, 'sources.json'), JSON.stringify({
  sources: [__filename, ...['NaniteStreamingPageUploader.h', 'NaniteStreamingPageUploader.cpp'].map(n => path.join(source, n))].map(audit),
  generated: ['NaniteStreamingPageUploader.h', 'NaniteStreamingPageUploader.cpp'].map(n => audit(path.join(output, n))),
}, null, 2));
console.log(output);
