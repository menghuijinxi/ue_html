'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const read = file => JSON.parse(fs.readFileSync(path.join(__dirname, 'results', file), 'utf8').replace(/^\uFEFF/, ''));
const browser = read('nanite-asset/browser-results.json');
const converter = read('nanite-converter/results.json');
const visibility = read('nanite-ue-visibility.json');
const rhi = read('nanite-ue-rhi/nanite-rhi-results.json');
const worker = read('worker-module-build.json');
const overlay = read('web-cook-shader-sources.json');
for (const result of [browser, converter, visibility, rhi, overlay]) assert.equal(result.pass, true);
for (const result of [browser, converter, visibility])
  for (const source of result.sources)
    assert.equal(audit(source.file).sha256, source.sha256, `Stale result: ${source.file}`);
assert.equal(audit(worker.dll).sha256, worker.dllSha256);
assert.equal(worker.originalWorkerUnmodified, true);
for (const channel of browser.browsers) {
  assert.equal(channel.pass, true);
  assert.equal(channel.cases.length, 2);
  assert.equal(channel.adapter.isFallbackAdapter, false);
}
const sourceFiles = [
  'UE58_WEBGPU_NANITE_IMPLEMENTATION.md',
  'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteAssetProbe.cpp',
  'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
  'tests/ue-shader-host/Source/UEShaderHost/UEShaderHost.Build.cs',
  'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp',
  'tests/web-platform/probe-nanite-asset.ps1', 'tests/web-platform/build-tint-nanite.ps1',
  'tests/web-platform/web-nanite-shader-overrides.cjs',
  'tests/web-platform/collect-nanite-asset-evidence.cjs',
  'tests/web-platform/platform-extension/Config/DataDrivenPlatformInfo.ini',
];
const report = {date: new Date().toISOString(), pass: true,
  referenceCommit: cp.execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'],
    {encoding: 'utf8'}).trim(),
  scope: browser.boundary, hostProcessorAffinity: 3, asset: browser.asset, browsers: browser.browsers,
  converter: {cases: converter.cases, sources: converter.sources},
  regression: {browsers: visibility.browsers.map(b => ({channel: b.channel, version: b.version,
    pass: b.pass, cases: b.cases.length})), rhi: rhi.modes},
  worker: {dll: worker.dll, dllSha256: worker.dllSha256,
    originalWorkerUnmodified: true, boundary: worker.limitation},
  sources: [...sourceFiles.map(file => audit(path.join(root, file))), ...browser.sources],
  installedShaderInputs: overlay.installedInputs.filter(file =>
    /NaniteTranscode|NaniteWritePixel|VulkanCommon/.test(file.file)),
  screenshots: ['chrome-desktop', 'chrome-mobile', 'msedge-desktop', 'msedge-mobile']
    .map(name => audit(path.join(__dirname, 'results/nanite-asset', `${name}.png`))),
  limitations: [
    'Normal Web Cook still strips Nanite. Global Nanite, uint64 image atomics and Wave DDPI remain disabled.',
    'Geometry-only validation: normals/UV/materials, hierarchy culling, Nanite rasterizers and streaming are not yet integrated.',
    '32-thread transcode requires adapter subgroupMinSize >= 32; only NVIDIA Ampere was tested.',
    'Desktop and narrow viewport screenshots use a diagnostic draw of GPU-decoded triangles, not UE Lit shading or mobile hardware.',
    'No full scene performance measurement or packaged Template_Default acceptance.',
  ],
};
const target = path.join(__dirname, 'evidence/nanite-asset-20261106.json');
fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, target, browsers: report.browsers.map(b => b.channel)}));
