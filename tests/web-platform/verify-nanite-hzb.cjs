'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-hzb'),{audit}=require('./content-file-metadata.cjs');
fs.mkdirSync(dir,{recursive:true});
const helperFile=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteHZB.ush'),buildFile=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteHZB.usf');
let helper=fs.readFileSync(helperFile,'utf8').replace('#pragma once','');
const source=helper+`
[[vk::binding(0,0)]] Texture2D<float> WebHZBTexture;
struct FCase { float4 Center; float4 Extent; float4 R0; float4 R1; float4 R2; float4 R3; uint4 Rect; };
[[vk::binding(1,0)]] StructuredBuffer<FCase> Cases;
[[vk::binding(2,0)]] RWStructuredBuffer<uint> Results;
[numthreads(64,1,1)] void MainCS(uint3 I:SV_DispatchThreadID) {
    uint Count,Stride;Cases.GetDimensions(Count,Stride);if(I.x>=Count)return;
    FCase C=Cases[I.x];
    Results[I.x]=WebHZBOccludedBox(C.Center.xyz,C.Extent.xyz,WebHZBTexture,
        float4x4(C.R0,C.R1,C.R2,C.R3),C.Rect,uint2(256,128),8)?1:0;
}`;
const build=fs.readFileSync(buildFile,'utf8').replace('#include "../Common.ush"','')
 .replace('Texture2D<float> WebHZBSource;','[[vk::binding(0,0)]] Texture2D<float> WebHZBSource;')
 .replace('RWTexture2D<float> WebHZBTarget;','[[vk::binding(1,0)]] RWTexture2D<float> WebHZBTarget;')
 .replace('uint2 WebHZBTargetSize;\nuint4 WebHZBBuildRect;\nuint WebHZBReduce;',
 '[[vk::binding(2,0)]] cbuffer Config { uint4 WebHZBBuildRect; uint2 WebHZBTargetSize; uint WebHZBReduce; uint Pad; };');
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),products=[];
function compile(name,source,entry){const base=path.join(dir,name);fs.writeFileSync(base+'.hlsl',source);
 cp.execFileSync(dxc,['-T','cs_6_0','-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-Fo',base+'.spv',base+'.hlsl'],{windowsHide:true});
 cp.execFileSync(tint,['--format','wgsl','-o',base+'.wgsl',base+'.spv'],{windowsHide:true});
 for(const ext of ['.hlsl','.spv','.wgsl'])products.push(audit(base+ext));return fs.readFileSync(base+'.wgsl','utf8');}
const codes=[compile('cull',source,'MainCS'),compile('build',build,'BuildHZBCS')];
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],perspective=[1,0,0,0,0,1,0,0,0,0,0,1,0,0,.1,0];
let seed=0x326235;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
const cases=[];for(let i=0;i<12000;i++) {
 const ortho=i%2===0,z=ortho?rand()*1.3-.1:rand()*5+.08;
 cases.push({center:[(rand()*2.4-1.2)*(ortho?1:z),(rand()*2.4-1.2)*(ortho?1:z),z],
  extent:[.001+rand()*.09,.001+rand()*.09,.001+rand()*.05],matrix:ortho?identity:perspective,rect:i%5?[0,0,256,128]:[13,7,243,119]});
}
for(const z of [.8,.7999999,.8000001,.2,.99])cases.push({center:[0,0,z],extent:[.01,.01,0],matrix:identity,rect:[0,0,256,128]});
const input=Buffer.alloc(cases.length*112);cases.forEach((c,i)=>{[...c.center,0,...c.extent,0,...c.matrix].forEach((v,j)=>input.writeFloatLE(v,i*112+j*4));c.rect.forEach((v,j)=>input.writeUInt32LE(v,i*112+96+j*4));});
const depth=new Float32Array(256*128);for(let y=8;y<120;y++)for(let x=8;x<248;x++)depth[y*256+x]=.8;
// Clear holes, a partial-depth region, and the exterior must remain conservative.
for(let y=20;y<43;y++)for(let x=30;x<54;x++)depth[y*256+x]=0;
for(let y=70;y<105;y++)for(let x=170;x<207;x++)depth[y*256+x]=.3;
function cpu(c) {let min=[Infinity,Infinity],max=[-Infinity,-Infinity],nearest=0;
 for(let corner=0;corner<8;corner++) {const p=c.center.map((v,i)=>v+c.extent[i]*((corner>>i)&1?1:-1)).concat(1),q=[0,1,2,3].map(col=>p.reduce((v,k,row)=>v+k*c.matrix[row*4+col],0));
  if(q.some(v=>!Number.isFinite(v))||q[3]<=.00001||q[2]<0||q[2]>q[3])return false;
  const pixel=[c.rect[0]+(q[0]/q[3]*.5+.5)*(c.rect[2]-c.rect[0]),c.rect[1]+(-q[1]/q[3]*.5+.5)*(c.rect[3]-c.rect[1])];
  for(let j=0;j<2;j++){min[j]=Math.min(min[j],pixel[j]);max[j]=Math.max(max[j],pixel[j]);}nearest=Math.max(nearest,q[2]/q[3]);}
 min=min.map(v=>Math.floor(v)-1);max=max.map(v=>Math.ceil(v)+1);
 if(min.some((v,i)=>v<c.rect[i])||max.some((v,i)=>v>c.rect[i+2])||max.some((v,i)=>v<=min[i]))return false;
 // Brute force the original depth footprint, independently of pyramid levels.
 for(let y=min[1];y<max[1];y++)for(let x=min[0];x<max[0];x++)if(!(nearest+.000001<depth[y*256+x]))return false;
 return true;}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
const result=await tab.evaluate(async ({codes,input,depth,count})=>{
 const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
 try {
 const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:4,texture:{sampleType:'unfilterable-float'}},{binding:1,visibility:4,storageTexture:{access:'read-write',format:'r32float'}},{binding:2,visibility:4,buffer:{type:'uniform'}}]});
 const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code:codes[1]}),entryPoint:'BuildHZBCS'}});
 const texture=device.createTexture({size:[256,128],mipLevelCount:9,format:'r32float',usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
 const original=device.createTexture({size:[256,128],format:'r32float',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
 device.queue.writeTexture({texture:original},new Float32Array(depth),{bytesPerRow:1024},[256,128]);
 const enc=device.createCommandEncoder(),configs=[];
 for(let mip=0;mip<9;mip++){const w=Math.max(256>>mip,1),h=Math.max(128>>mip,1),config=device.createBuffer({size:32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM});configs.push(config);device.queue.writeBuffer(config,0,new Uint32Array([0,0,256,128,w,h,mip?1:0,0]));
  const pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout,entries:[{binding:0,resource:mip?texture.createView({baseMipLevel:mip-1,mipLevelCount:1}):original.createView()},{binding:1,resource:texture.createView({baseMipLevel:mip,mipLevelCount:1})},{binding:2,resource:{buffer:config}}]}));pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));pass.end();}
 const cullLayout=device.createBindGroupLayout({entries:[{binding:0,visibility:4,texture:{sampleType:'unfilterable-float'}},{binding:1,visibility:4,buffer:{type:'read-only-storage'}},{binding:2,visibility:4,buffer:{type:'storage'}}]});
 const cull=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[cullLayout]}),compute:{module:device.createShaderModule({code:codes[0]}),entryPoint:'MainCS'}});
 const inputs=device.createBuffer({size:input.length,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.STORAGE});device.queue.writeBuffer(inputs,0,new Uint8Array(input));
 const output=device.createBuffer({size:count*4,usage:GPUBufferUsage.COPY_SRC|GPUBufferUsage.STORAGE}),read=device.createBuffer({size:count*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
 const pass=enc.beginComputePass();pass.setPipeline(cull);pass.setBindGroup(0,device.createBindGroup({layout:cullLayout,entries:[{binding:0,resource:texture.createView()},{binding:1,resource:{buffer:inputs}},{binding:2,resource:{buffer:output}}]}));pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
 const mipReads=[];for(let mip=0;mip<9;mip++){const w=Math.max(256>>mip,1),h=Math.max(128>>mip,1),pitch=Math.ceil(w*4/256)*256;
 const buffer=device.createBuffer({size:pitch*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyTextureToBuffer({texture,mipLevel:mip},{buffer,bytesPerRow:pitch},[w,h]);mipReads.push({buffer,w,h,pitch});}
 enc.copyBufferToBuffer(output,0,read,0,count*4);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);
 const mips=[];for(const {buffer,w,h,pitch} of mipReads){await buffer.mapAsync(GPUMapMode.READ);const floats=new Float32Array(buffer.getMappedRange()),data=[];for(let y=0;y<h;y++)data.push(...floats.subarray(y*pitch/4,y*pitch/4+w));mips.push(data);buffer.unmap();}
 return {values,mips,errors,features:[...device.features]};
 }finally{device.destroy();}
},{codes,input:[...input],depth:[...depth],count:cases.length});
assert.deepEqual(result.errors,[]);let previous=[...depth],width=256,height=128;
 for(let mip=0;mip<9;mip++){if(mip){const next=[],nw=Math.max(width>>1,1),nh=Math.max(height>>1,1);for(let y=0;y<nh;y++)for(let x=0;x<nw;x++)next.push(Math.min(...[0,1,2,3].map(k=>previous[Math.min(y*2+(k>>1),height-1)*width+Math.min(x*2+(k&1),width-1)])));previous=next;width=nw;height=nh;}assert.deepEqual(result.mips[mip],previous,'Mip '+mip);}
 let rejected=0,expected=0;
cases.forEach((c,i)=>{const visible=cpu(c);expected+=Number(visible);if(result.values[i]){assert(visible,'False occlusion at '+i);rejected++;}});
assert(rejected>1000&&rejected<=expected);const report={pass:true,mips:9,cases:cases.length,rejected,referenceOccluded:expected,errors:result.errors,features:result.features,sources:[__filename,helperFile,buildFile].map(audit),tools:[dxc,tint].map(audit),products};
fs.writeFileSync(path.join(dir,'verified.json'),JSON.stringify(report,null,2));console.log({pass:true,cases:cases.length,rejected,expected});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
