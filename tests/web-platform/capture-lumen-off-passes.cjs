'use strict';
// Diagnostic GPU frames only: never include this instrumented run in FPS A/B.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const installObserver=require('./web-performance-capture-observer.cjs');
const {audit}=require('./content-file-metadata.cjs');
const tag='lumen-off-v59-pass-diagnostic',output=path.join(__dirname,'results',tag+'.json');assert(!fs.existsSync(output));
const report={date:new Date().toISOString(),pass:false,source:audit(__filename),observer:audit(require.resolve('./web-performance-capture-observer.cjs')),
 runs:[],boundary:'Separate instrumented GPU frames after formal FPS tests. Original spawn and project quality, visible Edge 2289x1287 DPR1. Pipeline names and timestamp samples identify additional work, not an uninstrumented FPS comparison. No quality settings are changed.'};
let context;
(async()=>{try{
 for(const folder of ['villa-native-metadata-v57','villa-lumen-off-current-mimalloc-v59']){
  const run={folder,errors:[],frames:[]};report.runs.push(run);
  context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag+'-'+folder),{
   channel:'msedge',headless:false,viewport:{width:2289,height:1287},deviceScaleFactor:1});
  await context.route('**/web-engine-worker.js?*',async route=>{
   const response=await route.fetch();await route.fulfill({response,body:'('+installObserver.toString()+')();\n'+await response.text()});
  });
  const page=context.pages()[0],cdp=await context.newCDPSession(page);
  await cdp.send('Input.setIgnoreInputEvents',{ignore:true});await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  page.on('pageerror',e=>run.errors.push(e.message));
  const log=fs.createWriteStream(output.replace(/\.json$/,'-'+folder+'.log'));
  page.on('console',m=>{const s=m.text();log.write(s+'\n');if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(s))run.errors.push(s);});
  await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html',{waitUntil:'commit'});
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:120000});
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure));await page.waitForTimeout(15000);
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  const state=()=>owner.evaluate(()=>({settings:__webProjectSettings,camera:__webDefaultCamera,view:__webRenderView,threads:__webEngineThreads,
   frame:__webRHIFrames,occlusion:__webOcclusionRHI,errors:__webPerformanceCapture.errors,adapter:__webPerformanceCapture.adapter}));
  run.before=await state();assert(run.before.settings.gi===0&&run.before.settings.reflections===0);
  for(let i=0;i<3;i++){const frame=await owner.evaluate(()=>__webCaptureGPUFrame());assert(!frame.unsupported&&frame.entries.length);run.frames.push(frame);await page.waitForTimeout(150);}
  run.after=await state();assert.deepEqual(run.before.camera,run.after.camera);assert.deepEqual(run.before.settings,run.after.settings);
  assert(!run.errors.length&&!run.after.errors.length);
  run.summary=run.frames.map(f=>{
   const groups={};for(const e of f.entries){const label=e.pipeline||e.label;const g=groups[label]||={kind:e.kind,passes:0,dispatches:0,gpuMs:0,cpuMs:0};g.passes++;g.gpuMs+=e.gpuMs;g.cpuMs+=e.cpuMs;g.dispatches+=(e.calls.dispatchWorkgroups||0)+(e.calls.dispatchWorkgroupsIndirect||0);}
   return {presented:f.presented,totalPassMs:f.totalPassMs,groups};
  });
  await page.locator('canvas').screenshot({path:output.replace(/\.json$/,'-'+folder+'.png')});
  run.pass=true;log.end();await context.close();context=null;
  fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({folder,pass:true,gpuPassMs:run.frames.map(f=>f.totalPassMs)}));
 }
 report.pass=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}
finally{await context?.close();fs.writeFileSync(output,JSON.stringify(report,null,2));}})();
