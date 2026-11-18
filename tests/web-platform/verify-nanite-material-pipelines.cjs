'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const out=path.join(__dirname,'results/nanite-materials'),conversion=path.join(out,'conversion');
const shaders=fs.readdirSync(conversion,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>{
 const base=path.join(conversion,d.name),input=path.join(base,'input.json'),wgsl=path.join(base,'output.wgsl');
 const metadata=JSON.parse(fs.readFileSync(input,'utf8'));
 return {input:audit(input),wgsl:audit(wgsl),code:fs.readFileSync(wgsl,'utf8'),type:metadata.shaderName,entry:metadata.metadata.webEntry,
   outputs:metadata.metadata.reflection.entry_points[0].output_variables.filter(v=>Number.isInteger(v.location)).map(v=>v.location)};
});
const vertex=shaders.find(s=>s.type==='FWebNaniteMaterialTilesVS');assert(vertex);
const pixels=[...new Map(shaders.filter(s=>s.type==='TBasePassPSFNoLightMapPolicy').map(s=>[s.wgsl.sha256,s])).values()];
assert.equal(pixels.length,3);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await tab.evaluate(async ({vertex,pixels})=>{
  const adapter=await navigator.gpu.requestAdapter();
  if(adapter.limits.maxColorAttachmentBytesPerSample<48)throw Error('Desktop GBuffer requires 48 color attachment bytes per sample');
  const device=await adapter.requestDevice({requiredLimits:{maxColorAttachmentBytesPerSample:48}}),results=[],errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  try {
   const vs=device.createShaderModule({code:vertex.code});
   for(const ps of pixels){
    device.pushErrorScope('validation');
    const module=device.createShaderModule({code:ps.code}),messages=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message);
    let pipelineError=null;
    try {await device.createRenderPipelineAsync({layout:'auto',vertex:{module:vs,entryPoint:vertex.entry},
      fragment:{module,entryPoint:ps.entry,targets:['rgba16float','rgb10a2unorm','rgba8unorm','rgba8unorm','rgba8unorm','rgba8unorm'].map((format,index)=>({format,writeMask:ps.outputs.includes(index)?15:0}))},
      primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth24plus-stencil8',depthWriteEnabled:false,depthCompare:'always'}});}
    catch(e){pipelineError=e.message;}
    const error=await device.popErrorScope();results.push({entry:ps.entry,messages,pipelineError,validationError:error?.message||null});
   }
   return {results,errors,features:[...device.features],colorAttachmentBytes:device.limits.maxColorAttachmentBytesPerSample};
  }finally{device.destroy();}
 },{vertex,pixels});
 const pass=!result.errors.length&&result.results.every(r=>!r.messages.length&&!r.pipelineError&&!r.validationError);
 const report={pass,source:audit(__filename),inputs:[vertex,...pixels].flatMap(s=>[s.input,s.wgsl]),...result};
 fs.writeFileSync(path.join(out,'pipelines.json'),JSON.stringify(report,null,2));console.log(report);assert(pass);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
