'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:8765/',{waitUntil:'commit'});
    const result=await page.evaluate(async()=>{
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter) throw Error('WebGPU adapter unavailable');
      const device=await adapter.requestDevice();
      const usage=GPUTextureUsage.TRANSIENT_ATTACHMENT;
      let validation=null;
      if(usage!==undefined) {
        device.pushErrorScope('validation');
        const texture=device.createTexture({size:[1,1],format:'rgba8unorm',
          usage:GPUTextureUsage.RENDER_ATTACHMENT|usage});
        const encoder=device.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),
          loadOp:'clear',storeOp:'discard',clearValue:[0,0,0,0]}]});
        pass.end();device.queue.submit([encoder.finish()]);
        validation=(await device.popErrorScope())?.message||null;
        texture.destroy();
      }
      const result={adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture},
        asyncRenderPipelineAPI:typeof device.createRenderPipelineAsync==='function',
        asyncComputePipelineAPI:typeof device.createComputePipelineAsync==='function',
        transientAttachmentUsage:usage??null,transientAttachmentRenderPassAccepted:usage!==undefined&&!validation,
        validation,boundary:'API capability probe only. Does not enable UE precaching, RDG allocator or heap aliasing.'};
      device.destroy();return result;
    });
    const report={date:new Date().toISOString(),browserVersion:browser.version(),...result};
    fs.writeFileSync(path.join(__dirname,'results/webgpu-optimization-capabilities.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
