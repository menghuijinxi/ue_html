'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
assert.equal(process.argv.length, 7, 'Expected probe directory, GPU report, RHI report, output and optional cook conversion directory (- to omit)');
const [directory, gpuFile, rhiFile, output, cookedDirectory] = process.argv.slice(2).map(value =>
  value === '-' ? value : path.resolve(value));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => audit(item.file).sha256 === item.sha256;
const probeFile = path.join(directory, 'probe-results.json');
const probe = read(probeFile), gpu = read(gpuFile), rhi = read(rhiFile);
assert(probe.pass && probe.shaders.pass && probe.policies.length === 8 &&
  probe.policies.every(item => item.pass));
assert(gpu.pass && gpu.modules.length === 161 && gpu.pipelines.length === 145 &&
  gpu.execution.length === 6 && gpu.sourceFiles.every(valid));
assert(gpu.modules.every(item => !item.errors.length && item.sourceFiles.every(valid)));
assert(gpu.pipelines.every(item => !item.errors.length));
assert(rhi.pass && !rhi.errors.length && rhi.depthAtlasCases.length === 8 &&
  rhi.depthAtlasCases.every(item => item.pass && item.checkedPixels === 16));
const checkJobs = source => {
  const sources = [], frontLayer = [];
  let loadOnly = 0, filtered = 0;
  for (const name of fs.readdirSync(source).sort()) {
    const inputFile = path.join(source, name, 'input.json');
    const wgslFile = path.join(source, name, 'output.wgsl');
    if (!fs.existsSync(inputFile) || !fs.existsSync(wgslFile)) continue;
    const input = read(inputFile), code = fs.readFileSync(wgslFile, 'utf8');
    let checked = false;
    for (const binding of input.metadata.spirvBindings) {
      if (binding.descriptorType !== 2) continue;
      const escaped = binding.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const samples = new RegExp(`texture(?:Sample\\w*|Gather\\w*)\\(\\s*${escaped}\\b`).test(code);
      if (binding.sampledTextureLoadOnly) {
        assert(new RegExp(`textureLoad\\(\\s*${escaped}\\b`).test(code) && !samples,
          `${input.shader}/${binding.name}: load-only metadata disagrees with emitted WGSL`);
        ++loadOnly;
        checked = true;
      } else if (samples) {
        ++filtered;
        checked = true;
      }
      if (/FrontLayerTranslucency/.test(binding.name))
        frontLayer.push({shader: input.shader, name: binding.name, loadOnly: !!binding.sampledTextureLoadOnly});
    }
    if (checked) sources.push(audit(inputFile), audit(wgslFile));
  }
  return {loadOnly, filtered, frontLayer, sources};
};
const shaderAccess = checkJobs(path.join(directory, 'ShaderConversion'));
assert(shaderAccess.loadOnly > 0 && shaderAccess.filtered > 0);
const cookedAccess = cookedDirectory === '-' ? undefined : checkJobs(cookedDirectory);
if (cookedAccess) assert(cookedAccess.loadOnly > 0 && cookedAccess.filtered > 0 &&
  cookedAccess.frontLayer.some(item => item.loadOnly));
if (cookedAccess) {
  cookedAccess.sourceDirectory = cookedDirectory;
  cookedAccess.sourceFileCount = cookedAccess.sources.length;
  cookedAccess.sourceManifestSha256 = crypto.createHash('sha256')
    .update(JSON.stringify(cookedAccess.sources)).digest('hex');
  delete cookedAccess.sources;
}
const report = {date: new Date().toISOString(), pass: true, completeLumenScene: false,
  rendererOverrides: [], modules: gpu.modules.length, pipelines: gpu.pipelines.length,
  executionCases: gpu.execution.length, policies: probe.policies.length,
  depthAtlasCases: rhi.depthAtlasCases, shaderAccess, cookedAccess,
  sourceReports: [probeFile, gpuFile, rhiFile].map(audit),
  sourceFiles: [__filename, '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp'].map(file =>
    audit(path.resolve(__dirname, file))),
  boundary: 'Proven textureLoad-only metadata and real RHI sampling readback; filtered WGSL uses remain unchanged. ' +
    'No texture allocation or image copy added. Full villa visual, performance and peak memory acceptance remain separate.'};
fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass: true, output, loadOnly: shaderAccess.loadOnly, filtered: shaderAccess.filtered,
  cookedFrontLayer: cookedAccess?.frontLayer.length}));
