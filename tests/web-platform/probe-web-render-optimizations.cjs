'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const observe = require('./web-performance-capture-observer.cjs');
const ledger = require('./web-resource-ledger.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder') || 'villa-hzb-probe', tag = option('tag') || 'hzb-probe';
assert([folder, tag].every(x => /^[a-z0-9-]+$/.test(x)));
const modes = (option('modes') || '0,1,1,0,0,2,2,0').split(',').map(Number);
assert(modes.every(x => [0,1,2,3].includes(x)));
const warmup = Number(option('warmup') || 20), seconds = Number(option('seconds') || 15);
assert(warmup >= 2 && warmup <= 120 && seconds >= 5 && seconds <= 60);
const output = path.join(__dirname, 'results', tag);
const report = {date:new Date().toISOString(),pass:false,folder,modes,warmup,seconds,errors:[],runs:[],
  sources:[__filename,require.resolve('./web-performance-capture-observer.cjs'),require.resolve('./web-resource-ledger.cjs')].map(audit),qualityOverrides:[],
  experimentalOverrides:{1:{'r.HZBOcclusion':2},2:{'r.InstanceCulling.OcclusionCull':1}},
  environmentLabel:option('environment-label')||'unspecified',
  boundary:'One browser, same runtime/Cook/camera/quality, repeated mode order. Background load is recorded separately; API instrumentation is separate from FPS samples.'};
let context;
const log = fs.createWriteStream(output+'.log');
const save = () => fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
const guarded = (promise, ms = 20000) => new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{clearInterval(check);reject(Error('Browser operation timed out'));},ms);
  const check=setInterval(()=>{if(report.errors.length){clearTimeout(timeout);clearInterval(check);reject(Error(report.errors.join('\n')));}},250);
  promise.then(x=>{clearTimeout(timeout);clearInterval(check);resolve(x);},e=>{clearTimeout(timeout);clearInterval(check);reject(e);});
});
async function collectWorkerGarbage(context) {
  const cdp=await context.browser().newBrowserCDPSession();
  try {
    const {targetInfos}=await cdp.send('Target.getTargets');
    const target=targetInfos.find(x=>x.type==='worker'&&x.url.includes('web-engine-worker.js'));assert(target);
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
    await guarded(new Promise((resolve,reject)=>{
      const listener=event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);
        if(message.id!==1)return;cdp.off('Target.receivedMessageFromTarget',listener);
        message.error?reject(Error(JSON.stringify(message.error))):resolve();};
      cdp.on('Target.receivedMessageFromTarget',listener);
      cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:1,method:'HeapProfiler.collectGarbage'})}).catch(reject);
    }));
    await cdp.send('Target.detachFromTarget',{sessionId});
  } finally {await cdp.detach();}
}
(async()=>{try {
  context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag),
    {channel:'msedge',headless:true,viewport:{width:1863,height:1030},deviceScaleFactor:1.25});
  await context.route('**/web-engine-worker.js*',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:
      (process.argv.includes('--resource-ledger')?`(${ledger.toString()})();\n`:'')+`(${observe.toString()})();\n`+await response.text()});
  });
  const page=context.pages()[0],cdp=await context.newCDPSession(page);
  await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  page.on('pageerror',e=>report.errors.push(e.message));
  page.on('crash',()=>report.errors.push('Renderer crashed'));
  page.on('console',m=>{const t=m.text();log.write(t+'\n');if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(t))report.errors.push(t);});
  await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
  const startupTime=performance.now();
  await guarded(page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=30,null,{timeout:900000}),900000);
  report.startupTo30FramesMs=performance.now()-startupTime;
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  const state=()=>guarded(owner.evaluate(()=>({frame:globalThis.__webRHIFrames,gameFrame:globalThis.__webEngineFrames,
    camera:globalThis.__webDefaultCamera,settings:globalThis.__webProjectSettings,view:globalThis.__webRenderView,
    rhi:globalThis.__webOptimizationRHI,optimization:globalThis.__webOptimizationState,
    occlusion:globalThis.__webOcclusionRHI,stages:globalThis.__webThreadStages,
    streaming:globalThis.__webTextureStreaming,failure:globalThis.__webEngineFailure,
    gpuErrors:globalThis.__webPerformanceCapture.errors,
    frameTimes:globalThis.__webThreadFrameTimes?.slice(-120)})));
  report.start=await state();assert(!report.start.failure&&report.errors.length===0,JSON.stringify(report.errors));
  report.browserVersion=context.browser().version();
  report.ledgerStart=await guarded(owner.evaluate(()=>globalThis.__webResourceLedger?.()));
  const originalCamera=report.start.camera;
  for(const [index,mode] of modes.entries()) {
    assert.equal(await guarded(page.evaluate(mode=>__webEngineRPC('WebOptimizationTest',mode||3),mode)),1);
    await page.waitForTimeout(warmup*1000);
    const before=await state();assert(!before.failure&&report.errors.length===0,JSON.stringify(report.errors));
    assert.deepEqual(before.camera,originalCamera);assert.deepEqual(before.settings,report.start.settings);
    const started=performance.now(),samples=[];
    for(let i=0;i<seconds;i++) {await page.waitForTimeout(1000);const sample=await state();samples.push({elapsedMs:performance.now()-started,...sample});assert(!sample.failure&&report.errors.length===0,JSON.stringify(report.errors));}
    const after=samples.at(-1),frames=after.frame-before.frame,ms=after.elapsedMs;
    const run={index,mode,before,after,samples,frames,milliseconds:ms,fps:frames/ms*1000,
      rhiMsPerFrame:(after.stages.rhiWorkMilliseconds-before.stages.rhiWorkMilliseconds)/frames};
    report.runs.push(run);save();console.log(JSON.stringify({index,mode,fps:run.fps,rhiMsPerFrame:run.rhiMsPerFrame,rhi:after.rhi}));
    assert(frames>0&&after.gpuErrors.length===0);
    if(mode===1) assert(after.rhi.textureReadbackMaps>before.rhi.textureReadbackMaps,'HZB must consume real readbacks');
    await page.locator('canvas').screenshot({path:output+'-'+index+'-mode'+mode+'.png',timeout:60000});
  }
  if(process.argv.includes('--capture-api')) {
    report.api=[];
    for(const mode of [...new Set(modes)]) {
      assert.equal(await page.evaluate(mode=>__webEngineRPC('WebOptimizationTest',mode||3),mode),1);
      await page.waitForTimeout(warmup*1000);
      await owner.evaluate(()=>__webStartPerformanceCapture());await page.waitForTimeout(5000);
      const capture=await owner.evaluate(()=>{__webStopPerformanceCapture();return __webPerformanceCapture;});
      report.api.push({mode,capture});save();
    }
  }
  if(process.argv.includes('--tour')) {
    report.tour=[];
    for(const yawDelta of [0,90,180,270,0]) {
      assert.equal(await guarded(page.evaluate(({camera,delta})=>__webEngineRPC('WebProjectViewTest',
        camera.x,camera.y,camera.z,camera.pitch,camera.yaw+delta),{camera:originalCamera,delta:yawDelta})),1);
      const before=await state();
      await owner.evaluate(()=>__webStartPerformanceCapture());
      await page.waitForTimeout(5000);
      const after=await state(),capture=await owner.evaluate(()=>{__webStopPerformanceCapture();return __webPerformanceCapture;});
      report.tour.push({yawDelta,before,after,capture});save();
      assert(!report.errors.length&&!after.failure);
    }
  }
  if(process.argv.includes('--readback-test')) {
    assert.equal(await guarded(page.evaluate(()=>__webEngineRPC('WebTextureReadbackTest',1))),1);
    for(let attempt=0;attempt<20;attempt++) {
      await page.waitForTimeout(250);
      assert.equal(await guarded(page.evaluate(()=>__webEngineRPC('WebTextureReadbackTest',2))),1);
      report.readbackTest=await guarded(owner.evaluate(()=>globalThis.__webTextureReadbackTest));
      if(report.readbackTest && !report.readbackTest.pending) break;
    }
    assert(report.readbackTest?.pass,JSON.stringify(report.readbackTest));
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebOptimizationTest',3)),1);
  await page.waitForTimeout(2000);report.end=await state();
  if(process.argv.includes('--resource-ledger')) await collectWorkerGarbage(context);
  report.ledgerEnd=await guarded(owner.evaluate(()=>globalThis.__webResourceLedger?.()));
  if(process.argv.includes('--resource-ledger')) assert.deepEqual(report.ledgerEnd.unknownFormats,[],'Account for every observed texture format');
  report.summary=Object.fromEntries([...new Set(modes)].map(mode=>{const runs=report.runs.filter(x=>x.mode===mode);return [mode,{fps:runs.reduce((s,x)=>s+x.frames,0)/runs.reduce((s,x)=>s+x.milliseconds,0)*1000,rhiMsPerFrame:runs.reduce((s,x)=>s+x.rhiMsPerFrame*x.frames,0)/runs.reduce((s,x)=>s+x.frames,0)}];}));
  assert(!report.errors.length&&!report.end.failure);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}finally{if(context)await context.close();log.end();save();console.log(JSON.stringify({pass:report.pass,summary:report.summary,failure:report.failure}));}})();
