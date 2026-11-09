'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'results/nanite-storage-compat-shaders');
const inputs=fs.readdirSync(path.join(output,'conversion')).flatMap(d=>{
  const dir=path.join(output,'conversion',d),file=path.join(dir,'input.json'),wgsl=path.join(dir,'output.wgsl');
  if(!fs.existsSync(file)||!fs.existsSync(wgsl))return [];
  const j=JSON.parse(fs.readFileSync(file));
  return [{name:j.shader,metadata:j.metadata,source:fs.readFileSync(wgsl,'utf8'),inputs:[audit(file),audit(wgsl)]}];
});
assert.equal(inputs.length,70);
for(const i of inputs){
  const b=i.metadata.spirvBindings.find(b=>b.name==='RWPageAtlasTexture');
  if(b)assert.equal(b.storageImageFormat,3);
  if(i.source.includes('textureGather('))assert(!/textureGather\([^\n]*SceneDepthTexture, VulkanGlobalBilinearClampedSampler/.test(i.source));
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
  const results=await page.evaluate(async inputs=>{
    const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter required');
    const device=await adapter.requestDevice({requiredFeatures:['subgroups','texture-formats-tier1','texture-formats-tier2'],
      requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,
        maxStorageTexturesPerShaderStage:adapter.limits.maxStorageTexturesPerShaderStage}});
    try{
      const formats={1:'rgba32float',2:'rgba16float',3:'r32float',4:'rgba8unorm',6:'rg32float',8:'r11g11b10ufloat',15:'r8unorm',30:'rgba32uint',33:'r32uint'};
      const results=[];
      for(const input of inputs){
        device.pushErrorScope('validation');
        const groups=[];
        for(const b of input.metadata.spirvBindings){
          const entry={binding:b.binding,visibility:GPUShaderStage.COMPUTE};
          const dimension=b.textureDimension===2?'3d':b.textureDimension===3?(b.textureArrayed?'cube-array':'cube'):(b.textureArrayed?'2d-array':'2d');
          if(b.descriptorType===0)entry.sampler={type:b.samplerComparison?'comparison':b.name.includes('Point')?'non-filtering':'filtering'};
          else if(b.descriptorType===2)entry.texture={viewDimension:dimension,multisampled:b.textureMultisampled,
            sampleType:b.textureSampleType==='uint'?'uint':b.textureSampleType==='sint'?'sint':b.name.includes('SceneDepth')||b.sampledTextureLoadOnly?'unfilterable-float':'float'};
          else if(b.descriptorType===3){if(!formats[b.storageImageFormat])throw Error('Unmapped storage format '+b.storageImageFormat);
            entry.storageTexture={viewDimension:dimension,format:formats[b.storageImageFormat],access:{write:'write-only',read:'read-only',read_write:'read-write'}[b.storageTextureAccess]};}
          else if(b.descriptorType===6)entry.buffer={type:'uniform',minBindingSize:b.paddedSize};
          else if(b.descriptorType===7)entry.buffer={type:b.readOnlyStorage?'read-only-storage':'storage'};
          else throw Error('Unmapped descriptor '+b.descriptorType);
          (groups[b.group]||=[]).push(entry);
        }
        const layout=device.createPipelineLayout({bindGroupLayouts:groups.map(entries=>device.createBindGroupLayout({entries}))});
        const module=device.createShaderModule({code:input.source});
        await device.createComputePipelineAsync({layout,compute:{module,entryPoint:input.metadata.webEntry}});
        const error=await device.popErrorScope();if(error)throw Error(input.name+' '+error.message);
        results.push({shader:input.name,pass:true});
      }
      return results;
    }finally{device.destroy();}
  },inputs.map(({inputs,...item})=>item));
  const report={pass:true,date:new Date().toISOString(),source:audit(__filename),inputs:inputs.flatMap(i=>i.inputs),cases:results,
    boundary:'64 subsurface setup, 2 heightfield and 4 non-coverage object-composite permutations. The exporter also attempted unsupported volume-atomic coverage permutation 4; that failed and is not counted. Full Cook/startup validates the platform-selected set.'};
  fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,pipelines:results.length}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
