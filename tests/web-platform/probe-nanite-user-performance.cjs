'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const gpuMemory=require('./gpu-process-memory.cjs');
const output=path.join(__dirname,'results/nanite-user-performance-20261111');
fs.mkdirSync(output,{recursive:true});
const profile='C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/user-performance-20261111';
const report={pass:false,date:new Date().toISOString(),source:audit(__filename),
 manifest:audit(path.join(__dirname,'build/nanite-release-20261111/manifest.json')),
 url:'http://127.0.0.1:8766/villa/index.html',samples:[],nanite:[],errors:[],
 boundary:'Normal spawn, unchanged delivered page/runtime/configuration and normal world time. No GPU method wrappers or CPU profiler in measured windows. Resolution and native r.Nanite are the only A/B variables.'};
let context,page,owner;
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
const snapshot=()=>page.evaluate(()=>({time:performance.now(),frame:globalThis.__webEngineFrames,
 stages:globalThis.__webThreadStages,times:globalThis.__webThreadFrameTimes,
 view:globalThis.__webRenderView,settings:globalThis.__webProjectSettings,camera:globalThis.__webDefaultCamera,
 runtime:globalThis.__webEngineRuntime,hud:globalThis.__webLivePerformance,
 pso:globalThis.__webPSOPrecache,visible:document.visibilityState,surface:globalThis.__webEngineSurface,
 failure:globalThis.__webEngineFailure}));
async function measure(name){
 await page.waitForTimeout(10000);
 const before=await snapshot(); assert(!before.failure); assert.equal(before.visible,'visible');
 await page.waitForTimeout(20000);
 const after=await snapshot(); assert(!after.failure); assert.equal(after.visible,'visible');
 const frames=after.stages.presented-before.stages.presented,ms=after.time-before.time;
 const sample={name,before,after,frames,milliseconds:ms,fps:frames*1000/ms,
  stageMsPerFrame:Object.fromEntries(Object.keys(after.stages).filter(k=>/Milliseconds$/.test(k)).map(k=>[k,(after.stages[k]-before.stages[k])/frames])),
  memory:gpuMemory({profile})};
 report.samples.push(sample);save();console.log({name,fps:sample.fps,view:after.view,stageMsPerFrame:sample.stageMsPerFrame,memory:sample.memory});
 await page.screenshot({path:path.join(output,name+'.png')});
}
async function inspect(step){
 assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
 let value;const end=Date.now()+180000;
 do{await page.waitForTimeout(200);await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));
  value=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
 }while(value?.step!==step&&Date.now()<end);
 assert.equal(value?.step,step); assert.equal(value.enabled,step!==2);
 if(step===2)assert.equal(value.entries,0);else assert(value.entries>0&&value.registered>2000);
 const file=path.join(output,'nanite-'+step+'.json');fs.writeFileSync(file,JSON.stringify(value));
 report.nanite.push({step,enabled:value.enabled,registered:value.registered,entries:value.entries,
  primitiveVisibilitySkipped:value.primitiveVisibilitySkipped,materialDraws:value.materialDraws,
  boundedEntryPixels:value.boundedEntryPixels,unboundedEntryPixels:value.unboundedEntryPixels,report:audit(file)});save();
 console.log(report.nanite.at(-1));
}
(async()=>{try{
 context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,viewport:{width:2560,height:1440},deviceScaleFactor:1});
 page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));page.on('crash',()=>report.errors.push('Page crashed'));
 const log=fs.createWriteStream(path.join(output,'browser.log'));
 page.on('console',m=>{log.write(m.text()+'\n');if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto(report.url,{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||
  (globalThis.__webEngineFrames>=180&&globalThis.__webPSOPrecacheReady),null,{timeout:300000});
 assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
 owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 report.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock||null);
 assert(!report.clock?.materialTimeFrozen&&!report.clock?.renderTimeFrozen);
 await measure('1440-normal');
 await page.setViewportSize({width:1280,height:720});await measure('720-normal');
 await page.setViewportSize({width:2560,height:1440});await inspect(1);await measure('1440-nanite-on');
 await inspect(2);await measure('1440-nanite-off');
 await inspect(3);await measure('1440-nanite-restored');
 assert.deepEqual(report.errors,[]);report.pass=true;log.end();
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{await context?.close();save();console.log({pass:report.pass,output,failure:report.failure});}})();
