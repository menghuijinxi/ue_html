'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const {initializeProjectOutput,assertProjectOutputTree}=require('./project-output.cjs');
initializeProjectOutput();
const output=assertProjectOutputTree(path.join(__dirname,'results/nanite-distance-field-quantization'));fs.mkdirSync(output,{recursive:true});
(async()=>{const profile=assertProjectOutputTree(path.join(__dirname,'build/browser-profiles/atlas-quantization'));
const browser=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,
  downloadsPath:path.join(profile,'downloads'),args:['--disk-cache-dir='+path.join(profile,'http-cache'),'--crash-dumps-dir='+path.join(profile,'crashes')]});try{
  const page=browser.pages()[0];
  await page.route('**/atlas-quantization',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
  await page.goto('http://127.0.0.1:8765/atlas-quantization');
  const compareFormat=async tier2=>{
    const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter required');
    const device=await adapter.requestDevice({requiredFeatures:[tier2?'texture-formats-tier2':'texture-formats-tier1']});const errors=[];
    const format=device.features.has('texture-formats-tier2')?'r8unorm':'r32float';
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    try{
      const size=4096,bytes=size*4;
      const native=device.createTexture({size:[64,64,1],dimension:'3d',format:'r8unorm',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
      const web=device.createTexture({size:[64,64,1],dimension:'3d',format,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
      const values=device.createBuffer({size:bytes*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size:bytes*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      const stages=[{
        code:`@group(0) @binding(0) var native:texture_storage_3d<r8unorm,write>;
          @group(0) @binding(1) var web:texture_storage_3d<${format},write>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
            let index=id.x+id.y*64u;let value=select(f32(index)/4095*1.5-.25,f32(index)/255,index<256u);let p=vec3i(id);
            textureStore(native,p,vec4f(value));textureStore(web,p,vec4f(round(clamp(value,0,1)*255)/255));}`,
        resources:[native.createView(),web.createView()]
      },{
        code:`@group(0) @binding(0) var native:texture_3d<f32>;
          @group(0) @binding(1) var web:texture_storage_3d<${format},read_write>;
          @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
            let p=vec3i(id);let n=textureLoad(native,p,0).x;let w=textureLoad(web,p).x;
            result[id.x+id.y*64u]=vec4f(n,w,0,0);textureStore(web,p,vec4f(round(clamp(w+.123,0,1)*255)/255));}`,
        resources:[native.createView(),web.createView(),{buffer:values}]
      },{
        code:`@group(0) @binding(0) var web:texture_3d<f32>;
          @group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
          @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
            result[id.x+id.y*64u].z=textureLoad(web,vec3i(id),0).x;}`,
        resources:[web.createView(),{buffer:values}]
      }];
      device.pushErrorScope('validation');
      const encoder=device.createCommandEncoder();
      for(const stage of stages){
        const module=device.createShaderModule({code:stage.code});
        const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:stage.resources.map((resource,binding)=>({resource,binding}))});
        const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1,64);pass.end();
      }
      encoder.copyBufferToBuffer(values,0,read,0,bytes*4);device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange());let maxError=0,mismatches=0,levelMismatches=0,maxUpdateError=0;const differences=[];
      for(let i=0;i<size;i++){const error=Math.abs(data[i*4]-data[i*4+1]);maxError=Math.max(maxError,error);maxUpdateError=Math.max(maxUpdateError,Math.abs(data[i*4+2]-Math.round(Math.min(1,data[i*4+1]+.123)*255)/255));if(error>1e-7){mismatches++;if(i<256)levelMismatches++;if(differences.length<12)differences.push({i,native:data[i*4],web:data[i*4+1]});}}
      read.unmap();const scoped=await device.popErrorScope();if(scoped)throw Error(scoped.message);
      return {format:web.format,samples:size,maxError,mismatches,levelMismatches,maxUpdateError,differences,errors};
    }finally{device.destroy();}
  };
  const results=[];
  for(const tier2 of [false,true]) {
    const result=await page.evaluate(compareFormat,tier2);
    assert.equal(result.format,tier2?'r8unorm':'r32float');
    assert.deepEqual(result.errors,[]);assert.equal(result.levelMismatches,0,JSON.stringify(result));
    assert(result.maxError<=1/255+1e-7,JSON.stringify(result));assert(result.maxUpdateError<1e-6,JSON.stringify(result));
    results.push(result);
  }
  const root=path.resolve(__dirname,'../..');
  const report={pass:true,date:new Date().toISOString(),...results[0],formats:results,
    boundary:'All 256 representable R8 levels are preserved. Arbitrary inputs may differ from hardware UNORM conversion by one level; R32F uses four times the page-atlas storage. In-place update/readback is checked independently.',
    source:audit(__filename),sources:[
    'Engine/Source/Runtime/Renderer/Private/GlobalDistanceField.cpp',
    'Engine/Shaders/Private/DistanceField/GlobalDistanceFieldCompositeObjects.usf',
    'Engine/Shaders/Private/DistanceField/GlobalDistanceFieldHeightfields.usf'].map(p=>audit(path.join(root,'reference-engine',p)))};
  fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
