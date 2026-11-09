'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'results/nanite-face-culling');fs.mkdirSync(out,{recursive:true});
const helpers=['WebNaniteMicroRaster.ush','WebNaniteFaceCulling.ush'].map(f=>path.join(root,'reference-engine/Engine/Shaders/Private/Nanite',f));
const hlsl=helpers.map(f=>fs.readFileSync(f,'utf8').replace('#pragma once','')).join('\n')+`
struct Triangle { float4 A; float4 B; float4 C; uint4 Policy; };
[[vk::binding(0,0)]] StructuredBuffer<Triangle> Triangles;
[[vk::binding(1,0)]] RWStructuredBuffer<uint2> Pixels;
[[vk::binding(2,0)]] RWStructuredBuffer<uint> Accepted;
[numthreads(64,1,1)] void MainCS(uint3 I:SV_DispatchThreadID) {
 if(I.x>=2048)return;Triangle T=Triangles[I.x];int2 P0,P1,P2,F,L;float3 Z;
 if(!WebPrepareMicroTriangle(T.A,T.B,T.C,uint4(0,0,1024,512),8,P0,P1,P2,Z,F,L))return;
 Accepted[I.x]=1;
 if(!WebNaniteMicroFaceVisible(P0,P1,P2,T.Policy.x))return;
 for(int Y=F.y;Y<=L.y;Y++)for(int X=F.x;X<=L.x;X++) {
  float Depth;if(WebMicroCovered(P0,P1,P2,Z,int2(X-F.x,Y-F.y)*256+128,Depth))
   Pixels[Y*1024+X]=uint2(I.x+1,asuint(Depth));
 }
}
struct Vertex { float4 Position:SV_Position; nointerpolation uint ID:TEXCOORD0; nointerpolation uint Flags:TEXCOORD1; };
Vertex MainVS(uint V:SV_VertexID,uint I:SV_InstanceID) {
 Triangle T=Triangles[I];Vertex O;O.Position=V==0?T.A:V==1?T.B:T.C;O.ID=I+1;O.Flags=T.Policy.x;return O;
}
Vertex MainHybridVS(uint V:SV_VertexID,uint I:SV_InstanceID) {
 Triangle T=Triangles[I];int2 P0,P1,P2,F,L;float3 Z;Vertex O=MainVS(V,I);
 if(WebPrepareMicroTriangle(T.A,T.B,T.C,uint4(0,0,1024,512),8,P0,P1,P2,Z,F,L))O.Position=float4(0,0,-1,1);
 return O;
}
uint2 MainPS(Vertex I):SV_Target0 {return uint2(I.ID,asuint(I.Position.z));}
uint2 MainCullPS(Vertex I,bool Front:SV_IsFrontFace):SV_Target0 {
 if(!WebNaniteFaceVisible(Front,I.Flags))discard;return uint2(I.ID,asuint(I.Position.z));
}
`;
fs.writeFileSync(path.join(out,'test.hlsl'),hlsl);
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe');
const stages=[['cs','MainCS'],['vs','MainVS'],['ps','MainPS'],['vs','MainHybridVS'],['ps','MainCullPS']],codes=[];
for(const [stage,entry] of stages){
 const base=path.join(out,entry);
 cp.execFileSync(dxc,['-T',stage+'_6_0','-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-Fo',base+'.spv',path.join(out,'test.hlsl')],{windowsHide:true});
 cp.execFileSync(tint,['--format','wgsl','-o',base+'.wgsl',base+'.spv'],{windowsHide:true});codes.push(fs.readFileSync(base+'.wgsl','utf8'));
}
const data=new ArrayBuffer(2048*64),floats=new Float32Array(data),words=new Uint32Array(data),flags=[];
let seed=0xa2179165;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
for(let i=0;i<2048;i++){
 const x=i%64*16+3,y=Math.floor(i/64)*16+3,depth=.1+random()*.8;
 let points=Array.from({length:3},()=>[x+random()*7,y+random()*7]);
 if(i%8===0)points=[[x+.5,y+.5],[x+7.5,y+.5],[x+.5,y+7.5]];
 if(i%11===0)points[2]=points[1];if(i%2)points.reverse();
 for(let v=0;v<3;v++){const [px,py]=points[v],w=.5+random()*2;floats.set([(px/1024*2-1)*w,(1-py/512*2)*w,(depth+random()*.05)*w,w],i*16+v*4);}
 const flag=[1,3,5,7,0][Math.floor(i/2)%5];words[i*16+12]=flag;flags.push(flag);
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const r=await page.evaluate(async({codes,words,flags})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try{
   const input=device.createBuffer({size:words.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,new Uint32Array(words));
   const size=1024*512*8,output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const accepted=device.createBuffer({size:2048*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const modules=codes.map(code=>device.createShaderModule({code}));
   const compute=await device.createComputePipelineAsync({layout:'auto',compute:{module:modules[0],entryPoint:'MainCS'}});
   const raster=async(cullMode,hybrid,shaderCull)=>device.createRenderPipelineAsync({layout:'auto',
    vertex:{module:modules[hybrid?3:1],entryPoint:hybrid?'MainHybridVS':'MainVS'},
    fragment:{module:modules[shaderCull?4:2],entryPoint:shaderCull?'MainCullPS':'MainPS',targets:[{format:'rg32uint'}]},
    primitive:{topology:'triangle-list',frontFace:'ccw',cullMode}});
   const pipelines=await Promise.all(['none','back','front'].map(c=>raster(c,false,false)));
   const hybrid=await raster('none',true,true),shaderCull=await raster('none',false,true);
   const textures=Array.from({length:3},()=>device.createTexture({size:[1024,512],format:'rg32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST}));
   const encoder=device.createCommandEncoder(),cs=encoder.beginComputePass();cs.setPipeline(compute);
   cs.setBindGroup(0,device.createBindGroup({layout:compute.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}},{binding:2,resource:{buffer:accepted}}]}));
   cs.dispatchWorkgroups(32);cs.end();
   encoder.copyBufferToTexture({buffer:output,bytesPerRow:8192},{texture:textures[1]},[1024,512]);
   for(let target=0;target<3;target++){
    const pass=encoder.beginRenderPass({colorAttachments:[{view:textures[target].createView(),loadOp:target===1?'load':'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
    if(target===0){
     // Independent fixed-function oracle: select actual GPU culling, without
     // using the shader helper under test to decide which face is visible.
     for(let i=0;i<2048;i++)if(flags[i]&1){const p=pipelines[flags[i]&2?0:flags[i]&4?2:1];
      pass.setPipeline(p);pass.setBindGroup(0,device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}}]}));pass.draw(3,1,0,i);}
    }else{const p=target===1?hybrid:shaderCull;pass.setPipeline(p);
     pass.setBindGroup(0,device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}}]}));pass.draw(3,2048);}
    pass.end();
   }
   const reads=textures.map(t=>{const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});encoder.copyTextureToBuffer({texture:t},{buffer:b,bytesPerRow:8192},[1024,512]);return b;});
   const a=device.createBuffer({size:accepted.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});encoder.copyBufferToBuffer(accepted,0,a,0,a.size);reads.push(a);
   device.queue.submit([encoder.finish()]);const values=[];
   for(const b of reads){await b.mapAsync(GPUMapMode.READ);values.push(Array.from(new Uint32Array(b.getMappedRange())));b.unmap();}
   const error=await device.popErrorScope();if(error)throw Error(error.message);return {values,errors};
  }finally{device.destroy();}
 },{codes,words:Array.from(words),flags});
 assert.deepEqual(r.errors,[]);const [native,mixed,pixel,accepted]=r.values;
 let covered=0,computePixels=0,maxDepthError=0;const failures=[];
 const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
 for(let i=0;i<1024*512;i++){
  if(native[i*2]!==mixed[i*2]||native[i*2]!==pixel[i*2])failures.push({pixel:i,native:native[i*2],mixed:mixed[i*2],shader:pixel[i*2]});
  if(native[i*2]){covered++;if(accepted[native[i*2]-1])computePixels++;
   maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(native[i*2+1])-asFloat(mixed[i*2+1])));}
 }
 const result={pass:!failures.length&&computePixels>100&&maxDepthError<3e-5,source:audit(__filename),sources:helpers.map(audit),tools:[dxc,tint].map(audit),
  products:['test.hlsl',...stages.flatMap(([,e])=>[e+'.spv',e+'.wgsl'])].map(f=>audit(path.join(out,f))),triangles:2048,
  computeTriangles:accepted.filter(Boolean).length,computePixels,covered,maxDepthError,failures:failures.slice(0,50),failureCount:failures.length};
 fs.writeFileSync(path.join(out,'verified.json'),JSON.stringify(result,null,2));console.log({pass:result.pass,covered,computePixels,maxDepthError,failures:result.failures});assert(result.pass);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
