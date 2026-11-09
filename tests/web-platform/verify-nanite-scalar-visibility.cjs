'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-scalar-visibility');
fs.mkdirSync(output,{recursive:true});
const helper=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteScalarVisibility.ush');
const source=`[[vk::binding(0,0)]] StructuredBuffer<uint4> Candidates;
[[vk::binding(2,0)]] cbuffer Config { uint4 Settings; }
${fs.readFileSync(helper,'utf8').replace('#pragma once','')
 .replace('RWStructuredBuffer<FWebScalarVisibilityPixel> WebNaniteScalarVisibility;',
   '[[vk::binding(1,0)]] RWStructuredBuffer<FWebScalarVisibilityPixel> WebNaniteScalarVisibility;')
 .replace('uint2 WebNaniteVisibilitySize;','static uint2 WebNaniteVisibilitySize;')}
[numthreads(64,1,1)] void MainCS(uint3 I:SV_DispatchThreadID) {
  if(I.x>=Settings.w)return;WebNaniteVisibilitySize=Settings.xy;uint4 C=Candidates[I.x+Settings.z];
  WebWriteScalarVisibility(C.xy,C.z,asfloat(C.w),PHASE);
}
struct V { float4 Position:SV_Position; nointerpolation uint ID:TEXCOORD0; nointerpolation float Depth:TEXCOORD1; };
V MainVS(uint I:SV_InstanceID) {
  uint4 C=Candidates[I+Settings.z];V O;O.Position=float4((float2(C.xy)+.5)/float2(13,7)*float2(2,-2)+float2(-1,1),0,1);
  O.ID=C.z;O.Depth=asfloat(C.w);return O;
}
float4 MainPS(V I):SV_Target0 {
  WebNaniteVisibilitySize=Settings.xy;WebWriteScalarVisibility(uint2(I.Position.xy),I.ID,I.Depth,PHASE);return 0;
}`;
const hlsl=path.join(output,'scalar.hlsl');fs.writeFileSync(hlsl,source);
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),shaders=[],products=[audit(hlsl)];
for(const [stage,entry] of [['cs','MainCS'],['ps','MainPS'],['vs','MainVS']])for(let phase=0;phase<(stage==='vs'?1:2);phase++) {
  const base=path.join(output,`${stage}-${phase}`),spv=base+'.spv',wgsl=base+'.wgsl';
  cp.execFileSync(dxc,['-T',stage+'_6_0','-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-DPHASE='+phase,'-Fo',spv,hlsl],{windowsHide:true});
  cp.execFileSync(tint,['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
  const code=fs.readFileSync(wgsl,'utf8');assert(!code.includes('atomic<vec2')&&!code.includes('atomicStoreMax'));
  if(stage!=='vs')assert(code.includes('atomicMax('));
  shaders.push({stage,phase,entry,code});products.push(audit(spv),audit(wgsl));
}
const bits=v=>{const b=Buffer.alloc(4);b.writeFloatLE(v);return b.readUInt32LE();};
let seed=0x12345678;const rand=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const candidates=Array.from({length:8192},(_,i)=>[rand()%13,rand()%7,rand()||1,bits((rand()%17-2)/12)]);
candidates.push([0,0,0xffffffff,bits(.3)],[0,0,1,bits(2)],[0,0,0x80000000,bits(1)],
  [1,0,0xfffffffe,bits(0)],[1,0,3,bits(0)],[99,4,100,bits(1)],[0xffffffff,0,0xffffffff,bits(1)]);
const cases=[...['compute','raster','compute-raster','raster-compute','mixed'].map(mode=>({mode,width:13,height:7,bytes:13*7*8})),
 {mode:'mixed',width:13,height:7,bytes:(13*7-3)*8},{mode:'compute',width:13,height:7,bytes:12},
 {mode:'mixed',width:0,height:7,bytes:13*7*8},{mode:'compute',width:0xffffffff,height:7,bytes:13*7*8}];
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await tab.evaluate(async ({shaders,candidates,cases})=>{
  const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required');
  // Request no optional features, even on hardware that offers packed atomics.
  const device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  try {
   const data=new Uint32Array(candidates.flat()),input=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
   device.queue.writeBuffer(input,0,data);
   const modules=new Map(shaders.map(s=>[s.stage+s.phase,device.createShaderModule({code:s.code})]));
   const layout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.COMPUTE|GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:GPUShaderStage.COMPUTE|GPUShaderStage.FRAGMENT,buffer:{type:'storage'}},
    {binding:2,visibility:GPUShaderStage.COMPUTE|GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]});
   const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),compute=[],raster=[];
   for(let phase=0;phase<2;phase++) {
    compute.push(await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module:modules.get('cs'+phase),entryPoint:'MainCS'}}));
    raster.push(await device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module:modules.get('vs0'),entryPoint:'MainVS'},
      fragment:{module:modules.get('ps'+phase),entryPoint:'MainPS',targets:[{format:'rgba8unorm',writeMask:0}]},primitive:{topology:'point-list'}}));
   }
   const target=device.createTexture({size:[13,7],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT}),results=[];
   for(const test of cases) {
    device.pushErrorScope('validation');
    const initial=new Uint32Array(64+test.bytes/4+64).fill(0x1234abcd);initial.fill(0,64,64+test.bytes/4);
    const out=device.createBuffer({size:initial.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});device.queue.writeBuffer(out,0,initial);
    const read=device.createBuffer({size:initial.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const encoder=device.createCommandEncoder(),resources=[];
    for(let phase=0;phase<2;phase++)for(let chunk=0;chunk<4;chunk++) {
      const start=Math.floor(candidates.length*chunk/4),count=Math.floor(candidates.length*(chunk+1)/4)-start;
      const config=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});resources.push(config);
      device.queue.writeBuffer(config,0,new Uint32Array([test.width,test.height,start,count]));
      const group=device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:input}},
        {binding:1,resource:{buffer:out,offset:256,size:test.bytes}},{binding:2,resource:{buffer:config}}]});
      const isRaster=test.mode==='raster'||test.mode==='compute-raster'&&phase===1||test.mode==='raster-compute'&&phase===0||test.mode==='mixed'&&((chunk+phase)&1);
      const pass=isRaster?encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}]}):encoder.beginComputePass();
      pass.setPipeline(isRaster?raster[phase]:compute[phase]);pass.setBindGroup(0,group);
      if(isRaster)pass.draw(1,count);else pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();
    }
    encoder.copyBufferToBuffer(out,0,read,0,initial.byteLength);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const words=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);
    results.push({...test,words});resources.forEach(b=>b.destroy());out.destroy();read.destroy();
   }
   return {features:[...device.features],errors,results};
  }finally{device.destroy();}
 },{shaders,candidates,cases});
 assert(!result.features.includes('atomic-vec2u-min-max'));assert.deepEqual(result.errors,[]);
 for(const test of result.results) {
  const expected=new Uint32Array(test.bytes/4),rows=test.width?Math.floor(Math.floor(test.bytes/8)/test.width):0;
  for(const [x,y,id,z] of candidates) {
   if(x>=test.width||y>=test.height||y>=rows)continue;
   const b=Buffer.alloc(4);b.writeUInt32LE(z);const depth=bits(Math.max(0,Math.min(1,b.readFloatLE()))),p=(y*test.width+x)*2;
   if(depth>expected[p+1]||depth===expected[p+1]&&id>expected[p]){expected[p]=id;expected[p+1]=depth;}
  }
  assert(test.words.slice(0,64).every(w=>w===0x1234abcd)&&test.words.slice(64+test.bytes/4).every(w=>w===0x1234abcd),'Out-of-view writes');
  assert.deepEqual(test.words.slice(64,64+test.bytes/4),[...expected],test.mode+' exact packed winner');
  delete test.words;test.pass=true;test.guards=true;
 }
 const report={pass:true,date:new Date().toISOString(),candidates:candidates.length,...result,source:audit(__filename),sources:[audit(helper)],tools:[dxc,tint].map(audit),products,
  boundary:'Core-feature GPU compute/fragment contention and exact packed winner validation for the two-phase helper. Renderer scheduling and automatic device selection require separate integration tests.'};
 fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,candidates:candidates.length,cases:cases.length,features:result.features}));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
