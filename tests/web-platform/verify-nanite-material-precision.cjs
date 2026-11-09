'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const verifyInputs=require('./verify-nanite-material-inputs.cjs');
const root=path.resolve(__dirname,'../..'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const failureFile=path.join(__dirname,'results/nanite-browser/failure-gbuffer-jitter-precision-20261109.json');
const failure=read(failureFile),frame=failure.sceneGBuffer.find(s=>s.step===24);
assert(!failure.pass&&frame.validationFailure.includes('63,31 position[0]'));
const archived=path.join(__dirname,'results/nanite-browser/failure-gbuffer-jitter-precision');
const words=file=>{const b=fs.readFileSync(file);return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
const inputs=['before','materialInputs','tilePixels'].map(key=>{
  const file=path.join(archived,path.basename(frame.products[key].file));
  assert.equal(audit(file).sha256,frame.products[key].sha256);return audit(file);
});
const before=words(inputs[0].file),original=words(inputs[1].file),pixels=words(inputs[2].file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),packaged=read(packageFile);
const gpuPage=packaged.multiMaterial.gpuPage;assert.equal(audit(gpuPage.file).sha256,gpuPage.sha256);
const oldFile=path.join(archived,'before.wgsl');
assert(failure.materialShaders.some(s=>s.sha256===audit(oldFile).sha256));
const conversion=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const newInput=fs.readdirSync(conversion).map(n=>path.join(conversion,n,'input.json')).filter(fs.existsSync)
  .filter(f=>read(f).shaderName==='FWebNaniteMaterialInputsCS').sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
assert(newInput);const compiled=read(newInput),newFile=path.join(path.dirname(newInput),'output.wgsl');
const bindings=compiled.metadata.spirvBindings,globals=bindings.find(b=>b.name==='$Globals');
assert.equal(globals.size,144);assert.equal(bindings.length,6);
const uniforms=frame.entries.map(e=>{
  const bytes=Buffer.alloc(globals.size);
  const set=(name,values,float=false)=>{const member=globals.members.find(m=>m.name===name);assert(member);values.forEach((v,i)=>bytes[float?'writeFloatLE':'writeUInt32LE'](v,member.offset+i*4));};
  set('PageConstants',[0,0,0,0]);set('MaxVisibleClusters',[e.keys.length]);
  set('WebRasterLocalToClip',Array.from({length:16},(_,i)=>Math.fround([0,1,2,3].reduce((sum,k)=>sum+
    e.localToWorld[Math.floor(i/4)*4+k]*frame.worldToClip[k*4+i%4],0))),true);
  assert(e.keys.slice(0,e.state[0]).every(k=>(k>>>8)===0));
  set('WebRasterClusterBase',[e.clusterBase]);set('WebRasterFirstPage',[0]);set('WebRasterNumPages',[1]);set('WebRasterInstanceId',[e.instanceId]);
  set('WebMaterialRect',frame.rect);set('WebMaterialSize',[frame.materialWidth,frame.materialHeight]);
  set('WebMaterialStride',[frame.materialStride]);set('WebMaterialPitch',[frame.rect[2]]);
  return {bytes:[...bytes],state:e.state};
});
const shaders=[oldFile,newFile].map(file=>{const source=fs.readFileSync(file,'utf8');return {source,entry:/fn (main_\w+)\(/.exec(source)[1]};});
const output=path.join(__dirname,'results/nanite-material-precision');fs.mkdirSync(output,{recursive:true});
const build=path.join(__dirname,'build/nanite-material-precision');fs.mkdirSync(build,{recursive:true});
fs.writeFileSync(path.join(build,'index.html'),'<!doctype html><title>Nanite material precision replay</title>');
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/nanite-material-precision/index.html');
    const replay=await page.evaluate(async ({shaders,uniforms,bindings,gpuPage,records,pixels,width,height,sampleCount})=>{
      const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required');
      const device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const buffers=[];
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);buffers.push(b);return b;};
      try {
        const vis=new Uint32Array(width*height*2);for(let i=0;i<pixels.length;i+=4){vis[pixels[i]*2]=pixels[i+1];vis[pixels[i]*2+1]=pixels[i+2];}
        const shared={ClusterPageData:make(new Uint8Array(gpuPage),GPUBufferUsage.STORAGE),
          VisibleClustersSWHW:make(new Uint32Array(records),GPUBufferUsage.STORAGE),WebMaterialVisibility:make(vis,GPUBufferUsage.STORAGE)};
        const results=[];
        for(const shader of shaders){
          device.pushErrorScope('validation');const module=device.createShaderModule({code:shader.source});
          const messages=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(messages.length)throw Error(messages.map(m=>m.message).join('\n'));
          const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:shader.entry}});
          const out=device.createBuffer({size:sampleCount*64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(out);
          const command=device.createCommandEncoder();
          for(const uniform of uniforms){
            const resources={...shared,WebMaterialOutput:out,$Globals:make(new Uint8Array(uniform.bytes),GPUBufferUsage.UNIFORM),WebRasterCullState:make(new Uint32Array(uniform.state),GPUBufferUsage.STORAGE)};
            const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:bindings.map(b=>({binding:b.binding,resource:{buffer:resources[b.name]}}))});
            const pass=command.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(width/8/8),Math.ceil(height/8/8));pass.end();
          }
          const readback=device.createBuffer({size:sampleCount*64,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});buffers.push(readback);
          command.copyBufferToBuffer(out,0,readback,0,sampleCount*64);device.queue.submit([command.finish()]);await readback.mapAsync(GPUMapMode.READ);
          results.push(Array.from(new Uint32Array(readback.getMappedRange())));readback.unmap();
          const error=await device.popErrorScope();if(error)throw Error(error.message);
        }
        if(errors.length)throw Error(errors.join('\n'));return {results,adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture}};
      } finally {buffers.forEach(b=>b.destroy());device.destroy();}
    },{shaders,uniforms,bindings,gpuPage:[...fs.readFileSync(gpuPage.file)],records:frame.visibleRecords,pixels,
      width:frame.rect[2],height:frame.rect[3],sampleCount:frame.materialWidth*frame.materialHeight});
    assert.deepEqual(replay.results[0],original,'Old shader must reproduce the recorded GPU material inputs bit for bit');
    const raw={...frame,sampledVisibility:before.filter((_,i)=>i%28===0)},tolerances={position:1/512,normal:1/25600,uv:.000008,color:.000001};
    assert.throws(()=>verifyInputs({...raw,materialInputs:replay.results[0]},fs.readFileSync(gpuPage.file),tolerances),/63,31 position\[0\]/);
    const validation=verifyInputs({...raw,materialInputs:replay.results[1]},fs.readFileSync(gpuPage.file),tolerances);
    const products=replay.results.map((words,i)=>{const file=path.join(output,i?'fixed.bin':'original.bin'),b=Buffer.alloc(words.length*4);words.forEach((v,j)=>b.writeUInt32LE(v,j*4));fs.writeFileSync(file,b);return audit(file);});
    const report={pass:true,adapter:replay.adapter,oldBitExact:true,oldFailure:frame.validationFailure,validation,tolerances,products,
      inputs:[audit(failureFile),...inputs,gpuPage,audit(oldFile),audit(newInput),audit(newFile)],
      sources:[__filename,require.resolve('./verify-nanite-material-inputs.cjs'),path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteRaster.usf')].map(audit),
      hierarchy:audit(path.join(__dirname,'results/nanite-hierarchy-shaders/verified.json')),
      boundary:'Replays the recorded failing visibility, transforms, jitter and Nanite page through old and newly compiled production material-input shaders. The old shader must match the captured output; fixed output must satisfy the unchanged independent attribute tolerances.'};
    fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,oldBitExact:true,validation}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
