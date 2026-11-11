'use strict';
// Exercise the actual follicle shader with the common declarations retained
// from the failed production compilation. Only resource binding is test-owned.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-curves/follicle');
const source=path.join(root,'reference-engine/Engine/Shaders/Private/HairStrands/HairStrandsFollicleMask.usf');
const failure=path.join(__dirname,'results/nanite-curves/failure-follicle-infinity/conversion');
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe');
fs.mkdirSync(output,{recursive:true});
const original=fs.readFileSync(path.join(failure,'preprocessed.hlsl'),'utf8');
assert.equal(original.split('float2 OutputResolution;').length,2);
const common=original.slice(0,original.indexOf('float2 OutputResolution;'));
let body=fs.readFileSync(source,'utf8').split('#endif // SHADER_FOLLICLE_MASK')[0]+'\n#endif\n';
body=body.replace(/^#include .+$/gm,'').replace(/\bBuffer</g,'StructuredBuffer<');
const uniforms=/float2 OutputResolution;\s*uint MaxRootCount;\s*uint MaxUniqueTriangleIndex;\s*uint Channel;\s*uint KernelSizeInPixels;/;
assert(uniforms.test(body));
body=body.replace(uniforms,'[[vk::binding(0,0)]] cbuffer Parameters { float2 OutputResolution; uint MaxRootCount; uint MaxUniqueTriangleIndex; uint Channel; uint KernelSizeInPixels; };');
for(const [name,binding] of [['UniqueTrianglePositionBuffer',1],['RootToUniqueTriangleIndexBuffer',2],['RootBarycentricBuffer',3],['RootUVsBuffer',4]]){
 const declaration=new RegExp('StructuredBuffer<([^>]+)>\\s*'+name+';');assert(declaration.test(body));
 body=body.replace(declaration,`[[vk::binding(${binding},0)]] StructuredBuffer<$1> ${name};`);
}
const old=cp.spawnSync(tint,['--format','wgsl','-o',path.join(output,'old.wgsl'),path.join(failure,'input.spv')],{windowsHide:true,encoding:'utf8'});
fs.writeFileSync(path.join(output,'old-tint.log'),(old.stdout||'')+(old.stderr||''));
assert.notEqual(old.status,0,'original production SPIR-V must reproduce the failure');
assert.match((old.stdout||'')+(old.stderr||''),/isfinite/);
const variants=[];
for(const uv of [0,1]){
 const stages=[];
 for(const [entry,profile] of [['MainVS','vs_6_0'],['MainPS','ps_6_0']]){
  const base=path.join(output,`uv${uv}-${entry}`),hlsl=base+'.hlsl',spv=base+'.spv',wgsl=base+'.wgsl';
  fs.writeFileSync(hlsl,`#define SHADER_FOLLICLE_MASK 1\n#define COMPILER_WEBGPU 1\n#define PERMUTATION_UV_TYPE ${uv}\n`+common+body);
  const args=['-T',profile,'-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-fvk-use-dx-layout','-Fo',spv,hlsl];
  cp.execFileSync(dxc,args,{windowsHide:true,stdio:'pipe'});
  cp.execFileSync(tint,['--format','wgsl','-o',wgsl,spv],{windowsHide:true,stdio:'pipe'});
  const code=fs.readFileSync(wgsl,'utf8'),stage=entry==='MainVS'?'vertex':'fragment';
  stages.push({stage,code,entry:new RegExp('@'+stage+'[\\s\\S]*?fn (\\w+)\\(').exec(code)[1],files:[hlsl,spv,wgsl].map(audit)});
 }
 variants.push({uv,stages});
}
if(process.argv.includes('--compile-only')){console.log({compiled:true,originalFailure:true,permutations:2,stages:4});process.exit(0);}
(async()=>{
 const {chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/');const results=[];
  for(const variant of variants)for(const channel of [0,1,2,3])for(const reject of variant.uv===0?[false,true]:[false]){
   const actual=await page.evaluate(async({stages,uv,channel,reject})=>{
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
    try{
     const parameters=new ArrayBuffer(32),view=new DataView(parameters);
     view.setFloat32(0,64,true);view.setFloat32(4,64,true);view.setUint32(8,3,true);view.setUint32(12,2,true);view.setUint32(16,channel,true);view.setUint32(20,6,true);
     const uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,parameters);
     const index=device.createBuffer({size:12,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(index,0,new Uint32Array(reject?[3,4,0xffffffff]:[0,1,2]));
     const roots=device.createBuffer({size:24,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(roots,0,new Float32Array([.25,.25,.5,.5,.75,.75]));
     const layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
      {binding:4,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}}]});
     const vertex=stages.find(s=>s.stage==='vertex'),fragment=stages.find(s=>s.stage==='fragment');
     const pipeline=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),
      vertex:{module:device.createShaderModule({code:vertex.code}),entryPoint:vertex.entry},
      fragment:{module:device.createShaderModule({code:fragment.code}),entryPoint:fragment.entry,targets:[{format:'rgba32float'}]},primitive:{topology:'triangle-list',cullMode:'none'}});
     const group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:uniform}},{binding:2,resource:{buffer:index}},{binding:4,resource:{buffer:roots}}]});
     const texture=device.createTexture({size:[64,64],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
     const read=device.createBuffer({size:64*64*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
     const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
     pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(9);pass.end();
     encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:64*16},[64,64]);device.queue.submit([encoder.finish()]);
     await read.mapAsync(GPUMapMode.READ);const pixels=[...new Float32Array(read.getMappedRange())];read.unmap();
     const error=await device.popErrorScope();if(error)errors.push(error.message);return {pixels,errors};
    }finally{device.destroy();}
   },{...variant,channel,reject});
   assert.deepEqual(actual.errors,[]);let coverage=0,maxError=0;
   const roots=variant.uv===1?[[.25,.25],[.5,.5],[.75,.75]]:[[0,0]];
   for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const value=reject?0:Math.max(0,...roots.map(([u,v])=>1-Math.hypot((x+.5)-u*64,(64-y-.5)-v*64)/6));
    const pixel=actual.pixels.slice((y*64+x)*4,(y*64+x+1)*4);
    if(pixel.some(v=>v!==0))coverage++;
    for(let c=0;c<4;c++)maxError=Math.max(maxError,Math.abs(pixel[c]-(c===channel?value:0)));
   }
   assert(maxError<2e-6,`UV ${variant.uv}, channel ${channel}, rejected ${reject}: ${maxError}`);
   assert(reject?coverage===0:coverage>0);
   const file=path.join(output,`uv${variant.uv}-channel${channel}-${reject?'rejected':'valid'}.json`);
   fs.writeFileSync(file,JSON.stringify(actual)+'\n');results.push({uv:variant.uv,channel,reject,coverage,maxError,readback:audit(file)});
  }
  const report={pass:true,source:audit(__filename),shader:audit(source),originalInput:audit(path.join(failure,'input.spv')),originalFailure:audit(path.join(output,'old-tint.log')),
   commonDeclarations:audit(path.join(failure,'preprocessed.hlsl')),variants:variants.map(v=>({uv:v.uv,stages:v.stages.map(s=>({stage:s.stage,files:s.files}))})),results,
   boundary:'Actual follicle VS/PS bodies and retained production common declarations, explicit test resource layout. Both UV permutations and all four channels checked against analytic radial masks. Full UE global-shader Cook remains a separate requirement.'};
  fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,cases:results.length,maxError:Math.max(...results.map(r=>r.maxError))});
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
