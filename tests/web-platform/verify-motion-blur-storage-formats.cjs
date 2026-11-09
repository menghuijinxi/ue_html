'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'results/nanite-motion-blur-shaders');
const conversion = process.argv[2] ? path.resolve(process.argv[2]) : path.join(output, 'conversion');
const compiled = fs.readdirSync(conversion).flatMap(name => {
  const input = path.join(conversion, name, 'input.json');
  if (!fs.existsSync(input)) return [];
  const result = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (result.shaderName !== 'FMotionBlurVelocityFlattenCS') return [];
  const file = path.join(conversion, name, 'output.wgsl');
  const source = fs.readFileSync(file, 'utf8');
  const binding = result.metadata.spirvBindings.find(b => b.name === 'OutVelocityFlatTexture');
  assert(binding.runtimeStorageFormat && binding.storageTextureAccess === 'write');
  assert.equal(source.slice(binding.storageFormatOffset, binding.storageFormatOffset + binding.storageFormatLength), 'rgba32float');
  return [{input:audit(input), wgsl:audit(file), source, binding, entry:result.metadata.webEntry}];
});
assert.equal(compiled.length, 2, 'Compile both real velocity-flatten permutations first');
const log = path.join(output, 'compiler.log');
const text = fs.readFileSync(log, 'utf8');
assert(!/Ensure condition failed|Assertion failed|Fatal error|has unbound parameters/.test(text));
for (const permutation of [0,1])
  assert(text.includes(`WEB_SHADER_SUPPLEMENT type=FMotionBlurVelocityFlattenCS permutation=${permutation}`));
const build = path.join(__dirname, 'build/motion-blur-storage-formats');
fs.mkdirSync(build, {recursive:true});
fs.writeFileSync(path.join(build, 'index.html'), '<!doctype html><title>Motion blur storage format validation</title>');
(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
    const cases = compiled.flatMap(item => ['rg11b10ufloat','rgba32float'].map(format => ({
      entry:item.entry, format,
      source:item.source.slice(0,item.binding.storageFormatOffset) + format +
        item.source.slice(item.binding.storageFormatOffset + item.binding.storageFormatLength)
    })));
    const results = await page.evaluate(async cases => {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
      const device = await adapter.requestDevice({requiredFeatures:['texture-formats-tier1']});
      try {
        const results = [];
        for (const item of cases) {
          device.pushErrorScope('validation');
          const module = device.createShaderModule({code:item.source});
          const diagnostics = await module.getCompilationInfo();
          const errors = diagnostics.messages.filter(m => m.type === 'error');
          if (errors.length) throw new Error(errors.map(e=>e.message).join('\n'));
          await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:item.entry}});
          const error = await device.popErrorScope();
          if (error) throw new Error(error.message);
          results.push({entry:item.entry,format:item.format,pass:true});
        }
        return results;
      } finally { device.destroy(); }
    }, cases);
    const report = {pass:true,cases:results,compiled:compiled.map(({source,...item})=>item),log:audit(log),
      archive:audit(path.join(output,'supplement-global-shaders.bin')),
      sources:[__filename,path.join(__dirname,'compile-web-motion-blur-shaders.ps1'),
        path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp'),
        path.join(root,'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteHierarchyProbe.cpp')].map(audit),
      compiler:audit(path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll')),
      boundary:'Validates both compiled UE permutations with both storage formats using real browser compute pipelines. Scene execution and pixels are verified by the separate Nanite browser regression.'};
    fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({pass:true,pipelines:results.length}));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
