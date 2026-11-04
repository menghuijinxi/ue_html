'use strict';
// The JS and C API versions use identical precreated resources and commands.
async function run() {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter?.features.has('timestamp-query')) throw new Error('No timestamp-capable WebGPU adapter');
  const device = await adapter.requestDevice({requiredFeatures: ['timestamp-query']});
  const errors = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.lost.then(e => {if (e.reason !== 'destroyed') errors.push(e.message);});
  const check = () => {if (errors.length) throw new Error(errors.join('\n'));};
  const summary = a => {const b = [...a].sort((a,b) => a-b);return {meanMs: b.reduce((a,b)=>a+b,0)/b.length,
    medianMs: b[Math.floor(b.length/2)],p95Ms: b[Math.floor((b.length-1)*.95)],samplesMs: a};};
  const data = new Float32Array(64*64), ix = new Uint16Array(64*128), colors = new Float32Array(64*64);
  for (let k=0;k<64;k++) {data.set([-1,-1,3,-1,-1,3],k*64);ix.set([0,1,2],k*128);
    colors.set([((k*3+17)%256)/255,((k*5+31)%256)/255,((k*7+47)%256)/255,1],k*64);}
  const buffer = (size,usage,data) => {const b=device.createBuffer({size,usage:usage|(data?GPUBufferUsage.COPY_DST:0)});
    if(data)device.queue.writeBuffer(b,0,data);return b;};
  const vertices=buffer(data.byteLength,GPUBufferUsage.VERTEX,data), indices=buffer(ix.byteLength,GPUBufferUsage.INDEX,ix),
    uniforms=buffer(colors.byteLength,GPUBufferUsage.UNIFORM,colors);
  const target=device.createTexture({size:[64,64],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),view=target.createView();
  const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:16}}]});
  const pl=device.createPipelineLayout({bindGroupLayouts:[layout]});
  const groups=Array.from({length:64},(_,k)=>device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:uniforms,offset:k*256,size:16}}]}));
  const module=device.createShaderModule({code:`struct Color { value:vec4f }
    @group(0) @binding(0) var<uniform> color:Color;
    @vertex fn vs(@location(0) xy:vec2f)->@builtin(position) vec4f{return vec4f(xy,0.0,1.0);}
    @fragment fn fs0()->@location(0) vec4f{return color.value;}
    @fragment fn fs1()->@location(0) vec4f{return color.value.bgra;}`});
  const pipelines=[];
  for (let k=0;k<2;k++) pipelines.push(await device.createRenderPipelineAsync({layout:pl,
    vertex:{module,entryPoint:'vs',buffers:[{arrayStride:8,attributes:[{format:'float32x2',offset:0,shaderLocation:0}]}]},
    fragment:{module,entryPoint:k?'fs1':'fs0',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list',cullMode:'none'}}));
  const queries=device.createQuerySet({type:'timestamp',count:2}),resolve=buffer(256,GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC),
    readback=buffer(256,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),pixels=buffer(64*256,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
  let encoder,pass,commands,bundle=null,timed=false;
  const bind=(p,k,pipeline)=>{p.setPipeline(pipelines[pipeline]);p.setBindGroup(0,groups[k]);p.setVertexBuffer(0,vertices,k*256,24);p.setIndexBuffer(indices,'uint16',k*256,6);};
  const begin=timing=>{timed=timing;encoder=device.createCommandEncoder();pass=encoder.beginRenderPass({
    colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}],
    ...(timed?{timestampWrites:{querySet:queries,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{})});
    pass.setViewport(0,0,64,64,0,1);pass.setScissorRect(0,0,1,1);bind(pass,0,0);};
  const emit=(mode,n)=>{
    if(mode===2){pass.executeBundles([bundle]);return;}
    if(mode===3){pass.drawIndexed(3,n,0,0,0);return;}
    if(mode===0){for(let j=0;j<n;j++)pass.drawIndexed(3,1,0,0,0);return;}
    for(let j=0;j<n;j++){bind(pass,j%64,j&1);pass.drawIndexed(3,1,0,0,0);}
  };
  const end=()=>{pass.end();if(timed){encoder.resolveQuerySet(queries,0,2,resolve,0);encoder.copyBufferToBuffer(resolve,0,readback,0,16);}
    commands=encoder.finish();};
  const submit=()=>device.queue.submit([commands]);
  const wait=async()=>{await device.queue.onSubmittedWorkDone();check();};
  await wait();
  const report={backend:'browser-js-webgpu',adapter: {...adapter.info},warmupFrames:12,measuredFrames:60,inFlight:3,cases:[]};
  // GPUAdapterInfo properties are prototype accessors and need explicit copying.
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description};
  for(const n of [1000,3200,10000])for(let mode=0;mode<4;mode++){
    let bundleBuildMs=0;
    if(mode===2){const t=performance.now(),b=device.createRenderBundleEncoder({colorFormats:['rgba8unorm']});
      bind(b,0,0);for(let j=0;j<n;j++){bind(b,j%64,j&1);b.drawIndexed(3,1,0,0,0);}bundle=b.finish();bundleBuildMs=performance.now()-t;}
    for(let j=0;j<12;j++){begin(false);emit(mode,n);end();submit();if(j%3===2)await wait();}await wait();
    const setup=[],draw=[],finish=[],submits=[],gpu=[],wall=performance.now();
    for(let j=0;j<60;j++){
      let t=performance.now();begin(false);setup.push(performance.now()-t);t=performance.now();emit(mode,n);draw.push(performance.now()-t);
      t=performance.now();end();finish.push(performance.now()-t);t=performance.now();submit();submits.push(performance.now()-t);
      if(j%3===2)await wait();
    }await wait();const wallMs=performance.now()-wall;
    for(let j=0;j<10;j++){begin(true);emit(mode,n);end();submit();await wait();await readback.mapAsync(GPUMapMode.READ,0,16);
      const a=new BigUint64Array(readback.getMappedRange(0,16));gpu.push(Number(a[1]-a[0])/1e6);readback.unmap();}
    const e=device.createCommandEncoder();e.copyTextureToBuffer({texture:target},{buffer:pixels,bytesPerRow:256,rowsPerImage:64},[64,64]);
    device.queue.submit([e.finish()]);await pixels.mapAsync(GPUMapMode.READ);const p=new Uint8Array(pixels.getMappedRange());
    const k=(mode===1||mode===2)?(n-1)%64:0,expected=[(k*3+17)%256,(k*5+31)%256,(k*7+47)%256,255];
    if((mode===1||mode===2)&&((n-1)&1))[expected[0],expected[2]]=[expected[2],expected[0]];
    if(expected.some((v,c)=>Math.abs(p[c]-v)>1)||p[4]!==0||p[7]!==0)throw new Error('Rendered pixel mismatch');
    pixels.unmap();check();
    report.cases.push({draws:n,mode,bundleBuildMs,wallMs,batch3WallMsPerFrame:wallMs/60,setup:summary(setup),
      drawLoop:summary(draw),finish:summary(finish),submit:summary(submits),gpu:summary(gpu),outputVerified:true});
    postMessage({progress:`JS mode=${mode} draws=${n} done`});
  }
  report.pass=true;device.destroy();return report;
}
run().then(result=>postMessage({result})).catch(e=>postMessage({error:e.stack||String(e)}));
