'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const input=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>read(f).shaderName==='FWebNaniteHZBBuildCS').sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];assert(input);
const shader=path.join(path.dirname(input),'output.wgsl'),metadata=read(input).metadata;
const source=metadata.spirvBindings.find(b=>b.name==='WebHZBSource');assert.equal(source.sampledTextureLoadOnly,true);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try {
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await page.evaluate(async ({code,metadata})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));try {
   const b=Object.fromEntries(metadata.spirvBindings.map(v=>[v.name,v])),globals=b.$Globals;
   const layout=device.createBindGroupLayout({entries:[
    {binding:globals.binding,visibility:4,buffer:{type:'uniform',minBindingSize:globals.paddedSize}},
    {binding:b.WebHZBSource.binding,visibility:4,texture:{sampleType:b.WebHZBSource.sampledTextureLoadOnly?'unfilterable-float':'float'}},
    {binding:b.WebHZBTarget.binding,visibility:4,storageTexture:{access:'write-only',format:'r32float'}}]});
   const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code}),entryPoint:metadata.webEntry}}),cases=[];
   for(const format of ['depth24plus','depth32float','r32float']) {
    device.pushErrorScope('validation');const color=format==='r32float';
    const input=device.createTexture({size:[64,32],format,usage:GPUTextureUsage.TEXTURE_BINDING|(color?GPUTextureUsage.COPY_DST:GPUTextureUsage.RENDER_ATTACHMENT)});
    const target=device.createTexture({size:[64,32],format:'r32float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC});
    if(color)device.queue.writeTexture({texture:input},new Float32Array(64*32).fill(.75),{bytesPerRow:256},[64,32]);
    const data=new Uint32Array(globals.paddedSize/4),values={WebHZBTargetSize:[64,32],WebHZBBuildRect:[3,5,61,29],WebHZBReduce:[0]};
    for(const m of globals.members)data.set(values[m.name],m.offset/4);
    const config=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(config,0,data);
    const read=device.createBuffer({size:256*32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=device.createCommandEncoder();
    if(!color)enc.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:input.createView(),depthClearValue:.75,depthLoadOp:'clear',depthStoreOp:'store'}}).end();
    const pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout,entries:[
     {binding:globals.binding,resource:{buffer:config}},{binding:b.WebHZBSource.binding,resource:input.createView()},
     {binding:b.WebHZBTarget.binding,resource:target.createView()}]}));pass.dispatchWorkgroups(8,4);pass.end();
    enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256},[64,32]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const valuesOut=Array.from(new Float32Array(read.getMappedRange()));read.unmap();const error=await device.popErrorScope();if(error)throw Error(error.message);
    cases.push({format,values:valuesOut});for(const v of [input,target,config,read])v.destroy();
   }
   return {cases,errors,features:[...device.features]};
  }finally{device.destroy();}
 },{code:fs.readFileSync(shader,'utf8'),metadata});
 assert.deepEqual(result.errors,[]);for(const c of result.cases){let maxError=0;c.values.forEach((v,i)=>{const x=i%64,y=Math.floor(i/64),expected=x>=3&&x<61&&y>=5&&y<29?.75:0;maxError=Math.max(maxError,Math.abs(v-expected));});assert(maxError<=1/16777215);delete c.values;c.maxError=maxError;c.pass=true;}
 const report={pass:true,...result,source:audit(__filename),inputs:[input,shader].map(audit),sources:[
  path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp'),
  path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPUShaderFormat.dll')].map(audit)};
 const out=path.join(__dirname,'results/nanite-hzb-bindings.json');fs.writeFileSync(out,JSON.stringify(report,null,2));console.log({pass:true,cases:result.cases});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
