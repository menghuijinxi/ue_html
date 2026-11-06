'use strict';
// Capability and GPU readback, not a performance benchmark. No experimental flags.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const tag=process.argv.find(v=>v.startsWith('--tag='))?.slice(6);
assert(tag&&/^[a-z0-9-]+$/.test(tag));
const output=path.join(__dirname,'results',tag+'.json');assert(!fs.existsSync(output));
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:false});
  try {
    const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/');
    const report=await page.evaluate(async()=>{
      const adapter=await navigator.gpu.requestAdapter();
      const result={userAgent:navigator.userAgent,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture},
        languageFeatures:[...navigator.gpu.wgslLanguageFeatures],features:[...adapter.features],
        maxImmediateSize:adapter.limits.maxImmediateSize??null,validation:null,values:null};
      result.supported=navigator.gpu.wgslLanguageFeatures.has('immediate_address_space')&&
        typeof GPUComputePassEncoder.prototype.setImmediates==='function';
      if(!result.supported)return result;
      const device=await adapter.requestDevice();device.pushErrorScope('validation');
      try {
        const buffer=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
        const read=device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
        const module=device.createShaderModule({code:`requires immediate_address_space;
          var<immediate> value:vec4u;
          @group(0) @binding(0) var<storage,read_write> output:array<u32>;
          @compute @workgroup_size(4) fn main(@builtin(local_invocation_index) i:u32){output[i]=value[i]*3u;}`});
        const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.setImmediates(0,new Uint32Array([7,8,9,10]));
        pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(buffer,0,read,0,16);
        device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        result.values=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();
        result.validation=(await device.popErrorScope())?.message??null;
      } finally {device.destroy();}
      return result;
    });
    if(report.supported){assert.deepEqual(report.values,[21,24,27,30]);assert.equal(report.validation,null);}
    fs.writeFileSync(output,JSON.stringify({date:new Date().toISOString(),pass:true,...report},null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
