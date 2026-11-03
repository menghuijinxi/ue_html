'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert.equal(process.argv.length, 6, 'Expected shader report, module report, RHI report and output');
const [shaderFile, moduleFile, rhiFile, output] = process.argv.slice(2).map(file => path.resolve(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => audit(item.file).sha256 === item.sha256;
const shaders = read(shaderFile), gpu = read(moduleFile), rhi = read(rhiFile);
assert(shaders.pass && shaders.allPermutations && shaders.cases.length === 4 &&
  shaders.cases.every(item => item.pass && item.shaderType === 'FCopyCardCaptureLightingToAtlasPS'));
assert(gpu.pass && gpu.modulesOnly && gpu.modules.length === 4 && gpu.sourceFiles.every(valid));
const cases = gpu.modules.map(item => {
  assert(!item.errors.length && item.sourceFiles.every(valid));
  const input = read(item.sourceFiles.find(file => path.basename(file.file) === 'input.json').file);
  const permutation = Number(input.shader.match(/\/(\d+):/)[1]);
  const binding = input.metadata.spirvBindings.find(item => item.name === 'RWRadiosityNumFramesAccumulatedAtlas');
  if (permutation & 1)
    assert(binding?.storageImageFormat === 15 && binding.storageTextureAccess === 'write' &&
      binding.textureSampleType === 'float' && !binding.runtimeStorageFormat);
  else assert(!binding);
  return {permutation, radiosityR8Write: !!binding};
}).sort((a, b) => a.permutation - b.permutation);
assert(rhi.pass && !rhi.errors.length && rhi.pipelines === 11 &&
  rhi.cases.length === 10 && rhi.cases.every(item => item.pass && item.clearPass) &&
  rhi.volumeCases.every(item => item.pass) && rhi.bufferCases.every(item => item.pass) &&
  rhi.uniformCases.every(item => item.pass));
assert.deepEqual(rhi.rasterCases.map(item => [item.width, item.height, item.extentAttachmentBytes]),
  [[9, 7, 63], [13, 11, 143], [5, 3, 143]]);
assert(rhi.rasterCases.every(item => item.pass && item.pixelAtomicsAndR8Storage));
const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
const build = read(buildFile);
assert(build.pass && build.wasmValidated && build.products.every(valid) && build.sourceFiles.every(valid));
const report = {
  date: new Date().toISOString(), pass: true, completeLumenScene: false, rendererOverrides: [],
  copyShaderCases: cases, rasterCases: rhi.rasterCases,
  sourceReports: [shaderFile, moduleFile, rhiFile, buildFile].map(audit),
  sourceFiles: [__filename, '../../reference-engine/Engine/Shaders/Private/Lumen/LumenSceneLighting.usf',
    'web-lumen-shader-overrides.cjs',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUUAVRasterProbe.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPULumenStorageProbe.h',
  ].map(file => audit(path.resolve(__dirname, file))),
  memoryBoundary: 'One reusable single-sample R8 extent attachment grows to maximum UAV-only raster extent. ' +
    'Logical storage is width * height bytes; no image copy, color writes disabled, contents discarded. ' +
    'Radiosity frame-count texture remains R8. Driver allocation, pass cost and full scene performance remain unmeasured.',
  boundary: 'Real RHI indexed indirect raster atomics, R8 pixel storage writes and readback at three extents; ' +
    'four real UE pixel shader modules. Full villa browser acceptance remains separate.',
};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, modules: cases.length, rasterCases: rhi.rasterCases.length}));
