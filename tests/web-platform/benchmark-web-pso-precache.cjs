'use strict';
// Same binary/Cook/settings, ABBA order, independent scene instances.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observer = require('./web-stutter-observer.cjs');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
const off=option('off'),on=option('on'),tag=option('tag')||'pso-precache-abba';
const order=process.argv.includes('--on-first')?[on,off,off,on]:[off,on,on,off];
const freshBrowser=process.argv.includes('--fresh-browser');
assert([off,on,tag].every(x=>x&&/^[a-z0-9-]+$/.test(x)));
const output=path.join(__dirname,'results',tag);
const report={date:new Date().toISOString(),off,on,order,freshBrowser,runs:[],errors:[],qualityOverrides:[],pass:false,
  boundary:'Headed Edge with focus emulation; browser/driver caches preserved. Measures first use in each new scene, not a clean driver cache.'};
const save=()=>fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
function summary(data){
  const frames=data.frames,values=frames.map(f=>f.ms),sorted=values.toSorted((a,b)=>b-a);
  assert(values.length>100);
  const tail=sorted.slice(0,Math.ceil(sorted.length*.01));
  const rolling=[];
  for(let end=0,start=0;end<frames.length;end++){
    while(frames[end].time-frames[start].time>5000)start++;
    const window=frames.slice(start,end+1);
    if(window.length<100||frames[end].time-frames[start].time<4900)continue;
    const slow=window.map(f=>f.ms).sort((a,b)=>b-a).slice(0,Math.ceil(window.length*.01));
    rolling.push(1000*slow.length/slow.reduce((a,b)=>a+b,0));
  }
  const first=frames[0].counts,last=frames.at(-1).counts;
  return {frames:frames.length,fps:frames.length*1000/values.reduce((a,b)=>a+b,0),
    low:1000*tail.length/tail.reduce((a,b)=>a+b,0),p99:sorted[Math.floor(sorted.length*.01)],maximum:sorted[0],
    rollingLowMinimum:Math.min(...rolling),over50:values.filter(x=>x>50).length,
    over83:values.filter(x=>x>1000/12).length,over166:values.filter(x=>x>1000/6).length,
    creations:Object.fromEntries(Object.entries(last).map(([k,v])=>[k,v-(first[k]||0)])),
    worst:frames.toSorted((a,b)=>b.ms-a.ms).slice(0,8).map(f=>({frame:f.frame,time:f.time,ms:f.ms,io:f.io}))};
}
(async()=>{
 let context;
 try{
   report.packages={};
   for(const folder of [off,on]){
     const root=path.join(__dirname,'build',folder);
     report.packages[folder]=Object.fromEntries(['UEWebEngineThreads.js','UEWebEngineThreads.wasm','content.bin','content-files.json','config-files.json']
       .map(name=>[name,audit(path.join(root,name))]));
   }
   for(const name of Object.keys(report.packages[off]))
     assert.equal(report.packages[off][name].sha256,report.packages[on][name].sha256,name+' differs');
   for(const [index,folder] of order.entries()){
     if(!context){
       context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/stutters'),{
         channel:'msedge',headless:false,viewport:{width:1863,height:1030},deviceScaleFactor:1.25});
       await context.route('**/web-engine-worker.js?*',async route=>{
         const response=await route.fetch();await route.fulfill({response,body:`(${observer.toString()})();\n`+await response.text()});
       });
     }
     const page=await context.newPage(),cdp=await context.newCDPSession(page);
     await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
     await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
     report.browser=await cdp.send('Browser.getVersion');
     const log=fs.createWriteStream(output+'-'+index+'.log');
     const run={index,folder,enabled:folder===on,phases:[],errors:[],pass:false};report.runs.push(run);save();
     page.on('pageerror',e=>run.errors.push(e.message));page.on('crash',()=>run.errors.push('Renderer crashed'));
     page.on('console',m=>{const t=m.text();log.write(t+'\n');if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(t))run.errors.push(t)});
     const start=Date.now();
     try{
       await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});await page.bringToFront();
       await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=30,null,{timeout:180000});
       const startupFailure=await page.evaluate(()=>globalThis.__webEngineFailure);
       assert(!startupFailure,startupFailure);
       run.first30FramesMs=Date.now()-start;
       const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
       const state=()=>owner.evaluate(()=>({frames:globalThis.__webRHIFrames,camera:globalThis.__webDefaultCamera,
         view:globalThis.__webRenderView,settings:globalThis.__webProjectSettings,pso:globalThis.__webPSOPrecache,
         rhi:globalThis.__webOptimizationRHI,streaming:globalThis.__webTextureStreaming,adapter:__webStutters.adapter,
         asyncPipelines:__webStutters.asyncPipelines}));
       run.initial=await state();save();
       // UE's request count includes queued/active precache work. Also await the
       // actual WebGPU callbacks, not just immediate API return.
       run.startupSamples=[];
       const deadline=Date.now()+180000;
       for(;;){
         const sample=await page.evaluate(()=>({frames:globalThis.__webEngineFrames,pso:globalThis.__webPSOPrecache,
           rhi:globalThis.__webOptimizationRHI,failure:globalThis.__webEngineFailure}));
         run.startupSamples.push({elapsedMs:Date.now()-start,...sample});save();
         assert(!sample.failure,sample.failure);
         if(sample.pso&&sample.pso.active===0&&sample.rhi&&sample.rhi.asyncPrecacheRequested===sample.rhi.asyncPrecacheCompleted)break;
         assert(Date.now()<deadline,'PSO queue did not finish: '+JSON.stringify(sample));
         await page.waitForTimeout(5000);
       }
       run.precacheReadyMs=Date.now()-start;
       await page.waitForTimeout(15000);
       run.ready=await state();save();
       assert.equal(run.ready.pso.enabled,run.enabled);
       assert.equal(run.ready.rhi.psoPrecaching,run.enabled);
       async function capture(name,action){
         const before=await state();await owner.evaluate(()=>__webBeginStutterCapture());await action();
         const data=await owner.evaluate(()=>__webEndStutterCapture());
         const phase={name,before,after:await state(),summary:summary(data),data};run.phases.push(phase);save();
         assert(!data.errors.length,data.errors.join('\n'));
         console.log(JSON.stringify({run:index,folder,phase:name,...phase.summary,worst:phase.summary.worst.slice(0,1)}));
       }
       await capture('standing',()=>page.waitForTimeout(10000));
       await page.screenshot({path:output+'-'+index+'-standing.png'});
       const camera=run.ready.camera;assert(camera);
       const tour=async()=>{for(const yaw of [camera.yaw,camera.yaw+90,camera.yaw+180,camera.yaw+270,camera.yaw]){
         assert.equal(await page.evaluate(p=>__webEngineRPC('WebProjectViewTest',p.x,p.y,p.z,p.pitch,p.yaw),{...camera,yaw}),1);
         await page.waitForTimeout(5000);
       }};
       await capture('first-tour',tour);await capture('repeat-tour',tour);
       await page.screenshot({path:output+'-'+index+'-tour.png'});
       run.final=await state();assert(!run.errors.length,run.errors.join('\n'));run.pass=true;
     }finally{
       run.lastPageState=await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,
         pso:globalThis.__webPSOPrecache,rhi:globalThis.__webOptimizationRHI,pool:globalThis.__webThreadPool})).catch(()=>null);
       save();await page.close();log.end();
       if(freshBrowser){await context.close();context=null;}
     }
   }
   const reference=report.runs[0].ready;
   for(const run of report.runs){
     assert.deepEqual(run.ready.settings,reference.settings);assert.deepEqual(run.ready.camera,reference.camera);
     for(const key of ['width','height','outputWidth','outputHeight'])assert.equal(run.ready.view[key],reference.view[key]);
   }
   assert(report.runs.every(r=>r.pass));report.pass=true;
   report.standingFpsRatio={};
   for(const enabled of [false,true]){
     const fps=report.runs.filter(r=>r.enabled===enabled).map(r=>r.phases[0].summary.fps);
     report.standingFpsRatio[enabled]=Math.max(...fps)/Math.min(...fps);
   }
   report.performanceComparable=Object.values(report.standingFpsRatio).every(ratio=>ratio<1.15);
 }catch(e){report.errors.push(e.stack||String(e));throw e;}
 finally{save();await context?.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
