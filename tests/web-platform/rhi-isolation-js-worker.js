'use strict';
async function run(){
 const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw Error('No adapter');
 const device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.lost.then(e=>{if(e.reason!=='destroyed')errors.push(e.message);});
 const check=()=>{if(errors.length)throw Error(errors.join('\n'));},summary=values=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[sorted.length>>1],meanMs:values.reduce((s,v)=>s+v,0)/values.length,samplesMs:values};};
 const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
 const vertex=new Float32Array(64*64),index=new Uint16Array(64*128),color=new Float32Array(64*64);
 for(let k=0;k<64;k++){vertex.set([-1,-1,3,-1,-1,3],k*64);index.set([0,1,2],k*128);color.set([((k*3+17)%256)/255,((k*5+31)%256)/255,((k*7+47)%256)/255,1],k*64);}
 const vertices=buffer(vertex,GPUBufferUsage.VERTEX),indices=buffer(index,GPUBufferUsage.INDEX),uniforms=buffer(color,GPUBufferUsage.UNIFORM);
 const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:16}}]}),pl=device.createPipelineLayout({bindGroupLayouts:[layout]});
 const groups=Array.from({length:64},(_,k)=>device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:uniforms,offset:k*256,size:16}}]}));
 const module=device.createShaderModule({code:'struct Color{value:vec4f}\n@group(0) @binding(0) var<uniform> color:Color;\n@vertex fn vs(@location(0) xy:vec2f)->@builtin(position) vec4f{return vec4f(xy,0,1);}\n@fragment fn fs0()->@location(0) vec4f{return color.value;}\n@fragment fn fs1()->@location(0) vec4f{return color.value.bgra;}'}),pipelines=[];
 for(let k=0;k<2;k++)pipelines.push(await device.createRenderPipelineAsync({layout:pl,vertex:{module,entryPoint:'vs',buffers:[{arrayStride:8,attributes:[{format:'float32x2',offset:0,shaderLocation:0}]}]},fragment:{module,entryPoint:k?'fs1':'fs0',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'}}));
 const target=device.createTexture({size:[64,64],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),view=target.createView(),pixels=device.createBuffer({size:64*256,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
 let encoder,pass;const bind=(k,p)=>{pass.setPipeline(pipelines[p]);pass.setBindGroup(0,groups[k]);pass.setVertexBuffer(0,vertices,k*256,24);pass.setIndexBuffer(indices,'uint16',k*256,6);};
 const begin=()=>{encoder=device.createCommandEncoder();pass=encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});pass.setViewport(0,0,64,64,0,1);pass.setScissorRect(0,0,1,1);bind(0,0);};
 const end=()=>{pass.end();device.queue.submit([encoder.finish()]);},wait=async()=>{await device.queue.onSubmittedWorkDone();check();};
 const verify=async rotating=>{const e=device.createCommandEncoder();e.copyTextureToBuffer({texture:target},{buffer:pixels,bytesPerRow:256,rowsPerImage:64},[64,64]);device.queue.submit([e.finish()]);await pixels.mapAsync(GPUMapMode.READ);const a=new Uint8Array(pixels.getMappedRange()),k=rotating?3199%64:0,b=[(k*3+17)%256,(k*5+31)%256,(k*7+47)%256,255];if(rotating)[b[0],b[2]]=[b[2],b[0]];if(b.some((v,c)=>Math.abs(v-a[c])>1)||a[4]!==0||a[7]!==0)throw Error('JS pixel mismatch');pixels.unmap();check();};
 await wait();const cases=[];
 for(const mode of ['rotating','repeat','cached']){
  const encode=[],finish=[];let start;
  for(let frame=0;frame<72;frame++){
   if(frame===12)start=performance.now();let t=performance.now();begin();
   for(let j=0;j<3200;j++){if(mode==='rotating')bind(j%64,j&1);else if(mode==='repeat'||j===0)bind(0,0);pass.drawIndexed(3,1,0,0,0);}
   const ms=performance.now()-t;t=performance.now();end();if(frame>=12){encode.push(ms);finish.push(performance.now()-t);}if(frame%3===2)await wait();
  }await wait();const wall=performance.now()-start;await verify(mode==='rotating');cases.push({mode,draws:3200,inFlight:3,encode:summary(encode),finishSubmit:summary(finish),wallMsPerFrame:wall/60,pixelVerified:true});
 }
 const creation=[];
 for(const n of [1,8,24]){
  const layout=device.createBindGroupLayout({entries:Array.from({length:n},(_,binding)=>({binding,visibility:0,buffer:{type:'uniform',minBindingSize:16}}))}),entries=Array.from({length:n},(_,binding)=>({binding,resource:{buffer:uniforms,offset:binding*256,size:16}})),samples=[];
  for(let frame=0;frame<46;frame++){const t=performance.now(),groups=[];for(let i=0;i<80;i++)groups.push(device.createBindGroup({layout,entries}));const ms=performance.now()-t;if(frame>=10)samples.push(ms);await wait();}creation.push({entries:n,groups:80,create:summary(samples)});
 }
 device.destroy();return {pass:true,backend:'browser-js-webgpu',cases,descriptorCreation:creation,boundary:'Same resources/draw API sequence as isolation GPU controls; no C++ preparation model. JS GC lifetime differs from explicit C handle release.'};
}
run().then(result=>postMessage({result})).catch(error=>postMessage({error:error.stack||String(error)}));
