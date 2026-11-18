'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),Module=require('node:module'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('../../content-file-metadata.cjs');
const root=path.resolve(__dirname,'../../../..'),file=path.join(__dirname,'verify-decode.cjs');
const m=new Module(file,module);m.filename=file;m.paths=module.paths;
m._compile(fs.readFileSync(file,'utf8').split('(async()=>{')[0]+'\nmodule.exports={decode,read};',file);
const {decode,read}=m.exports,cases=[],inputs=[];
const scales=[[1,1,1],[.02,4,.3],[4,.02,.3],[.3,4,.02],[.8,1.3,.7]];
for(const fixtures of ['fixtures','groom-gpu'])for(const name of fs.readdirSync(path.join(__dirname,fixtures))){
 const dir=path.join(__dirname,fixtures,name),pageFile=path.join(dir,'gpu-pages.bin');if(!fs.existsSync(pageFile))continue;
 const input=read(path.join(dir,'gpu-inputs.json')),data=fs.readFileSync(pageFile);inputs.push(audit(pageFile));
 for(const page of input.pages)for(let c=0;c<page.clusters;c++){
  const bytes=data.subarray(page.gpuOffset),meta=decode(bytes,c,0),points=[];
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];let radius=0;
  for(let v=0;v<meta.vertices;v++){
   const p=decode(bytes,c,v);points.push(p);radius=Math.max(radius,p.radius);
   p.p.forEach((x,a)=>{min[a]=Math.min(min[a],x);max[a]=Math.max(max[a],x);});
  }
  // Include the known radius repair here, isolating the additional failure
  // from nonuniform scale rather than counting the old missing-radius bug.
  const center=min.map((x,a)=>(x+max[a])/2),extent=min.map((x,a)=>(max[a]-x)/2+radius);
  for(const scale of scales)for(const angle of [0,.71]){
   const cs=Math.cos(angle),sn=Math.sin(angle),rotation=[[cs,sn,0],[-sn,cs,0],[0,0,1]];
   const maximum=Math.max(...scale),minimum=Math.min(...scale),actual=[0,0,0];
   for(const point of points){
    const normal=[0,1,2].map(a=>rotation.reduce((n,row,j)=>n+row[a]*point.normal[j],0));
    for(let a=0;a<3;a++){
     const p=rotation.reduce((n,row,j)=>n+row[a]*scale[j]*(point.p[j]-center[j]),0);
     actual[a]=Math.max(actual[a],Math.abs(p)+point.radius*maximum*Math.sqrt(Math.max(0,1-normal[a]**2)));
    }
   }
   cases.push({name,page:page.page,cluster:c,scale,rotation,maximum,minimum,extent,actual,points:points.length});
  }
 }
}
const helper=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/WebNaniteCurveBounds.ush');
const body=fs.readFileSync(helper,'utf8').replace(/^#pragma once\r?\n/m,'').replace('float WebCurveBoundsScale;','static float WebCurveBoundsScale;');
const source=`
static bool UseGPU;
static float4 GPUScales;
bool WebHasGPUInstance(){return UseGPU;}
float4 WebInstanceVector(uint Index){return GPUScales;}
${body}
struct FCase{float4 Extent;float4 Scales;};
[[vk::binding(0,0)]] StructuredBuffer<FCase> Cases;
[[vk::binding(1,0)]] RWStructuredBuffer<float4> Output;
[numthreads(64,1,1)] void MainCS(uint3 ID:SV_DispatchThreadID){
 uint Count,Stride;Cases.GetDimensions(Count,Stride);if(ID.x>=Count)return;
 FCase C=Cases[ID.x];GPUScales=float4(1,C.Scales.x,C.Scales.y,1);
 WebCurveBoundsScale=C.Scales.y/C.Scales.x;
 UseGPU=false;Output[ID.x*3]=float4(WebNaniteCurveBoundsExtent(C.Extent.xyz),0);
 UseGPU=true;WebCurveBoundsScale=1;Output[ID.x*3+1]=float4(WebNaniteCurveBoundsExtent(C.Extent.xyz),0);
 WebCurveBoundsScale=0;Output[ID.x*3+2]=float4(WebNaniteCurveBoundsExtent(C.Extent.xyz),0);
}`;
const out=path.join(__dirname,'kernels');fs.mkdirSync(out,{recursive:true});
const hlsl=path.join(out,'curve-bounds.hlsl'),spv=path.join(out,'curve-bounds.spv'),wgsl=path.join(out,'curve-bounds.wgsl');fs.writeFileSync(hlsl,source);
cp.execFileSync(path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
cp.execFileSync(path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
const code=fs.readFileSync(wgsl,'utf8'),entry=/@compute[\s\S]*?fn (\w+)\(/.exec(code)?.[1];assert(entry);
const bytes=Buffer.alloc(cases.length*32);cases.forEach((c,i)=>[...c.extent,0,c.minimum,c.maximum,0,0].forEach((v,j)=>bytes.writeFloatLE(v,i*32+j*4)));
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const gpu=await tab.evaluate(async({code,entry,bytes,count})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try{
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
   const input=device.createBuffer({size:bytes.length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,new Uint8Array(bytes));
   const output=device.createBuffer({size:count*48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:count*48,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
   const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
   const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,bind);p.dispatchWorkgroups(Math.ceil(count/64));p.end();e.copyBufferToBuffer(output,0,read,0,read.size);device.queue.submit([e.finish()]);
   await read.mapAsync(GPUMapMode.READ);const values=[...new Float32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);return {values,errors};
  }finally{device.destroy();}
 },{code,entry,bytes:[...bytes],count:cases.length});
 assert.deepEqual(gpu.errors,[]);let oldFailures=0,maxOldOutside=0,checks=0;const examples=[];
 for(let i=0;i<cases.length;i++){
  const c=cases[i],v=gpu.values.slice(i*12,i*12+12);assert(v.every(Number.isFinite));
  for(let a=0;a<3;a++)assert.equal(v[a],v[a+4],'CPU-supplied and actual GPU scales must agree');
  for(let a=0;a<3;a++){
   assert.equal(v[a+8],Math.fround(c.extent[a]),'Non-curve bounds must be unchanged');
   const worldExtent=values=>c.rotation.reduce((n,row,j)=>n+Math.abs(row[a]*c.scale[j])*values[j],0);
   const oldOutside=c.actual[a]-worldExtent(c.extent);checks++;
   if(oldOutside>1e-4){oldFailures++;maxOldOutside=Math.max(maxOldOutside,oldOutside);if(examples.length<3)examples.push({name:c.name,page:c.page,cluster:c.cluster,scale:c.scale,axis:a,outside:oldOutside});}
   assert(c.actual[a]<=worldExtent(v)+1e-4,'Curve ribbon must remain inside transformed GPU bounds');
  }
 }
 assert(oldFailures>0,'The previous nonuniform transform must reproduce an actual failure');
 const report={pass:true,cases:cases.length,checks,oldFailures,maxOldOutside,examples,gpuErrors:gpu.errors,source:audit(__filename),inputs:[...inputs,...[helper,hlsl,spv,wgsl].map(audit)]};
 fs.writeFileSync(path.join(__dirname,'scaled-bounds.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,cases:cases.length,checks,oldFailures,maxOldOutside,gpuErrors:gpu.errors.length});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
