'use strict';
// Diagnostic capture only: record complete layouts/states to explain precache misses.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const option=name=>process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const folder=option('folder'),tag=option('tag')||'pso-coverage';
assert([folder,tag].every(x=>x&&/^[a-z0-9-]+$/.test(x)));
function instrument(){
 const layouts=new WeakMap(),groups=new WeakMap();
 globalThis.__psoCoverage={phase:'startup',pipelines:[]};
 for(const [name,map,transform] of [
   ['createBindGroupLayout',groups,d=>d],
   ['createPipelineLayout',layouts,d=>({...d,bindGroupLayouts:d.bindGroupLayouts.map(x=>groups.get(x))})]]){
   const original=GPUDevice.prototype[name];
   GPUDevice.prototype[name]=function(d){const result=original.call(this,d);map.set(result,JSON.parse(JSON.stringify(transform(d))));return result;};
 }
 for(const name of ['createRenderPipeline','createRenderPipelineAsync']){
   const original=GPUDevice.prototype[name];
   GPUDevice.prototype[name]=function(d){
     const state=__psoCoverage;
     const item={phase:state.phase,method:name,time:performance.now(),descriptor:JSON.parse(JSON.stringify({
       ...d,layout:layouts.get(d.layout),vertex:{...d.vertex,module:undefined},
       fragment:d.fragment&&{...d.fragment,module:undefined}}))};
     state.pipelines.push(item);
     const result=original.call(this,d);
     if(name.endsWith('Async'))result.then(()=>item.success=true,e=>{item.success=false;item.error=e.message;});
     return result;
   };
 }
}
(async()=>{
 const report={folder,date:new Date().toISOString(),pass:false,errors:[],boundary:'Descriptor instrumentation; not a performance benchmark.'};
 const output=path.join(__dirname,'results',tag+'.json');
 const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/stutters'),{
   channel:'msedge',headless:false,viewport:{width:1863,height:1030},deviceScaleFactor:1.25});
 try{
   await context.route('**/web-engine-worker.js?*',async route=>{
     const response=await route.fetch();await route.fulfill({response,body:`(${instrument.toString()})();\n`+await response.text()});
   });
   const page=await context.newPage(),cdp=await context.newCDPSession(page);
   await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
   await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
   page.on('pageerror',e=>report.errors.push(e.message));
   await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});await page.bringToFront();
   await page.waitForFunction(()=>globalThis.__webEngineFailure||
     (globalThis.__webPSOPrecache?.enabled&&globalThis.__webPSOPrecache.active===0&&
      globalThis.__webOptimizationRHI?.asyncPrecacheRequested===globalThis.__webOptimizationRHI?.asyncPrecacheCompleted),null,{timeout:180000});
   assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
   await page.waitForTimeout(15000);
   const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
   report.ready=await owner.evaluate(()=>({pso:__webPSOPrecache,rhi:__webOptimizationRHI,view:__webRenderView,settings:__webProjectSettings}));
   const camera=await owner.evaluate(()=>{__psoCoverage.phase='tour';return __webDefaultCamera;});
   for(const yaw of [camera.yaw,camera.yaw+90,camera.yaw+180,camera.yaw+270,camera.yaw]){
     assert.equal(await page.evaluate(p=>__webEngineRPC('WebProjectViewTest',p.x,p.y,p.z,p.pitch,p.yaw),{...camera,yaw}),1);
     await page.waitForTimeout(5000);
   }
   report.capture=await owner.evaluate(()=>__psoCoverage);
   report.coverage=report.capture.pipelines.filter(x=>x.phase==='tour').map(item=>{
     const candidates=report.capture.pipelines.filter(x=>x.method.endsWith('Async')&&
       x.descriptor.label===item.descriptor.label&&x.success);
     return {label:item.descriptor.label,sameShaders:candidates.length,
       exactDescriptor:candidates.some(x=>JSON.stringify(x.descriptor)===JSON.stringify(item.descriptor))};
   });
   await page.screenshot({path:path.join(__dirname,'results',tag+'.png')});
   assert(!report.errors.length,report.errors.join('\n'));assert(!await page.evaluate(()=>globalThis.__webEngineFailure));report.pass=true;
 }catch(e){report.errors.push(e.stack||String(e));throw e;}
 finally{fs.writeFileSync(output,JSON.stringify(report,null,2));await context.close();}
 console.log(JSON.stringify({pass:report.pass,startup:report.capture?.pipelines.filter(x=>x.phase==='startup').length,
   tour:report.capture?.pipelines.filter(x=>x.phase==='tour').length}));
})().catch(e=>{console.error(e);process.exitCode=1});
