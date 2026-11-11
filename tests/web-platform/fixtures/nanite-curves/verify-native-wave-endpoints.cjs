'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('../../content-file-metadata.cjs');
const root=path.resolve(__dirname,'../../../..'),source=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/NaniteRasterizer.usf');
const oldSource=path.join(__dirname,'failure-native-curves/NaniteRasterizer.usf');
const out=path.join(__dirname,'native-wave-kernels');fs.mkdirSync(out,{recursive:true});
function functionText(s,name){const at=s.indexOf(name);assert(at>=0);let depth=0;for(let i=s.indexOf('{',at);i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(at,i+1);}throw Error(name);}
const variants=[];
for(const baseline of [false,true]){
 const text=fs.readFileSync(baseline?oldSource:source,'utf8').replace(/\r\n/g,'\n');
 const start=text.indexOf('const uint PointIt = GroupThreadIndex + LoopIt * ThreadGroupSize;');
 const end=text.indexOf('// Simple curve rasterizer using DDA',start);assert(start>=0&&end>start);
 // Execute the actual production point-fetch/transform/shuffle control flow.
 // Deterministic stub vertices expose wrong or inactive adjacent lanes without
 // involving projection, visibility-buffer races or material interpolation.
 let body=text.slice(start,end);
 // The old native shader permits divergent wave operations. For WebGPU's
 // uniformity rules only, keep faded lanes in the baseline shuffle; this does
 // not repair its out-of-wave endpoint or change any live lane's vertex.
 if(baseline)body=body.replace(/if \(bCull\)\s*\{\s*continue;\s*\}/,'');
 if(!baseline)assert(body.includes('if (bFetchAdjacentPoint)'));
 const helper=functionText(text,'FTransformedCurvePoint WaveReadAdjacentLane(');
 const identity=/const uint SourceVertIndex = [^;]+;/.exec(text.slice(end))?.[0];assert(identity);
 for(const triangle of [false,true])for(const groupSize of [64,128,256]){
  const name=`${baseline?'baseline':'fixed'}-${triangle?'ribbon':'line'}-${groupSize}`;
  const hlsl=`
#define NANITE_MATERIAL_INCLUDES ${+triangle}
#define USE_SEGMENT_TRIANGLE ${+triangle}
#define VIRTUAL_TEXTURE_TARGET 0
#define COMPILER_SUPPORTS_WAVE_READCROSSLANE 0
#define UNROLL [unroll]
#define NANITE_MAX_CLUSTER_TRIANGLES 128
struct FTransformedCurvePoint {float3 ClipPointLeft;float3 ClipPointRight;float WorldRadius;float RadiusInPixel;float4 ClipPoint;};
struct FBasis {float3 TangentZ;};
struct FNaniteTransformedVert {float3 PointWorld;FBasis TangentBasis;float CurveRadius;};
struct FNanitePostDeformVertex {float3 Position;FBasis TangentBasis;float CurveRadius;};
struct FInstance {uint InstanceId;float4 NonUniformScale;};
struct FView {uint SceneRendererPrimaryViewId;};
struct FMaterial {uint VertTransforms;};
uint GetInstanceViewData(uint a,uint b){return a+b;}
FNaniteTransformedVert FetchTransformedNaniteVertex(uint P,FInstance I,uint D,uint T,uint C,uint V,uint Index,bool W){
 FNaniteTransformedVert R;R.PointWorld=float3(Index,Index*3+1,Index*7+2);R.TangentBasis.TangentZ=float3(0,1,0);R.CurveRadius=Index+1;return R;}
FNanitePostDeformVertex FetchAndDeformLocalNaniteVertex(uint P,FInstance I,uint D,uint C,uint V,uint Index,uint UV){
 FNanitePostDeformVertex R;R.Position=float3(Index,Index*3+1,Index*7+2);R.TangentBasis.TangentZ=float3(0,1,0);R.CurveRadius=Index+1;return R;}
float GetdViewPosdXY(FView V,float Z,bool I){return 2;}
void BuildSegmentTrianglePoints(uint R,FView V,float3 P,float3 N,float Radius,out float4 L,out float4 H){L=float4(P-N*Radius,1);H=float4(P+N*Radius,1);}
${helper}
[[vk::binding(0,0)]] StructuredBuffer<uint4> Cases;
[[vk::binding(1,0)]] RWStructuredBuffer<float4> Results;
[numthreads(${groupSize},1,1)] void MainCS(uint3 Group:SV_GroupID,uint GroupThreadIndex:SV_GroupIndex){
 uint4 Case=Cases[Group.x];const uint NumPointPerCurve=Case.x,NumPoints=Case.y,VisibleCurveCount=Case.z,ThreadGroupSize=${groupSize};
 uint PrimitiveData=0,InstanceViewData=0,Cluster=0,VisibleCluster=0,Raster=0;bool bEvaluateWPO=true;
 FInstance InstanceData;InstanceData.InstanceId=0;InstanceData.NonUniformScale=1;
 FView NaniteView;NaniteView.SceneRendererPrimaryViewId=0;FMaterial MaterialShader;MaterialShader.VertTransforms=0;
 float4x4 VertTransforms_TranslatedWorldToClip=float4x4(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1);
 float3x3 VertTransforms_LocalToWorldNoScale=float3x3(1,0,0,0,1,0,0,0,1);
 for(uint LoopIt=0;LoopIt<(NumPoints+ThreadGroupSize-1)/ThreadGroupSize;LoopIt++){
 ${body}
 if(!bCull && PointIt%NumPointPerCurve+1<NumPointPerCurve){
  uint Address=(Group.x*256+PointIt)*5;
  ${identity}
  Results[Address+4]=float4(SourceVertIndex,SourceVertIndex+1,0,1);
  #if NANITE_MATERIAL_INCLUDES
  Results[Address]=float4(TransformedCurvePoint0.ClipPointLeft,1);Results[Address+1]=float4(TransformedCurvePoint0.ClipPointRight,1);
  Results[Address+2]=float4(TransformedCurvePoint1.ClipPointLeft,1);Results[Address+3]=float4(TransformedCurvePoint1.ClipPointRight,1);
  #else
  Results[Address]=TransformedCurvePoint0.ClipPoint;Results[Address+1]=float4(TransformedCurvePoint0.WorldRadius,TransformedCurvePoint0.RadiusInPixel,0,1);
  Results[Address+2]=TransformedCurvePoint1.ClipPoint;Results[Address+3]=float4(TransformedCurvePoint1.WorldRadius,TransformedCurvePoint1.RadiusInPixel,0,1);
  #endif
 }
 } } }
`;
  const h=path.join(out,name+'.hlsl'),spv=path.join(out,name+'.spv'),wgsl=path.join(out,name+'.wgsl');fs.writeFileSync(h,hlsl);
  cp.execFileSync(path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,h],{windowsHide:true});
  cp.execFileSync(path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
  const code=fs.readFileSync(wgsl,'utf8');variants.push({name,baseline,triangle,groupSize,code,entry:/@compute[\s\S]*?fn (\w+)\(/.exec(code)[1],inputs:[h,spv,wgsl].map(audit)});
 }
}
const cases=[];
for(const points of [2,3,4,7,8,16,31,32,33,63,64,65,127,128,129,255,256]){
 const curves=Math.floor(256/points);
 for(const visible of [...new Set([0,1,Math.max(1,curves-1),curves])])cases.push([points,curves*points,visible,0]);
}
if(process.argv.includes('--compile-only')){console.log({compiled:true,variants:variants.length,cases:cases.length});process.exit(0);}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');const results=[];
 for(const variant of variants){
  const gpu=await page.evaluate(async({code,entry,cases})=>{
   const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredFeatures:['subgroups']});
   const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
   try{
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
    const data=new Uint32Array(cases.flat()),input=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,data);
    const output=device.createBuffer({size:cases.length*256*80,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:output.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
    const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,bind);p.dispatchWorkgroups(cases.length);p.end();e.copyBufferToBuffer(output,0,read,0,read.size);device.queue.submit([e.finish()]);
    await read.mapAsync(GPUMapMode.READ);const values=[...new Float32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)errors.push(error.message);
    return {values,errors,minWave:adapter.info.subgroupMinSize,maxWave:adapter.info.subgroupMaxSize};
   }finally{device.destroy();}
  },{code:variant.code,entry:variant.entry,cases});
  assert.deepEqual(gpu.errors,[]);let segments=0,mismatches=0,endpointMismatches=0,identityMismatches=0;const examples=[];
  for(let c=0;c<cases.length;c++)for(let v=0;v<256;v++){
   const [points,count,visible]=cases[c],active=v<count&&Math.floor(v/points)<visible&&v%points+1<points;
   let expected=Array(20).fill(0);
   if(active){segments++;expected=[];for(const i of [v,v+1]){
    expected.push(...(variant.triangle?[i,2*i,7*i+2,1,i,4*i+2,7*i+2,1]:[i,3*i+1,7*i+2,1,i+1,(i+1)*2,0,1]));
   }expected.push(v,v+1,0,1);}
   const got=gpu.values.slice((c*256+v)*20,(c*256+v+1)*20);
   if(got.slice(0,16).some((x,i)=>x!==expected[i]))endpointMismatches++;
   if(got.slice(16).some((x,i)=>x!==expected[16+i]))identityMismatches++;
   if(got.some((x,i)=>x!==expected[i])){mismatches++;if(examples.length<4)examples.push({case:cases[c],point:v,got,expected});}
  }
  if(variant.baseline){assert(endpointMismatches>0,'Original native wave boundary must fail');assert(identityMismatches>0,'Original native segment identity must fail');}
  else assert.equal(mismatches,0,JSON.stringify(examples));
  const readback=path.join(out,variant.name+'-readback.bin');fs.writeFileSync(readback,Buffer.from(new Float32Array(gpu.values).buffer));
  results.push({...variant,code:undefined,segments,mismatches,endpointMismatches,identityMismatches,examples,wave:[gpu.minWave,gpu.maxWave],readback:audit(readback),gpuErrors:gpu.errors});
 }
 const report={pass:true,source:audit(__filename),inputs:[source,oldSource].map(audit),cases,results};fs.writeFileSync(path.join(__dirname,'native-wave-endpoints.json'),JSON.stringify(report,null,2)+'\n');
 console.log({pass:true,variants:results.length,checks:cases.length*results.length,baselineMismatches:results.filter(r=>r.baseline).reduce((n,r)=>n+r.mismatches,0)});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
