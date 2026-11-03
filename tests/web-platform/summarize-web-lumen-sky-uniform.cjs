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
assert(shaders.pass && shaders.allPermutations && shaders.cases.length === 64 &&
  shaders.cases.every(item => item.pass && item.shaderType === 'FScreenProbeTraceMeshSDFsCS'));
assert(gpu.pass && gpu.modulesOnly && gpu.modules.length === 64 && gpu.sourceFiles.every(valid));
const cases = gpu.modules.map(item => {
  assert(!item.errors.length && item.sourceFiles.every(valid));
  const input = read(item.sourceFiles.find(file => path.basename(file.file) === 'input.json').file);
  const bindings = input.metadata.spirvBindings;
  const sky = bindings.find(binding => binding.name === 'View_DistantSkyLightLutBufferSRV');
  assert(sky && sky.storageUniformBytes === 16 && sky.readOnlyStorage &&
    sky.storageElementStride === 16 && sky.storageElementFormat === 1);
  const web = input.metadata.reflection.entry_points[0].bindings.find(binding =>
    binding.group === sky.group && binding.binding === sky.binding);
  assert(web?.resource_type === 'UniformBuffer' && web.size === 16);
  return {permutation: Number(input.shader.match(/\/(\d+):/)[1]),
    storageBuffers: bindings.filter(binding => binding.descriptorType === 7 && !binding.storageUniformBytes).length};
}).sort((a, b) => a.permutation - b.permutation);
const pipelineFiles = [8, 9, 10, 11].map(permutation =>
  path.join(path.dirname(moduleFile), `lumen-sky-uniform-perm${permutation}-gpu.json`));
for (const [index, file] of pipelineFiles.entries()) {
  const pipeline = read(file);
  assert(pipeline.pass && pipeline.sourceFiles.every(valid) && pipeline.pipelines.length === 1 &&
    !pipeline.pipelines[0].errors.length && pipeline.pipelines[0].shader.includes(`/${index + 8}:`));
  assert.equal(cases.find(item => item.permutation === index + 8)?.storageBuffers, 16);
}
assert(rhi.pass && !rhi.errors.length && rhi.pipelines === 11 &&
  rhi.cases.length === 10 && rhi.cases.every(item => item.pass && item.clearPass) &&
  rhi.volumeCases.every(item => item.pass) && rhi.bufferCases.every(item => item.pass));
assert(rhi.uniformCases.length === 1 && rhi.uniformCases[0].pass &&
  rhi.uniformCases[0].checkedValues === 8 && rhi.uniformCases[0].gpuWriteThenUniformRead);
const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
const build = read(buildFile);
assert(build.pass && build.wasmValidated && build.products.every(valid) && build.sourceFiles.every(valid));
const report = {
  date: new Date().toISOString(), pass: true, completeLumenScene: false, rendererOverrides: [],
  modules: 64, meshOnlyPipelines: [8, 9, 10, 11], cases,
  stillOverStorageBufferLimit: cases.filter(item => item.storageBuffers > 16),
  nativeRHI: {pipelines: rhi.pipelines, uniformCases: rhi.uniformCases},
  sourceReports: [shaderFile, moduleFile, rhiFile, ...pipelineFiles, buildFile].map(audit),
  sourceFiles: [__filename,
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Public/WebGPUShaderMetadata.h',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPULumenStorageProbe.h',
  ].map(file => audit(path.resolve(__dirname, file))),
  memoryBoundary: 'Source reuses the existing 16-byte GPU buffer with Uniform usage; no added allocation or copy pass. Driver memory and scene performance remain unmeasured.',
  boundary: 'WGSL modules, four mesh-only compute pipelines and fixed-fixture real RHI reads. Hair/heightfield/other offset combinations can still exceed limits; full scene pending.',
};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, modules: 64, pipelines: 4,
  stillOverLimit: report.stillOverStorageBufferLimit.length}));
