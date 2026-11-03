'use strict';
// Instrumented correctness diagnosis, deliberately excluded from FPS results.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const tag=option('tag');assert(tag&&/^[a-z0-9-]+$/.test(tag));const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output+'.json'));
function instrument(){
 const modules=new WeakMap(),pipelines=new WeakMap(),passes=new WeakMap();
 const state=globalThis.__linkRenderAudit={active:false,draw:{},compute:{},pass:{},textures:{},shaders:{},errors:[]};
 const hash=text=>{let h=2166136261;for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;return h.toString(16);};
 const shader=GPUDevice.prototype.createShaderModule;
 GPUDevice.prototype.createShaderModule=function(desc){const module=shader.call(this,desc),code=desc.code,key=hash(code);modules.set(module,key);state.shaders[key]={entry:code.match(/fn (main\w*)\(/)?.[1],label:desc.label||'',length:code.length,
  distanceField:/DistanceField|DistanceFields|AOScreenGrid|AOParameters|AOTile|ObjectDistance/.test(code),shadow:/ShadowDepth|PointLightDepthBias|ShadowProjection|ShadowMap|ShadowBuffer/.test(code),
  markers:[...new Set(code.match(/\b\w*(?:DistanceField|ShadowDepth|PointLightDepthBias|AOParameters|AOScreenGrid)\w*/g)||[])].slice(0,16)};return module;};
 for(const [name,kind] of [['createRenderPipeline','draw'],['createComputePipeline','compute']]){
  const original=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(desc){const pipeline=original.call(this,desc),stage=kind==='draw'?desc.vertex:desc.compute;pipelines.set(pipeline,{key:modules.get(stage.module),label:desc.label||'',entry:stage.entryPoint,fragment:desc.fragment?modules.get(desc.fragment.module):null});return pipeline;};
 }
 for(const [name,kind] of [['createRenderPipelineAsync','draw'],['createComputePipelineAsync','compute']]){
  const original=GPUDevice.prototype[name];GPUDevice.prototype[name]=async function(desc){const pipeline=await original.call(this,desc),stage=kind==='draw'?desc.vertex:desc.compute;pipelines.set(pipeline,{key:modules.get(stage.module),label:desc.label||'',entry:stage.entryPoint,fragment:desc.fragment?modules.get(desc.fragment.module):null});return pipeline;};
 }
 for(const name of ['beginRenderPass','beginComputePass']){const original=GPUCommandEncoder.prototype[name];GPUCommandEncoder.prototype[name]=function(desc){const pass=original.call(this,desc);passes.set(pass,{label:desc?.label||name});if(state.active)state.pass[desc?.label||name]=(state.pass[desc?.label||name]||0)+1;return pass;};}
 for(const [prototype,kind,methods] of [[GPURenderPassEncoder.prototype,'draw',['draw','drawIndexed','drawIndirect','drawIndexedIndirect']],[GPUComputePassEncoder.prototype,'compute',['dispatchWorkgroups','dispatchWorkgroupsIndirect']]]){
  const original=prototype.setPipeline;prototype.setPipeline=function(pipeline){const pass=passes.get(this)||{};pass.pipeline=pipelines.get(pipeline);passes.set(this,pass);return original.call(this,pipeline);};
  for(const method of methods){const call=prototype[method];prototype[method]=function(...args){if(state.active){const pipeline=passes.get(this)?.pipeline||{},key=JSON.stringify(pipeline);state[kind][key]=(state[kind][key]||0)+1;}return call.apply(this,args);};}
 }
 const texture=GPUDevice.prototype.createTexture;GPUDevice.prototype.createTexture=function(desc){if(desc.label)state.textures[desc.label]={size:desc.size,format:desc.format,usage:desc.usage};return texture.call(this,desc);};
 const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',event=>state.errors.push(event.error.message));return device;};
}
const report={date:new Date().toISOString(),pass:false,runs:[],source:audit(__filename),boundary:'Instrumented rendering diagnosis only; no FPS claim. Runtime diagnostic toggles apply to disposable test sessions, never saved project/package settings.'};
(async()=>{try{
 for(const folder of (option('folders')||'villa-bridge-extras-v38,villa-final-link-o2-v39').split(',')){
  assert(/^[a-z0-9-]+$/.test(folder));const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag+'-'+folder),{channel:'msedge',headless:false,viewport:{width:1280,height:720}});
  try{
   await context.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+instrument.toString()+')();\n'+await response.text()});});
   const page=context.pages()[0],logs=[];page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>logs.push(e.stack));page.on('crash',()=>logs.push('PAGE_CRASH'));
   await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html');await page.waitForFunction(()=>globalThis.__webEngineFrames>=120,null,{timeout:120000});
   const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
   const run={folder,cases:[],logs,runtime:fs.readdirSync(path.join(__dirname,'build',folder)).filter(n=>/^UEWebEngine.*\.(js|wasm)$/.test(n)).map(n=>audit(path.join(__dirname,'build',folder,n)))};report.runs.push(run);
   for(const name of (option('cases')||'default,no-dfao').split(',')){
    assert(['default','no-dfao','no-shadow-cache'].includes(name));
    if(name==='no-dfao')assert.equal(await page.evaluate(()=>__webEngineRPC('WebDistanceFieldTest',0)),1);
    if(name==='no-shadow-cache'){assert.equal(await page.evaluate(()=>__webEngineRPC('WebDistanceFieldTest',1)),1);assert.equal(await page.evaluate(()=>__webEngineRPC('WebLightingQualityTest',10,0)),1);}
    await page.waitForTimeout(2000);
    const start=await owner.evaluate(()=>{const s=__linkRenderAudit;s.active=true;s.draw={};s.compute={};s.pass={};return __webRHIFrames;});
    await page.waitForTimeout(500);
    const captured=await owner.evaluate(()=>{__linkRenderAudit.active=false;return {frames:__webRHIFrames,state:__linkRenderAudit};});assert(captured.frames>start);
    const png=output+'-'+folder+'-'+name+'.png';await page.locator('canvas').screenshot({path:png});
    run.cases.push({name,startFrame:start,endFrame:captured.frames,...captured.state,screenshot:audit(png),diagnostics:await page.evaluate(()=>({fields:globalThis.__webDistanceFields,settings:globalThis.__webProjectSettings}))});
    assert.equal(captured.state.errors.length,0);console.log('Render audit',folder,name,captured.frames-start);
   }
  }finally{await context.close();}
 }report.pass=true;
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);}finally{fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));}})();
