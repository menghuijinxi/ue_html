'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('../../content-file-metadata.cjs');
const root=path.resolve(__dirname,'../../../..'),engine=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite');
const rasterFile=path.join(engine,'NaniteRasterizer.usf'),cullingFile=path.join(engine,'NaniteCullingCommon.ush');
const raster=fs.readFileSync(rasterFile,'utf8'),culling=fs.readFileSync(cullingFile,'utf8');
function extract(s,name){const begin=s.indexOf(name);assert(begin>=0);let depth=0,start=s.indexOf('{',begin);for(let i=start;i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(begin,i+1);}throw Error(name);}
const nativeProjection=extract(culling,'float2 GetProjectedEdgeScales('),nativeBounds=extract(culling,'FNodeCullingBounds InitNodeCullingBounds(FInstanceSceneData');
const nativeTransition=extract(raster,'float ComputeClusterLODTransition(');
const nativeRibbon=extract(raster,'void BuildSegmentTrianglePoints(');
const lodFile=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/WebNaniteCurveLOD.ush');
const curveFile=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/WebNaniteCurves.ush');
const portLOD=extract(fs.readFileSync(lodFile,'utf8'),'uint WebNaniteVisibleCurveCount(');
const portRibbon=extract(fs.readFileSync(curveFile,'utf8'),'float4 WebNaniteCurveRibbonPoint(');
const source=`
float length2(float3 v){return dot(v,v);} float Square(float v){return v*v;}
float min3(float x,float y,float z){return min(x,min(y,z));}
struct FCluster {float3 BoxBoundsCenter;float3 BoxBoundsExtent;float4 LODBounds;float ParentSphereBoundRadius;float ParentLODError;float LODError;uint NumCurves;uint CurveFadingIndex;};
struct FNaniteView {float4x4 ViewToClip;float3 ViewForward;float NearPlane;float LODScale;float4x4 TranslatedWorldToClip;};
struct FInstanceSceneData {float4 NonUniformScale;};
struct FInstanceDynamicData {float4x4 LocalToTranslatedWorld;};
struct FNodeCullingBounds {float3 BoxCenter;float3 BoxExtent;float4 Sphere;float MeshMinDeformScale;float NodeMaxDeformScale;};
struct FRaster {uint unused;};
// Native function's software-raster pixel conversion is intentionally isolated
// here: the Web hardware vertex output is the preceding homogeneous position.
float4 CalculateSubpixelCoordinates(FRaster R,float4 P){return P;}
${nativeBounds}
${nativeProjection}
${nativeTransition}
${nativeRibbon}
${portLOD}
${portRibbon}
struct FCase {float4 Sphere;float4 Parameters;float4 Scale;float4 Errors;uint4 Config;float4 Point;float4 Tangent;float4 Forward;float4 Row0;float4 Row1;float4 Row2;float4 Row3;};
[[vk::binding(0,0)]] StructuredBuffer<FCase> Cases;
[[vk::binding(1,0)]] RWStructuredBuffer<float4> Results;
[numthreads(64,1,1)] void MainCS(uint3 ID:SV_DispatchThreadID){
 uint Count,Stride;Cases.GetDimensions(Count,Stride);if(ID.x>=Count)return;
 FCase C=Cases[ID.x];FCluster K=(FCluster)0;K.LODBounds=C.Sphere;K.ParentSphereBoundRadius=C.Parameters.x;
 K.ParentLODError=C.Errors.y;K.LODError=C.Errors.x;K.NumCurves=C.Config.x;K.CurveFadingIndex=C.Config.y;
 FNaniteView V=(FNaniteView)0;V.ViewToClip[3][3]=C.Config.z;V.ViewForward=C.Forward.xyz;V.NearPlane=C.Parameters.z;V.LODScale=C.Parameters.y;
 V.TranslatedWorldToClip=float4x4(C.Row0,C.Row1,C.Row2,C.Row3);
 FInstanceSceneData I;I.NonUniformScale=C.Scale;
 FInstanceDynamicData D;D.LocalToTranslatedWorld=float4x4(1,0,0,0,0,1,0,0,0,0,1,0,0,0,C.Parameters.w,1);
 float Native=ComputeClusterLODTransition(V,I,D,K);
 uint NativeCount=K.CurveFadingIndex+uint(Native*(K.NumCurves-K.CurveFadingIndex));
 Results[ID.x*5]=float4(Native,NativeCount,WebNaniteVisibleCurveCount(V,I,D,K),0);
 float4 Left,Right;BuildSegmentTrianglePoints((FRaster)0,V,C.Point.xyz,C.Tangent.xyz,C.Point.w,Left,Right);
 Results[ID.x*5+1]=Left;Results[ID.x*5+2]=Right;
 Results[ID.x*5+3]=WebNaniteCurveRibbonPoint(C.Point.xyz,C.Tangent.xyz,C.Point.w,1,V.ViewForward,V.TranslatedWorldToClip);
 Results[ID.x*5+4]=WebNaniteCurveRibbonPoint(C.Point.xyz,C.Tangent.xyz,C.Point.w,-1,V.ViewForward,V.TranslatedWorldToClip);
}`;
const out=path.join(__dirname,'kernels');fs.mkdirSync(out,{recursive:true});
const hlsl=path.join(out,'curves.hlsl'),spv=path.join(out,'curves.spv'),wgsl=path.join(out,'curves.wgsl');fs.writeFileSync(hlsl,source);
cp.execFileSync(path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
cp.execFileSync(path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
const code=fs.readFileSync(wgsl,'utf8'),entry=/@compute[\s\S]*?fn (\w+)\(/.exec(code)?.[1];assert(entry);
const f16=b=>{const e=b>>10&31,m=b&1023;return (b&32768?-1:1)*(e===31?(m?NaN:Infinity):e?2**(e-15)*(1+m/1024):2**-14*m/1024);};
const cases=[],inputs=[];
for(const fixtures of ['fixtures','groom-gpu'])for(const name of fs.readdirSync(path.join(__dirname,fixtures))){
 const dir=path.join(__dirname,fixtures,name),pageFile=path.join(dir,'gpu-pages.bin');if(!fs.existsSync(pageFile))continue;
 const pages=fs.readFileSync(pageFile),installs=fs.readFileSync(path.join(dir,'install.bin'));inputs.push(audit(pageFile),audit(path.join(dir,'install.bin')));
 for(let index=0;index<installs.length/16;index+=Math.max(1,Math.floor(installs.length/16/7))){
  const p=pages.subarray(installs.readUInt32LE(index*16+8)),c=installs.readUInt32LE(index*16)&255,n=p.readUInt32LE(0)&65535;
  const word=(r,k)=>p.readUInt32LE(16+(r*n+c)*16+k*4),float=(r,k)=>p.readFloatLE(16+(r*n+c)*16+k*4);
  const curves=word(6,2)&255,fade=word(6,1)>>>22,errors=[f16(word(3,3)&65535),f16(word(6,3)&65535),0,0],radius=f16(word(6,3)>>>16);
  assert(fade<=curves);if(!Number.isFinite(errors[1]))continue;
  for(const ortho of [0,1])for(const distance of [1,25,100,400,1600])for(const scaled of [false,true]){
   const sphere=[float(2,0),float(2,1),float(2,2),float(2,3)],scale=scaled?[.6,1.4,.9,1.4]:[1,1,1,1];
   const projection=ortho?[.01,0,0,0,0,.015,0,0,0,0,-.0005,0,.1,-.2,.9,1]:[1.2,0,0,0,0,1.6,0,0,0,0,0,1,.1,-.2,5,0];
   cases.push({name,index,ortho,distance,scaled,sphere,parameters:[radius,80,1,distance],scale,errors,config:[curves,fade,ortho,0],point:[3,-2,30,.35],tangent:[.3,.4,.8,0],forward:[0,0,1,0],projection});
  }
 }
}
assert(cases.length>500);const bytes=Buffer.alloc(cases.length*192);
for(let i=0;i<cases.length;i++){const c=cases[i];let at=i*192;for(const field of ['sphere','parameters','scale','errors','config','point','tangent','forward','projection'])for(const v of c[field]){field==='config'?bytes.writeUInt32LE(v,at):bytes.writeFloatLE(v,at);at+=4;}assert.equal(at,(i+1)*192);}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const gpu=await tab.evaluate(async({code,entry,bytes,count})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try{
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
   const input=device.createBuffer({size:bytes.length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,new Uint8Array(bytes));
   const output=device.createBuffer({size:count*80,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:count*80,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
   const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
   const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,bind);p.dispatchWorkgroups(Math.ceil(count/64));p.end();e.copyBufferToBuffer(output,0,read,0,read.size);device.queue.submit([e.finish()]);
   await read.mapAsync(GPUMapMode.READ);const values=[...new Float32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);return {values,errors};
  }finally{device.destroy();}
 },{code,entry,bytes:[...bytes],count:cases.length});
 assert.deepEqual(gpu.errors,[]);let maxRibbonError=0;const results=[];
 for(let i=0;i<cases.length;i++){
  const c=cases[i],v=gpu.values.slice(i*20,i*20+20);assert(v.every(Number.isFinite));
  assert.equal(v[1],v[2],`${c.name}:${c.index} fade count`);assert(v[2]>=c.config[1]&&v[2]<=c.config[0]);
  for(let j=0;j<8;j++){const error=Math.abs(v[4+j]-v[12+j]);maxRibbonError=Math.max(maxRibbonError,error);assert(error<1e-5);}
  results.push({name:c.name,index:c.index,ortho:c.ortho,distance:c.distance,scaled:c.scaled,transition:v[0],nativeCount:v[1],webCount:v[2]});
 }
 assert(results.some((r,i)=>r.webCount>cases[i].config[1]));
 assert(results.some((r,i)=>r.webCount<cases[i].config[0]));
 const report={pass:true,cases:cases.length,maxRibbonError,gpuErrors:gpu.errors,source:audit(__filename),inputs:[...inputs,...[rasterFile,cullingFile,lodFile,curveFile,hlsl,spv,wgsl].map(audit)],results};
 fs.writeFileSync(path.join(__dirname,'curve-kernels.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,cases:cases.length,maxRibbonError,gpuErrors:gpu.errors.length});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
