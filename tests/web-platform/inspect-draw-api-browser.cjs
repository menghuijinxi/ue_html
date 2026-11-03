'use strict';
// Separate backend diagnostic. Tracing is never enabled for performance samples.
const fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/draw-api-backend-diagnostic'),
   {channel:'msedge',headless:false});
 try{
  const page=context.pages()[0],cdp=await context.browser().newBrowserCDPSession(),events=[];
  cdp.on('Tracing.dataCollected',e=>events.push(...e.value));
  await page.goto('http://127.0.0.1:8765/draw-api-benchmark.html');
  await cdp.send('Tracing.start',{categories:'gpu,disabled-by-default-gpu.dawn,toplevel',options:'record-until-full'});
  await page.evaluate(async()=>{
   const a=await navigator.gpu.requestAdapter({powerPreference:'high-performance'}),d=await a.requestDevice();
   const m=d.createShaderModule({code:`@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
    @fragment fn fs()->@location(0) vec4f{return vec4f(1,0,0,1);}`});
   const p=await d.createRenderPipelineAsync({layout:'auto',vertex:{module:m,entryPoint:'vs'},fragment:{module:m,entryPoint:'fs',targets:[{format:'rgba8unorm'}]}});
   const t=d.createTexture({size:[64,64],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT});
   for(let frame=0;frame<3;frame++){
    const e=d.createCommandEncoder(),r=e.beginRenderPass({colorAttachments:[{view:t.createView(),loadOp:'clear',storeOp:'store'}]});
    r.setScissorRect(0,0,1,1);r.setPipeline(p);for(let j=0;j<3200;j++)r.draw(3);r.end();
    d.queue.submit([e.finish()]);await d.queue.onSubmittedWorkDone();
   }d.destroy();
  });
  const complete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');await complete;
  const file=path.join(__dirname,'results/draw-api-browser-backend-trace.json');fs.writeFileSync(file,JSON.stringify({traceEvents:events}));
  const names=[...new Set(events.map(e=>e.name))].filter(n=>/D3D|Dawn|WebGPU/.test(n));
  console.log(JSON.stringify({file,eventCount:events.length,names},null,2));
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
