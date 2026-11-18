'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),out=path.join(__dirname,'results/nanite-micro-raster'),helper=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteMicroRaster.ush');
fs.mkdirSync(out,{recursive:true});
const source=fs.readFileSync(helper,'utf8').replace('#pragma once','')+`
struct Triangle { float4 A; float4 B; float4 C; };
[[vk::binding(0,0)]] StructuredBuffer<Triangle> Triangles;
[[vk::binding(1,0)]] RWStructuredBuffer<uint2> Pixels;
[[vk::binding(2,0)]] RWStructuredBuffer<uint> Accepted;
[numthreads(64,1,1)] void MainCS(uint3 I:SV_DispatchThreadID) {
 if(I.x>=2056)return;Triangle T=Triangles[I.x];int2 P0,P1,P2,F,L;float3 Z;
 if(!WebPrepareMicroTriangle(T.A,T.B,T.C,uint4(0,0,1024,512),I.x==2054?0:I.x==2055?9:8,P0,P1,P2,Z,F,L))return;
 Accepted[I.x]=1;
 for(int Y=F.y;Y<=L.y;Y++)for(int X=F.x;X<=L.x;X++) {
  float Depth;if(WebMicroCovered(P0,P1,P2,Z,int2(X-F.x,Y-F.y)*256+128,Depth))
   Pixels[Y*1024+X]=uint2(I.x+1,asuint(Depth));
 }
}
struct Vertex { float4 Position:SV_Position; nointerpolation uint ID:TEXCOORD0; };
Vertex MainVS(uint V:SV_VertexID,uint I:SV_InstanceID) {
 Triangle T=Triangles[I];Vertex O;O.Position=V==0?T.A:V==1?T.B:T.C;O.ID=I+1;return O;
}
Vertex MainHybridVS(uint V:SV_VertexID,uint I:SV_InstanceID) {
 Triangle T=Triangles[I];int2 P0,P1,P2,F,L;float3 Z;
 Vertex O=MainVS(V,I);
 if(WebPrepareMicroTriangle(T.A,T.B,T.C,uint4(0,0,1024,512),8,P0,P1,P2,Z,F,L))O.Position=float4(0,0,-1,1);
 return O;
}
uint2 MainPS(Vertex I):SV_Target0 { return uint2(I.ID,asuint(I.Position.z)); }
`;
fs.writeFileSync(path.join(out,'test.hlsl'),source);
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),codes=[];
for(const stage of ['cs','vs','ps','hybrid']){
 const base=path.join(out,stage),entry=stage==='hybrid'?'MainHybridVS':'Main'+stage.toUpperCase();
 cp.execFileSync(dxc,['-T',(stage==='hybrid'?'vs':stage)+'_6_0','-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-Fo',base+'.spv',path.join(out,'test.hlsl')],{windowsHide:true});
 cp.execFileSync(tint,['--format','wgsl','-o',base+'.wgsl',base+'.spv'],{windowsHide:true});codes.push(fs.readFileSync(base+'.wgsl','utf8'));
}
let seed=0x87654321;const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296),triangles=[];
for(let i=0;i<2048;i++){
 const cell=i%4===1?i-1:i;const x=(cell%64)*16+3,y=Math.floor(cell/64)*16+3,depth=.1+rand()*.8;
 let coords=Array.from({length:3},()=>[x+rand()*7,y+rand()*7]);
 if(i%4===0)coords=[[x+.5,y+.5],[x+7.5,y+.5],[x+.5,y+7.5]];
 if(i%4===1)coords=[[x+7.5,y+.5],[x+7.5,y+7.5],[x+.5,y+7.5]];
 if(i%11===0)coords[2]=coords[1];
 if(i%2)coords.reverse();
 for(const [px,py] of coords){const w=i%3?1:.5+rand()*2;triangles.push((px/1024*2-1)*w,(1-py/512*2)*w,(depth+rand()*.05)*w,w);}
}
const invalid=Array.from({length:8},()=>triangles.slice(0,12));
invalid[0][4]+=.1;invalid[1][3]=-1;invalid[2][2]=-.1;invalid[3][2]=2;
invalid[4][0]=2;invalid[5][0]=NaN;triangles.push(...invalid.flat());
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await tab.evaluate(async ({codes,triangles})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try {
   const data=new Float32Array(triangles),input=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,data);
   const output=device.createBuffer({size:1024*512*8,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const accepted=device.createBuffer({size:2056*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
   const compute=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:codes[0]}),entryPoint:'MainCS'}});
   const raster=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:device.createShaderModule({code:codes[1]}),entryPoint:'MainVS'},fragment:{module:device.createShaderModule({code:codes[2]}),entryPoint:'MainPS',targets:[{format:'rg32uint'}]},primitive:{topology:'triangle-list',cullMode:'none'}});
   const hybrid=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:device.createShaderModule({code:codes[3]}),entryPoint:'MainHybridVS'},fragment:{module:device.createShaderModule({code:codes[2]}),entryPoint:'MainPS',targets:[{format:'rg32uint'}]},primitive:{topology:'triangle-list',cullMode:'none'}});
   const target=device.createTexture({size:[1024,512],format:'rg32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
   const mixed=device.createTexture({size:[1024,512],format:'rg32uint',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});
   const enc=device.createCommandEncoder(),cs=enc.beginComputePass();cs.setPipeline(compute);cs.setBindGroup(0,device.createBindGroup({layout:compute.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}},{binding:2,resource:{buffer:accepted}}]}));cs.dispatchWorkgroups(33);cs.end();
   const ps=enc.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});ps.setPipeline(raster);ps.setBindGroup(0,device.createBindGroup({layout:raster.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}}]}));ps.draw(3,2048);ps.end();
   enc.copyBufferToTexture({buffer:output,bytesPerRow:8192},{texture:mixed},[1024,512]);
   const fallback=enc.beginRenderPass({colorAttachments:[{view:mixed.createView(),loadOp:'load',storeOp:'store'}]});fallback.setPipeline(hybrid);fallback.setBindGroup(0,device.createBindGroup({layout:hybrid.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}}]}));fallback.draw(3,2048);fallback.end();
   const reads=[output,accepted].map(b=>{const r=device.createBuffer({size:b.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyBufferToBuffer(b,0,r,0,b.size);return r;});
   const hw=device.createBuffer({size:output.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});reads.push(hw);enc.copyTextureToBuffer({texture:target},{buffer:hw,bytesPerRow:8192},[1024,512]);
   const merged=device.createBuffer({size:output.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});reads.push(merged);enc.copyTextureToBuffer({texture:mixed},{buffer:merged,bytesPerRow:8192},[1024,512]);
   device.queue.submit([enc.finish()]);const values=[];for(const b of reads){await b.mapAsync(GPUMapMode.READ);values.push(Array.from(new Uint32Array(b.getMappedRange())));b.unmap();}
   const error=await device.popErrorScope();if(error)throw Error(error.message);return {values,errors,features:[...device.features]};
  }finally{device.destroy();}
 },{codes,triangles});
 assert.deepEqual(result.errors,[]);const [compute,accepted,hw,sw]=result.values;const computeTriangles=accepted.slice(0,2048).filter(Boolean).length;assert(computeTriangles>512);assert(accepted.slice(2048).every(v=>v===0));
 const f=new Float32Array(1),u=new Uint32Array(f.buffer),asFloat=v=>{u[0]=v;return f[0];};
 let covered=0,maxDepthError=0,mismatches=[];
 for(let i=0;i<1024*512;i++){
  if(sw[i*2]!==hw[i*2])mismatches.push({x:i%1024,y:Math.floor(i/1024),sw:sw[i*2],hw:hw[i*2]});
  if(hw[i*2]&&sw[i*2]){covered++;maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(sw[i*2+1])-asFloat(hw[i*2+1])));}
 }
 const report={source:audit(__filename),sources:[helper].map(audit),tools:[dxc,tint].map(audit),products:['test.hlsl',...['cs','vs','ps','hybrid'].flatMap(s=>[s+'.spv',s+'.wgsl'])].map(f=>audit(path.join(out,f))),pass:!mismatches.length&&maxDepthError<3e-5,triangles:2048,computeTriangles,hardwareFallbackTriangles:2048-computeTriangles,rejectedInputs:8,sharedEdges:512,covered,maxDepthError,mismatches,features:result.features};
 fs.writeFileSync(path.join(out,'verified.json'),JSON.stringify(report,null,2));console.log({...report,mismatches:mismatches.slice(0,12)});assert(report.pass);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
