'use strict';
// Instrumented diagnostic only: counts imports, BigInt arguments, heap view
// refresh checks and WebGPU object lookups. Never use these timings as FPS.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder')||'villa-command-stream-v36',tag=option('tag'),seconds=Number(option('seconds')||8);
const transport=option('transport');assert(!transport||['baseline','states','groups','all'].includes(transport));
assert([folder,tag].every(v=>v&&/^[a-z0-9-]+$/.test(v))&&seconds>=2&&seconds<=30);
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output+'.json'));
function install(imports){
 const state=globalThis.__bridgeAudit={active:false,current:null,calls:{},asm:{},native:{},groupEntryCounts:{},start:0,frames:0};
 for(const name of ['setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','draw','drawIndexed','drawIndirect','drawIndexedIndirect','setViewport','setScissorRect','setStencilReference','beginOcclusionQuery','endOcclusionQuery','end']){
  const original=GPURenderPassEncoder.prototype[name];GPURenderPassEncoder.prototype[name]=function(...args){if(state.active)state.native[name]=(state.native[name]||0)+1;return original.apply(this,args);};
 }
 const group=GPUDevice.prototype.createBindGroup;GPUDevice.prototype.createBindGroup=function(desc){if(state.active){const n=desc.entries.length;state.groupEntryCounts[n]=(state.groupEntryCounts[n]||0)+1;}return group.call(this,desc);};
 for(const [name,original] of Object.entries(imports))if(typeof original==='function'){
  imports[name]=function(...args){
   if(!state.active)return original(...args);
   const entry=state.calls[name]||(state.calls[name]={count:0,bigintArguments:0,viewChecks:0,lookups:0});
   entry.count++;for(const value of args)if(typeof value==='bigint')entry.bigintArguments++;
   if(name.includes('asm_const')){const code=String(args[0]);state.asm[code]=(state.asm[code]||0)+1;}
   const previous=state.current;state.current=entry;try{return original(...args);}finally{state.current=previous;}
  };
 }
 const views=growMemViews;growMemViews=function(){if(state.active&&state.current)state.current.viewChecks++;return views();};
 const tick=setInterval(()=>{
  if(typeof WebGPU!=='undefined'&&WebGPU.getJsObject&&!WebGPU.getJsObject.__audited){
   const lookup=WebGPU.getJsObject;WebGPU.getJsObject=function(ptr){if(state.active&&state.current)state.current.lookups++;return lookup(ptr);};WebGPU.getJsObject.__audited=true;
  }
 },100);
 state.tick=tick;
}
let context;
const report={date:new Date().toISOString(),folder,transport,seconds,pass:false,errors:[],source:audit(__filename),
 packageFiles:['index.html','UEWebEngineThreads.js','UEWebEngineThreads.wasm'].map(n=>audit(path.join(__dirname,'build',folder,n))),
 boundary:'Import and helper instrumentation, default spawn and project settings. Counts apply to the WebGPU owner only. Measured FPS and wall durations are perturbed and must not be used for speedup claims.'};
(async()=>{try{
 context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag),{channel:'msedge',headless:false,viewport:{width:2289,height:1287},deviceScaleFactor:1});
 if(transport)await context.route('**/index.html',async route=>{
  const r=await route.fetch();let html=await r.text();const match=html.match(/arguments: (\[[^\n]+\]),/);assert(match);const args=JSON.parse(match[1]);
  if(['baseline','groups'].includes(transport))args.push('-WebGPUScalarPassCalls');
  if(['baseline','states'].includes(transport))args.push('-WebGPULegacyDescriptors');
  html=html.replace(match[0],'arguments: '+JSON.stringify(args)+',');await route.fulfill({response:r,body:html});
 });
 await context.route('**/UEWebEngineThreads.js?*',async route=>{const r=await route.fetch(),s=await r.text();assert(s.includes('assignWasmImports();'));await route.fulfill({response:r,body:s.replace('assignWasmImports();','assignWasmImports(); ('+install.toString()+')(wasmImports);')});});
 const page=context.pages()[0],cdp=await context.newCDPSession(page);await cdp.send('Input.setIgnoreInputEvents',{ignore:true});await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 const log=fs.createWriteStream(output+'.log');page.on('console',m=>{const s=m.text();log.write(s+'\n');if(s.includes('WebGPU bridge extras:'))report.transportConfirmed=s.match(/states=(\d) groups=(\d)/)?.slice(1).map(Number);if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|P3_ENGINE_PREINIT_FAILED|P3_ENGINE_INIT_FAILED/.test(s))report.errors.push(s);});page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=150,null,{timeout:120000});assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);await page.waitForTimeout(10000);
 report.before=await owner.evaluate(()=>({frames:__webRHIFrames,view:__webRenderView,settings:__webProjectSettings,camera:__webDefaultCamera}));
 if(transport)assert.deepEqual(report.transportConfirmed,[Number(['states','all'].includes(transport)),Number(['groups','all'].includes(transport))]);
 await owner.evaluate(()=>{const s=__bridgeAudit;s.calls={};s.asm={};s.native={};s.groupEntryCounts={};s.start=performance.now();s.frames=__webRHIFrames;s.active=true;});
 await page.waitForTimeout(seconds*1000);
 report.measurement=await owner.evaluate(()=>{const s=__bridgeAudit;s.active=false;return {ms:performance.now()-s.start,frames:__webRHIFrames-s.frames,calls:s.calls,native:s.native,groupEntryCounts:s.groupEntryCounts,asm:Object.entries(s.asm).map(([code,count])=>({code,count,source:typeof ASM_CONSTS==='undefined'?null:String(ASM_CONSTS[code])}))};});
 report.pass=report.errors.length===0;assert(report.pass,report.errors.join('\n'));log.end();
 const frames=report.measurement.frames;report.ranking=Object.entries(report.measurement.calls).map(([name,v])=>({name,...v,perFrame:v.count/frames})).sort((a,b)=>b.count-a.count);console.table(report.ranking.slice(0,35));
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}finally{await context?.close();fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));}})();
