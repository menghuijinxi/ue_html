'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),install=require('./web-compute-pass-merge.cjs');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:false});
  try {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:8765/');
    await page.evaluate(install);
    const result=await page.evaluate(async()=>{
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
      const errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      device.pushErrorScope('validation');
      const storage=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      const uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(uniform,0,new Uint32Array([7,0,0,0]));
      const read=()=>device.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
      const first=read(),second=read();
      const l0=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]});
      const l1=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}]});
      const g0=device.createBindGroup({layout:l0,entries:[{binding:0,resource:{buffer:storage}}]});
      const g1=device.createBindGroup({layout:l1,entries:[{binding:0,resource:{buffer:uniform}}]});
      const common='@group(0) @binding(0) var<storage,read_write> a:array<u32>;';
      const pipeline=(code,layouts)=>device.createComputePipeline({layout:device.createPipelineLayout({bindGroupLayouts:layouts}),
        compute:{module:device.createShaderModule({code:common+code}),entryPoint:'main'}});
      const a=pipeline('@group(1) @binding(0) var<uniform> n:vec4<u32>; @compute @workgroup_size(4) fn main(@builtin(local_invocation_index) i:u32){a[i]=i+n.x;}',[l0,l1]);
      const b=pipeline('@compute @workgroup_size(4) fn main(@builtin(local_invocation_index) i:u32){a[i]*=3u;}',[l0]);
      const encoder=device.createCommandEncoder();
      let pass=encoder.beginComputePass();pass.setPipeline(a);pass.setBindGroup(0,g0);pass.setBindGroup(1,g1);pass.dispatchWorkgroups(1);pass.end();
      pass=encoder.beginComputePass();pass.setPipeline(b);pass.setBindGroup(0,g0);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(storage,0,first,0,16);
      pass=encoder.beginComputePass({label:'explicit descriptor must remain independent'});pass.setPipeline(b);pass.setBindGroup(0,g0);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(storage,0,second,0,16);
      // Finish must close a final deferred pass, even without an intervening copy.
      pass=encoder.beginComputePass();pass.setPipeline(b);pass.setBindGroup(0,g0);pass.dispatchWorkgroups(1);pass.end();
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      await Promise.all([first.mapAsync(GPUMapMode.READ),second.mapAsync(GPUMapMode.READ)]);
      const values=[Array.from(new Uint32Array(first.getMappedRange())),Array.from(new Uint32Array(second.getMappedRange()))];
      const validation=await device.popErrorScope();
      const counters={...__webComputePassMerge};device.destroy();
      return {values,counters,errors,validation:validation?.message||null};
    });
    assert.deepEqual(result.values,[[21,24,27,30],[63,72,81,90]]);
    assert.deepEqual(result.errors,[]);assert.equal(result.validation,null);
    assert.equal(result.counters.reused,1);assert.equal(result.counters.opened,2);assert.equal(result.counters.closed,2);
    fs.writeFileSync(path.join(__dirname,'results/compute-pass-merge-gpu-20261106.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
