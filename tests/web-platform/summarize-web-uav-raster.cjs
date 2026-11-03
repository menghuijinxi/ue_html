'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert([6, 7, 8].includes(process.argv.length), 'Expected shader report, module report, RHI report, output, optional cooked modules and R16 pipelines');
const [shaderFile, moduleFile, rhiFile, output, volumeModuleFile, r16PipelineFile] =
  process.argv.slice(2).map(file => path.resolve(file));
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
let volumeMarks;
if (volumeModuleFile) {
  const modules = read(volumeModuleFile);
  assert(modules.pass && modules.modulesOnly && modules.sourceFiles.every(valid));
  const marks = modules.modules.filter(item => item.name === 'FLumenTranslucencyRadianceCacheMarkPS');
  assert(marks.length > 0);
  let markBindings = 0;
  for (const item of marks) {
    assert(!item.errors.length && item.sourceFiles.every(valid));
    const input = read(item.sourceFiles.find(file => path.basename(file.file) === 'input.json').file);
    for (const binding of input.metadata.spirvBindings.filter(item => item.descriptorType === 3)) {
      if (/_(Inner|Outer)VolumeMarkTexture$/.test(binding.name)) {
        assert(binding.storageImageFormat === 39 && binding.storageTextureAccess === 'write' &&
          binding.textureDimension === 2 && binding.textureSampleType === 'uint');
        ++markBindings;
      } else if (binding.name.endsWith('_RWRadianceProbeIndirectionTexture'))
        assert.equal(binding.storageImageFormat, 33, 'Radiance indirection must remain R32_UINT');
    }
  }
  assert.equal(markBindings, marks.length * 2);
  assert(rhi.rasterCases.every(item => item.pixelVolumeR8UInt));
  volumeMarks = {materialShaders: marks.length, markBindings, format: 'r8uint', pixelVolumeReadback: true};
}
let uint16Textures;
if (r16PipelineFile) {
  const pipelines = read(r16PipelineFile);
  assert(pipelines.pass && pipelines.modulesOnly && pipelines.modules.length === 22 &&
    pipelines.pipelines.length === 22 && pipelines.sourceFiles.every(valid));
  assert(pipelines.pipelines.every(item => !item.errors.length));
  const bindings = {};
  for (const item of pipelines.modules) {
    assert(!item.errors.length && item.sourceFiles.every(valid));
    const input = read(item.sourceFiles.find(file => path.basename(file.file) === 'input.json').file);
    for (const binding of input.metadata.spirvBindings.filter(item =>
      ['RWDepthProbeAtlasTexture', 'RWStructuredImportanceSampledRayInfosForTracing', 'RWRayTraceDistance'].includes(item.name))) {
      assert(binding.storageImageFormat === 38 && binding.storageTextureAccess === 'write' &&
        binding.textureSampleType === 'uint');
      bindings[binding.name] = (bindings[binding.name] || 0) + 1;
    }
  }
  assert.deepEqual(bindings, {RWDepthProbeAtlasTexture: 12,
    RWStructuredImportanceSampledRayInfosForTracing: 6, RWRayTraceDistance: 4});
  uint16Textures = {modules: 22, pipelines: 22, bindings, format: 'r16uint'};
}
const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
const build = read(buildFile);
assert(build.pass && build.wasmValidated && build.products.every(valid) && build.sourceFiles.every(valid));
const report = {
  date: new Date().toISOString(), pass: true, completeLumenScene: false, rendererOverrides: [],
  copyShaderCases: cases, rasterCases: rhi.rasterCases, volumeMarks, uint16Textures,
  depthAtlasCases: rhi.depthAtlasCases,
  sourceReports: [shaderFile, moduleFile, rhiFile, buildFile, volumeModuleFile, r16PipelineFile].filter(Boolean).map(audit),
  sourceFiles: [__filename, '../../reference-engine/Engine/Shaders/Private/Lumen/LumenSceneLighting.usf',
    'web-lumen-shader-overrides.cjs',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUUAVRasterProbe.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPULumenStorageProbe.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp',
    '../../reference-engine/Engine/Shaders/Private/Lumen/LumenRadianceCache.usf',
    '../../reference-engine/Engine/Shaders/Private/Lumen/LumenScreenProbeImportanceSampling.usf',
    '../../reference-engine/Engine/Shaders/Private/Lumen/LumenReflections.usf',
  ].map(file => audit(path.resolve(__dirname, file))),
  memoryBoundary: 'One reusable single-sample R8 extent attachment grows to maximum UAV-only raster extent. ' +
    'Logical storage is width * height bytes; no image copy, color writes disabled, contents discarded. ' +
    'Radiosity frame-count texture remains R8 and volume marks remain R8_UINT, including placeholders. ' +
    'Driver allocation, pass cost and full scene performance remain unmeasured.',
  boundary: 'Real RHI indexed indirect raster atomics, R8 pixel storage writes and readback at three extents; ' +
    'four real UE pixel shader modules. Full villa browser acceptance remains separate.',
};
if (rhi.depthAtlasCases) {
  assert.equal(rhi.depthAtlasCases.length, 8);
  for (const name of ['SourceDepthAtlas', 'DepthAtlas', 'LumenCardScene_DepthAtlas',
    'LoadOnlyTextureWithoutDepthName']) {
    const samples = rhi.depthAtlasCases.filter(item => item.binding === name);
    assert.deepEqual(samples.map(item => item.format), [11, 4]);
    assert(samples.every(item => item.pass && item.checkedPixels === 16));
  }
}
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, modules: cases.length, rasterCases: rhi.rasterCases.length}));
