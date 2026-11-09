'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');
const reference=require('./nanite-lod-reference.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-lod-projection');
fs.mkdirSync(output,{recursive:true});
const shaderFile=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteLOD.ush');
const nativeFile=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/NaniteCullingCommon.ush');
const native=fs.readFileSync(nativeFile,'utf8');
const original=native.slice(native.indexOf('float2 GetProjectedEdgeScales('),native.indexOf('float2 GetProjectedEdgeScales_Offscreen('));
assert(original.startsWith('float2 GetProjectedEdgeScales(')&&original.endsWith('\n'));
const port=fs.readFileSync(shaderFile,'utf8').replace('#pragma once','')
  .replace('uint WebCullLODMode;','static uint WebCullLODMode;')
  .replace('float4x4 WebCullLocalToView;','static float4x4 WebCullLocalToView;')
  .replace('float4 WebCullLODParameters;','static float4 WebCullLODParameters;');
const source=`
float Square(float X) { return X*X; }
float length2(float3 X) { return dot(X,X); }
#define NANITE_CLUSTER_FLAG_FULL_LEAF 4u
#define NANITE_CLUSTER_FLAG_STREAMING_LEAF 2u
struct FHierarchyNodeSlice { float4 LODBounds; float MinLODError; float MaxParentLODError; bool bLeaf; };
struct FCluster { float4 LODBounds; float LODError; uint Flags; };
struct FNaniteView { float4x4 ViewToClip; float4 ViewForward; float NearPlane; };
struct FInstanceSceneData { float4 NonUniformScale; };
struct FInstanceDynamicData { float4x4 LocalToTranslatedWorld; };
${original}
${port}
struct FCase { float4 NodeSphere; float4 ClusterSphere; float4 Parameters; float4 Row0; float4 Row1; float4 Row2; float4 Row3; float4 Errors; uint4 Config; };
[[vk::binding(0,0)]] StructuredBuffer<FCase> Cases;
[[vk::binding(1,0)]] RWStructuredBuffer<float4> Results;
[numthreads(64,1,1)] void MainCS(uint3 Id:SV_DispatchThreadID) {
  uint Count,Stride; Cases.GetDimensions(Count,Stride); if(Id.x>=Count)return;
  FCase C=Cases[Id.x]; WebCullLODMode=C.Config.x; WebCullLODParameters=C.Parameters;
  WebCullLocalToView=float4x4(C.Row0,C.Row1,C.Row2,C.Row3);
  FHierarchyNodeSlice N;N.LODBounds=C.NodeSphere;N.MinLODError=C.Errors.x;N.MaxParentLODError=C.Errors.y;N.bLeaf=true;
  FCluster K;K.LODBounds=C.ClusterSphere;K.LODError=C.Errors.z;K.Flags=C.Config.y;
  float2 Edge=WebProjectedEdgeScales(N.LODBounds);
  Results[Id.x*2]=float4(Edge,float(WebVisitLODNode(N)),float(WebDrawLODCluster(K)));
  FNaniteView V=(FNaniteView)0;V.ViewToClip[3][3]=C.Config.x==2?1:0;V.ViewForward=float4(0,0,1,0);V.NearPlane=C.Parameters.w;
  FInstanceSceneData I;I.NonUniformScale=float4(C.Parameters.yyy,C.Parameters.z);
  FInstanceDynamicData D;D.LocalToTranslatedWorld=WebCullLocalToView;
  float2 NativeNode=GetProjectedEdgeScales(V,I,D,N.LODBounds),NativeCluster=GetProjectedEdgeScales(V,I,D,K.LODBounds);
  float E=C.Parameters.x*C.Parameters.y;
  Results[Id.x*2+1]=float4(NativeNode,float(NativeNode.x<=E*N.MaxParentLODError&&NativeNode.y>=E*N.MinLODError),
    float((K.Flags&2u)!=0||NativeCluster.x>E*K.LODError));
}`;
const hlsl=path.join(output,'projection.hlsl'),spv=path.join(output,'projection.spv'),wgsl=path.join(output,'projection.wgsl');
fs.writeFileSync(hlsl,source);
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe');
cp.execFileSync(dxc,['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
cp.execFileSync(tint,['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
const code=fs.readFileSync(wgsl,'utf8');
const entry=/fn (\w+)\(.*@builtin\(global_invocation_id\)/.exec(code)?.[1] || /@compute[\s\S]*?fn (\w+)\(/.exec(code)?.[1];assert(entry);
const pageFile=path.join(__dirname,'results/nanite-uploader/20261109-184907/page-0-0-0.bin');
// Use the exact serialized node, excluding the GPU allocation's unwritten tail.
const hierarchyFile=path.join(__dirname,'results/nanite-browser/scene-hierarchy-1.bin');
const page=fs.readFileSync(pageFile),hierarchy=fs.readFileSync(hierarchyFile),count=page.readUInt32LE(0)&65535;
assert.equal(count,15);assert(hierarchy.length>=240);
const f16=b=>{const s=b&32768?-1:1,e=(b>>10)&31,m=b&1023;return s*(e===31?(m?NaN:Infinity):e?2**(e-15)*(1+m/1024):2**-14*m/1024);};
const groups=Array.from({length:4},(_,i)=>{
  const errors=hierarchy.readUInt32LE(64+i*16+12),first=hierarchy.readUInt32LE(128+i*16+12)&255,n=(hierarchy.readUInt32LE(192+i*12+4)>>>16)&511;
  return {sphere:Array.from({length:4},(_,c)=>hierarchy.readFloatLE(i*16+c*4)),min:f16(errors>>>16),max:f16(errors&65535),first,n};
});
assert.equal(groups.reduce((n,g)=>n+g.n,0),15);
const clusters=Array.from({length:count},(_,i)=>{
  const at=(v,c)=>16+(v*count+i)*16+c*4;
  return {sphere:Array.from({length:4},(_,c)=>page.readFloatLE(at(2,c))),error:f16(page.readUInt32LE(at(3,3))&65535),flags:page.readUInt32LE(at(4,3)),triangles:page.readUInt32LE(at(0,1))&255};
});
const cases=[],scenarios=[];
function scenario(name,mode,scale,distance,x=0,y=0,axes=[1,1,1]) {
  const start=cases.length,params=[scale,Math.min(...axes.map(Math.abs)),Math.max(...axes.map(Math.abs)),10];
  const matrix=[axes[0],0,0,0,0,axes[1],0,0,0,0,axes[2],0,x,y,distance,1];
  for(const group of groups)for(let i=group.first;i<group.first+group.n;i++) {
    const cluster=clusters[i];cases.push({name,cluster:i,values:[...group.sphere,...cluster.sphere,...params,...matrix,group.min,group.max,cluster.error,0],mode,flags:cluster.flags});
  }
  scenarios.push({name,mode,scale,start,count:cases.length-start,localToView:matrix,lodParameters:params.map(Math.fround)});
}
for(const scale of [4,2,1,.5,.25])scenario('ortho-'+scale,2,scale,500);
// Dense forward/backward zoom crosses every cut repeatedly at small intervals.
for(let i=0;i<=160;i++)scenario('zoom-'+i,1,512,80*1.025**i);
for(let i=160;i>=0;i-=4)scenario('reverse-'+i,1,512,80*1.025**i);
for(const xyz of [[0,0,40],[0,0,0],[250,50,400],[1000,600,700],[0,0,-200]]) {
  scenario('offaxis-'+xyz,1,512,xyz[2],xyz[0],xyz[1]);
  scenario('mirror-'+xyz,1,512,xyz[2],xyz[0],xyz[1],[-.5,2,1]);
}
const bytes=Buffer.alloc(cases.length*144);
cases.forEach((c,i)=>{c.values.forEach((v,n)=>bytes.writeFloatLE(v,i*144+n*4));bytes.writeUInt32LE(c.mode,i*144+128);bytes.writeUInt32LE(c.flags,i*144+132);});
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
  const gpu=await tab.evaluate(async ({code,entry,bytes,count})=>{
    const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required');
    const device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    try {
      device.pushErrorScope('validation');
      const data=device.createBuffer({size:bytes.length,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(data,0,new Uint8Array(bytes));
      const out=device.createBuffer({size:count*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const read=device.createBuffer({size:count*32,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      const module=device.createShaderModule({code}),pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:entry}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[data,out].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const command=device.createCommandEncoder(),pass=command.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
      command.copyBufferToBuffer(out,0,read,0,count*32);device.queue.submit([command.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);
      return {values,errors};
    }finally{device.destroy();}
  },{code,entry,bytes:[...bytes],count:cases.length});
  assert.deepEqual(gpu.errors,[]);let maxRelativeError=0,maxCPUError=0,nativeFinite=0;
  for(let i=0;i<cases.length;i++) {
    const v=gpu.values.slice(i*8,i*8+8);assert(v.slice(0,4).every(Number.isFinite),cases[i].name);
    const values=cases[i].values.map(Math.fround),expected=reference.projected(values.slice(0,4),cases[i].mode,values.slice(12,28),values.slice(8,12));
    for(let c=0;c<2;c++){const error=Math.abs(v[c]-expected[c])/Math.max(1,Math.abs(expected[c]));maxCPUError=Math.max(maxCPUError,error);assert(error<2e-5,`${cases[i].name} angular projection ${error}`);}
    if(v.slice(4).every(Number.isFinite)) {
      nativeFinite++;
      for(let c=0;c<2;c++){const error=Math.abs(v[c]-v[c+4])/Math.max(1,Math.abs(v[c+4]));maxRelativeError=Math.max(maxRelativeError,error);assert(error<2e-5,`${cases[i].name} projection ${error}`);}
      assert.equal(v[2],v[6],cases[i].name+' node cut');assert.equal(v[3],v[7],cases[i].name+' cluster cut');
    }
  }
  const cuts=scenarios.map(s=>{const selected=cases.slice(s.start,s.start+s.count).filter((_,j)=>gpu.values[(s.start+j)*8+2]&&gpu.values[(s.start+j)*8+3]).map(c=>c.cluster);
    assert.equal(new Set(selected).size,selected.length,s.name+' duplicate cluster');
    assert.deepEqual([...selected].sort((a,b)=>a-b),reference.select({...s,lodMode:s.mode},page,hierarchy),s.name+' independent CPU cut');
    return {...s,selected,triangles:selected.reduce((n,i)=>n+clusters[i].triangles,0)};});
  assert.deepEqual(cuts.slice(0,5).map(c=>c.triangles),[960,960,504,252,126]);
  const completeCuts=[[0],[1,2],[3,4,5,6],[7,8,9,10,11,12,13,14]];
  for(const cut of cuts)assert(completeCuts.some(expected=>JSON.stringify(expected)===JSON.stringify([...cut.selected].sort((a,b)=>a-b))),
    cut.name+' must select one complete cut, without overlapping parent/child groups');
  // Decode actual simplified geometry and require every oriented boundary to
  // meet its opposite. This closed-sphere fixture must remain watertight at
  // every selectable LOD, including boundaries between different clusters.
  const topology=completeCuts.map(selected=>{
    const edges=new Map();let triangles=0;
    for(const cluster of selected)for(let tri=0;tri<clusters[cluster].triangles;tri++) {
      const vertices=decodeTriangle(page,cluster,tri).vertices.map(v=>v.position.join(','));
      assert.equal(new Set(vertices).size,3,'Degenerate triangle');triangles++;
      for(let i=0;i<3;i++) {const a=vertices[i],b=vertices[(i+1)%3],key=[a,b].sort().join('|'),value=edges.get(key)||[0,0];
        value[0]++;value[1]+=a<b?1:-1;edges.set(key,value);}
    }
    assert([...edges.values()].every(([count,direction])=>count===2&&direction===0),'LOD cut has an open or duplicated edge');
    return {selected,triangles,edges:edges.size,closed:true};
  });
  const zoom=cuts.filter(c=>c.name.startsWith('zoom-'));assert(zoom.every(c=>c.selected.length>0),'Zoom must retain geometry');
  assert(zoom[0].triangles>zoom.at(-1).triangles);
  for(const c of cuts.filter(c=>c.name.startsWith('reverse-')))assert.deepEqual(c.selected,zoom[Number(c.name.slice(8))].selected);
  const report={pass:true,date:new Date().toISOString(),cases:cases.length,nativeFinite,maxRelativeError,maxCPUError,cuts,topology,errors:gpu.errors,
    source:audit(__filename),sources:[shaderFile,nativeFile,pageFile,hierarchyFile,require.resolve('./verify-nanite-material-inputs.cjs'),require.resolve('./nanite-lod-reference.cjs')].map(audit),tools:[dxc,tint].map(audit),products:[hlsl,spv,wgsl].map(audit),
    boundary:'GPU projection and cut selection against unmodified native HLSL on real root-page records. Separate from engine traversal, scene integration, coverage and streaming acceptance.'};
  fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,cases:cases.length,nativeFinite,maxRelativeError}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
