'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-depth-gather');
fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
    const result=await page.evaluate(async()=>{
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter||adapter.info.isFallbackAdapter)throw new Error('Hardware WebGPU required');
      const device=await adapter.requestDevice(),errors=[];
      device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      try {
        const uvs=[[.5,.5],[0,0],[1,1],[.375,.625],[.99,.01],[-.1,.6]];
        const point=device.createSampler({addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
        const layout=device.createBindGroupLayout({entries:[
          {binding:0,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
          {binding:1,visibility:GPUShaderStage.COMPUTE,sampler:{type:'non-filtering'}},
          {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]});
        const module=device.createShaderModule({code:`
          @group(0) @binding(0) var depth:texture_2d<f32>;
          @group(0) @binding(1) var point:sampler;
          @group(0) @binding(2) var<storage,read_write> result:array<vec4f>;
          @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
            let uv=array<vec2f,${uvs.length}>(${uvs.map(uv=>`vec2f(${uv.join(',')})`).join(',')});
            result[id.x]=textureGather(0,depth,point,uv[id.x]);}`});
        const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'main'}});
        const raster=device.createShaderModule({code:`
          @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
            let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
          @fragment fn ps(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
            return (floor(p.x)+4*floor(p.y)+1)/17;}`});
        const cases=[];
        for(const format of ['depth24plus','depth32float']) {
          device.pushErrorScope('validation');
          const texture=device.createTexture({size:[4,4],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
          const draw=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:raster,entryPoint:'vs'},
            fragment:{module:raster,entryPoint:'ps',targets:[]},depthStencil:{format,depthWriteEnabled:true,depthCompare:'always'}});
          const values=device.createBuffer({size:uvs.length*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
          const readback=device.createBuffer({size:uvs.length*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
          const group=device.createBindGroup({layout,entries:[{binding:0,resource:texture.createView()},
            {binding:1,resource:point},{binding:2,resource:{buffer:values}}]});
          const encoder=device.createCommandEncoder();
          const render=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:texture.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:0}});
          render.setPipeline(draw);render.draw(3);render.end();
          const compute=encoder.beginComputePass();compute.setPipeline(pipeline);compute.setBindGroup(0,group);compute.dispatchWorkgroups(uvs.length);compute.end();
          encoder.copyBufferToBuffer(values,0,readback,0,uvs.length*16);device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);const actual=Array.from(new Float32Array(readback.getMappedRange()));readback.unmap();
          const error=await device.popErrorScope();if(error)throw new Error(error.message);
          cases.push({format,actual});texture.destroy();values.destroy();readback.destroy();
        }
        return {cases,uvs,errors};
      }finally{device.destroy();}
    });
    assert.deepEqual(result.errors,[]);
    const clamp=v=>Math.min(3,Math.max(0,v));
    const expected=result.uvs.flatMap(([u,v])=>{
      const x=Math.floor(u*4-.5),y=Math.floor(v*4-.5);
      return [[x,y+1],[x+1,y+1],[x+1,y],[x,y]].map(([i,j])=>(clamp(i)+4*clamp(j)+1)/17);
    });
    for(const c of result.cases){
      assert.equal(c.actual.length,expected.length);
      c.maxError=Math.max(...c.actual.map((v,i)=>Math.abs(v-expected[i])));
      assert(c.maxError<1e-6,JSON.stringify(c));
    }
    const report={pass:true,date:new Date().toISOString(),...result,expected,source:audit(__filename),
      shaderSources:['Common.ush','SceneTexturesCommon.ush'].map(n=>audit(path.join(root,'reference-engine/Engine/Shaders/Private',n)))};
    fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({pass:true,cases:result.cases.map(c=>({format:c.format,maxError:c.maxError}))}));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
