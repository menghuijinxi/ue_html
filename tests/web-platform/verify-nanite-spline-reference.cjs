'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs'),reference=require('./nanite-spline-reference.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-spline/reference');fs.mkdirSync(output,{recursive:true});
// The retained compiler diagnostic includes the complete original preprocessed
// native spline functions. Its bounds initializer is unused in this position /
// normal probe; only the new ReferenceCS entry point is compiled and executed.
const input=path.join(__dirname,'results/nanite-spline/failure-infinite-bounds/conversion/input.json');
const nativeFile=path.join(path.dirname(input),'preprocessed.hlsl'),native=fs.readFileSync(nativeFile,'utf8');
assert(native.includes('FSplineMeshSlice SplineMeshCalcSlice('));
// The shader preprocessor removes entry-point-unused functions. Reinsert the
// native position/normal helpers, with the same full-float half aliases used by
// the exported Web material compilation.
const helpersFile='D:/UE_5.8/Engine/Shaders/Private/SplineMeshCommon.ush',helpersSource=fs.readFileSync(helpersFile,'utf8');
const helpers=helpersSource.slice(helpersSource.indexOf('float4x3 SplineMeshCalcSliceTransform('),helpersSource.indexOf('struct FSplineMeshDeformBoundsContext'))
  .replace(/\bhalf3x3\b/g,'float3x3').replace(/\bhalf3\b/g,'float3').replace(/\bhalf\b/g,'float');
assert(helpers.includes('float3 SplineMeshDeformLocalPos('));
const hlsl=path.join(output,'reference.hlsl'),spv=path.join(output,'reference.spv'),wgsl=path.join(output,'reference.wgsl');
fs.writeFileSync(hlsl,native+helpers+`
struct FReferenceCase { float4 P0; float4 P1; float4 P2; float4 P3; float4 P4; float4 P5; float4 P6; float4 Position; float4 Normal; };
[[vk::binding(40,0)]] StructuredBuffer<FReferenceCase> ReferenceCases;
[[vk::binding(41,0)]] RWStructuredBuffer<float4> ReferenceResults;
[numthreads(64,1,1)] void ReferenceCS(uint3 Id:SV_DispatchThreadID) {
 uint Count,Stride;ReferenceCases.GetDimensions(Count,Stride);if(Id.x>=Count)return;
 FReferenceCase C=ReferenceCases[Id.x];float4 Packed[7]={C.P0,C.P1,C.P2,C.P3,C.P4,C.P5,C.P6};
 FSplineMeshShaderParams P=UnpackSplineMeshParams(Packed);
 ReferenceResults[Id.x*2]=float4(SplineMeshDeformLocalPos(P,C.Position.xyz),1);
 ReferenceResults[Id.x*2+1]=float4(normalize(SplineMeshDeformLocalNormal(P,SplineMeshCalcSplineDistance(P,C.Position.xyz),C.Normal.xyz)),1);
}`);
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe');
cp.execFileSync(dxc,['-T','cs_6_6','-E','ReferenceCS','-HV','2021','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
cp.execFileSync(tint,['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
const code=fs.readFileSync(wgsl,'utf8'),entry=/@compute[\s\S]*?fn (\w+)\(/.exec(code)?.[1];assert(entry);
const toHalf=value=>{
  const word=new Uint32Array(new Float32Array([value]).buffer)[0],sign=(word>>>16)&32768,exp=((word>>>23)&255)-127+15,m=word&0x7fffff;
  assert(exp>0&&exp<31||value===0);return value===0?sign:sign|(exp<<10)|((m+4096)>>>13);
};
const pair=(a,b)=>(toHalf(a)|(toHalf(b)<<16))>>>0;
const snorm=value=>Math.floor((Math.max(-1,Math.min(1,value))*.5+.5)*65535);
const cases=[];
for(let axis=0;axis<3;axis++)for(let shape=0;shape<8;shape++)for(let sample=0;sample<129;sample++){
  const data=new ArrayBuffer(144),f=new Float32Array(data),u=new Uint32Array(data);
  const start=[0,0,0],end=[0,0,0],tangent=[0,0,0],oldTangent=[0,0,0];
  start[axis]=-100;end[axis]=100;tangent[axis]=oldTangent[axis]=200;
  if(shape){const bend=(axis+1)%3;end[bend]=35;tangent[bend]=100;oldTangent[bend]=-80;}
  f.set([...start,oldTangent[0],...end,oldTangent[1],...tangent,oldTangent[2]]);
  if(shape>=2)f.set([8,-6,-10,12],12);
  u[16]=shape>=2?pair(.25,-.35):0;u[17]=pair(shape===5?-1:1.25,.75);u[18]=pair(shape===5?-1:.75,1.25);u[19]=0xffffffff;
  f[20]=1/200;f[21]=.5;u[22]=pair(1,1);u[23]=0;
  const up=[0,0,0];up[(axis+2)%3]=1;
  u[24]=(snorm(up[0])|(snorm(up[1])<<16))>>>0;
  u[25]=(snorm(up[2])|(toHalf(1)<<16)|(shape===4?0x80000000:0))>>>0;
  const q=axis===0?[0,0,0,1]:axis===1?[.5,.5,.5,.5]:[-.5,-.5,-.5,.5];
  u[26]=(snorm(q[0])|(snorm(q[1])<<16))>>>0;u[27]=(snorm(q[2])|(snorm(q[3])<<16))>>>0;
  const position=[30*Math.sin(sample*.7),20*Math.cos(sample*.9),15*Math.sin(sample*.3)];position[axis]=-110+220*sample/128;
  f.set(position,28);f.set([.6,.8,0],32);
  cases.push({axis,shape,sample,words:[...u.slice(0,28)],position:[...f.slice(28,31)],normal:[...f.slice(32,35)],bytes:Buffer.from(data)});
}
const bytes=Buffer.concat(cases.map(c=>c.bytes)),report={pass:false,date:new Date().toISOString(),cases:cases.length,
 source:audit(__filename),sources:[require.resolve('./nanite-spline-reference.cjs'),nativeFile,helpersFile,input].map(audit),tools:[dxc,tint].map(audit),products:[hlsl,spv,wgsl].map(audit)};
(async()=>{let browser;try{
 browser=await chromium.launch({channel:'msedge',headless:true});const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const gpu=await tab.evaluate(async ({code,entry,bytes,count})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  try{device.pushErrorScope('validation');
   const data=device.createBuffer({size:bytes.length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(data,0,new Uint8Array(bytes));
   const out=device.createBuffer({size:count*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:count*32,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:40,resource:{buffer:data}},{binding:41,resource:{buffer:out}}]});
   const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
   encoder.copyBufferToBuffer(out,0,read,0,count*32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
   const values=[...new Float32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);return {values,errors};
  }finally{device.destroy();}
 },{code,entry,bytes:[...bytes],count:cases.length});
 assert.deepEqual(gpu.errors,[]);let maxPositionError=0,maxNormalError=0;
 for(let i=0;i<cases.length;i++){
  const c=cases[i],expected=reference.deform(reference.unpack(c.words),c.position,c.normal);
  for(let j=0;j<3;j++){
   const pe=Math.abs(gpu.values[i*8+j]-expected.position[j]),ne=Math.abs(gpu.values[i*8+4+j]-expected.normal[j]);
   maxPositionError=Math.max(maxPositionError,pe);maxNormalError=Math.max(maxNormalError,ne);
   assert(pe<1e-4,`position case ${i}/${j}: ${pe}`);assert(ne<1e-5,`normal case ${i}/${j}: ${ne}`);
  }
 }
 Object.assign(report,{pass:true,maxPositionError,maxNormalError,gpu,casesData:cases.map(({bytes,...c})=>c)});
}catch(error){report.failure=error.stack;process.exitCode=1;}finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report));console.log({pass:report.pass,cases:report.cases,maxPositionError:report.maxPositionError,maxNormalError:report.maxNormalError,failure:report.failure});}})();
