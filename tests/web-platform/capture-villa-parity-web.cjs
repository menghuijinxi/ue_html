'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--'+n+'='))?.slice(n.length+3);
const tag=option('tag'), folder=option('folder')||'villa-scheduling-pipeline-v74';
assert(tag && /^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
const seconds=Number(option('seconds')||30), rounds=Number(option('rounds')||1);
const frameBudget=Number(option('frame-budget')||0);
assert([0,1,2,3,4].includes(frameBudget));
assert(!frameBudget || !process.argv.includes('--gpu'),'Budget mode owns its completion hook; inspect its counters separately');
assert(seconds>=10 && seconds<=60 && rounds>=1 && rounds<=4);
const output=path.join(__dirname,'results',tag), base=path.join(__dirname,'build',folder);
assert(!fs.existsSync(output+'.json'));
fs.copyFileSync(__filename,output+'-source.cjs');
const report={tag,folder,seconds,date:new Date().toISOString(),pass:false,runs:[],errors:[],
  gpuCompletionProbe:process.argv.includes('--gpu'),presentMonEnabled:!process.argv.includes('--no-presentmon'),frameBudget,
  performanceAccepted:false,physicalPresentationValidated:false,pipelineDiagnostics:{failedCreate:0,detailLines:0,otherLogErrors:[]},
  source:audit(output+'-source.cjs'),files:['index.html','config-files.json','UEWebEngineThreads.js','web-engine-host.js','web-engine-worker.js'].map(n=>audit(path.join(base,n))),
  manifest:audit(path.join(base,'asset-versions.json')),
  boundary:'Owner rAF retained. Submission, GPU completion and Windows compositor presentation are separate clocks; compositor refresh is not proof of new canvas content. Effects disabled only to attribute costs, not accepted quality reductions.'};
if(frameBudget)report.boundary='Diagnostic page-rAF scheduling gated by GPU completion credits from the owner. No local Game clock or FPS cap. Maximum outstanding reserved/submitted frames is asserted. Submission throughput is not physical display FPS; this is not an accepted replacement for owner scheduling.';
function observe(gpu) {
  const s=globalThis.__parity={active:false,frames:[],completed:0,submitted:0,pendingPeak:0,errors:[]};
  let frame=0,queue;
  Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,get:()=>frame,set:n=>{
    if(s.active && n>frame)s.frames.push({at:performance.now(),frame:n}); frame=n;
  }});
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){
    const d=await request.apply(this,args);queue=d.queue;
    d.addEventListener('uncapturederror',e=>s.errors.push(e.error.message));
    d.lost.then(e=>{if(e.reason!=='destroyed')s.errors.push(e.message)});return d;
  };
  if(gpu)globalThis.__webGPUFrameSubmitted=()=>{
    const seq=++s.submitted,pending=seq-s.completed,record=s.active?s.frames.at(-1):null;
    s.pendingPeak=Math.max(s.pendingPeak,pending);
    if(record){record.pending=pending;record.submit=performance.now();}
    queue.onSubmittedWorkDone().then(()=>{s.completed=Math.max(s.completed,seq);if(record)record.done=performance.now()});
  };
}
function stats(intervals){
  assert(intervals.length>100 && intervals.every(v=>Number.isFinite(v)&&v>0));
  const sorted=[...intervals].sort((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length*.01));
  return {frames:intervals.length,fps:1000*intervals.length/intervals.reduce((a,b)=>a+b,0),
    low1:1000*tail.length/tail.reduce((a,b)=>a+b,0),p50:sorted[Math.floor(sorted.length*.5)],
    p95:sorted[Math.floor(sorted.length*.95)],p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1),
    over33:intervals.filter(v=>v>33.333).length,over50:intervals.filter(v=>v>50).length};
}
const cases=[{name:'baseline',commands:[]}];
if(process.argv.includes('--effects'))cases.push(
  {name:'no-tlv',commands:[[15,0]]},
  // ShadowQuality is read by deferred RHI tasks: changing it mid-frame can
  // invalidate a queued shadow shader permutation. Test it at startup instead.
  {name:'no-dfao',commands:[[15,1],[7,0]]},{name:'no-aa',commands:[[7,1],[0,0]]},
  {name:'baseline-repeat',commands:[[0,4]]});
let context,log,pm;
const save=()=>fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
(async()=>{try{
  context=await chromium.launchPersistentContext(path.join(process.env.TEMP,'ue-villa-parity',tag),{
    channel:'msedge',headless:false,viewport:{width:1280,height:720},deviceScaleFactor:1});
  if(frameBudget)await context.route('**/index.html?*',async route=>{
    const response=await route.fetch();let body=await response.text();
    const match=body.match(/arguments: (\[[^\n]+\]),/);assert(match);
    const args=JSON.parse(match[1]);assert(!args.some(a=>a.startsWith('-WebFrameScheduler=')));
    args.push('-WebFrameScheduler='+frameBudget);
    body=body.replace(match[0],'arguments: '+JSON.stringify(args)+',');
    await route.fulfill({response,body});
  });
  await context.route('**/web-engine-worker.js?*',async route=>{
    const response=await route.fetch();await route.fulfill({response,body:`(${observe.toString()})(${process.argv.includes('--gpu')});\n`+await response.text()});
  });
  const page=context.pages()[0],cdp=await context.newCDPSession(page);
  await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  log=fs.createWriteStream(output+'.log');
  page.on('console',m=>{const t=m.text();log.write(t+'\n');
    if(/Failed to create (?:compute|graphics) pipeline/.test(t))report.pipelineDiagnostics.failedCreate++;
    else if(/LogRHI: Error: (?:(?:Vertex|Pixel|Shader): <unknown>|Render Targets: \(\d+\)|Depth Stencil Format:|0x[0-9a-f]+)\s*$/.test(t))report.pipelineDiagnostics.detailLines++;
    else if(/Log\w+: Error:/.test(t))report.pipelineDiagnostics.otherLogErrors.push(t);
    if(report.startupComplete && /Log\w+: Error:/.test(t))report.errors.push(t);
    if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Ensure condition failed/.test(t))report.errors.push(t)});
  page.on('pageerror',e=>report.errors.push(e.message));
  report.url=`http://127.0.0.1:8765/build/${folder}/index.html?clock=owner&occlusion=history&rhiwake=priority&gpuahead=0`;
  await page.goto(report.url,{waitUntil:'commit'});await page.bringToFront();
  await page.waitForFunction(()=>globalThis.__webEngineFailure || (globalThis.__webEngineFrames>=250 && globalThis.__webTextureStreaming?.pending===0 && (!globalThis.__webPSOPrecacheExpected||globalThis.__webPSOPrecacheReady)),null,{timeout:240000});
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
  report.startupComplete=true;
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  const state=()=>owner.evaluate(()=>({frame:__webRHIFrames,game:__webEngineFrames,view:__webRenderView,settings:__webProjectSettings,camera:__webDefaultCamera,
    clock:__webGameFrameClock,stages:__webThreadStages,occlusion:__webOcclusionRHI,optimization:__webOptimizationRHI,history:__webOcclusionHistory,
    computePassMerge:globalThis.__webComputePassMerge||null,
    gpuBudget:frameScheduler?Array.from(frameScheduler.state):null}));
  const browserCDP=await context.browser().newBrowserCDPSession();
  report.browser=await browserCDP.send('Browser.getVersion');
  report.processes=await browserCDP.send('SystemInfo.getProcessInfo');
  const gpu=report.processes.processInfo.find(p=>p.type==='GPU');assert(gpu);
  // Capture all ETW producers: Chromium can hand presentation to another
  // process. Retain process IDs above and never count unrelated swapchains.
  if(report.presentMonEnabled){
    pm=spawn(path.join(__dirname,'../../.tools/presentmon/PresentMon-2.3.0-x64.exe'),['--session_name',tag,'--output_file',output+'-present.csv','--no_console_stats',
      '--no_track_gpu','--no_track_input','--timed',String(Math.ceil((seconds+6)*cases.length*rounds+25)),'--terminate_after_timed'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    pm.stderr.on('data',b=>{report.presentMonError=(report.presentMonError||'')+b.toString()});
  }
  await page.waitForTimeout(15000);
  for(let round=0;round<rounds;round++)for(const test of cases){
    for(const args of test.commands)assert.equal(await page.evaluate(p=>__webEngineRPC('WebLightingQualityTest',...p),args),1);
    await page.waitForTimeout(5000);
    const r={name:test.name,round,commands:test.commands,before:await state()};report.runs.push(r);save();
    assert.equal(r.before.clock.mode,frameBudget?'page':'owner');
    assert.equal(r.before.settings.gi,0);assert.equal(r.before.view.width,1280);assert.equal(r.before.view.height,720);
    r.started=new Date().toISOString();
    await owner.evaluate(()=>{__parity.frames=[];__parity.pendingPeak=0;__parity.active=true;});
    await page.waitForTimeout(seconds*1000);
    await owner.evaluate(()=>{__parity.active=false;});
    r.ended=new Date().toISOString();r.after=await state();
    assert.deepEqual(r.after.camera,r.before.camera,'Camera changed during static measurement');
    assert.deepEqual(r.after.settings,r.before.settings,'Quality changed during measurement');
    if(frameBudget){assert.equal(r.after.gpuBudget[6],1);assert(r.after.gpuBudget[3]<=frameBudget && r.after.gpuBudget[5]<=frameBudget);}
    for(const key of ['width','height','outputWidth','outputHeight','antiAliasing'])
      assert.equal(r.after.view[key],r.before.view[key],'View changed: '+key);
    await page.waitForTimeout(300);
    r.capture=await owner.evaluate(()=>__parity);
    r.result=stats(r.capture.frames.slice(1).map((v,i)=>v.at-r.capture.frames[i].at));
    r.rhiMs=(r.after.stages.rhiWorkMilliseconds-r.before.stages.rhiWorkMilliseconds)/(r.after.frame-r.before.frame);
    r.workload=Object.fromEntries(['draws','dispatches','ready','pending'].map(k=>[k,(r.after.occlusion[k]-r.before.occlusion[k])/(r.after.occlusion.sampleFrame-r.before.occlusion.sampleFrame)]));
    assert.deepEqual(r.capture.errors,[]);assert.deepEqual(report.errors,[]);
    save();console.log(JSON.stringify({name:r.name,round,result:r.result,rhiMs:r.rhiMs,workload:r.workload}));
  }
  await page.locator('canvas').screenshot({path:output+'.png'});
  const finalState=await state();
  report.pipelineDiagnostics.finalCounters=finalState.optimization;
  report.pipelineDiagnostics.matchesUnsupportedCount=report.pipelineDiagnostics.failedCreate===finalState.optimization.unsupportedPrecacheRequests;
  assert(report.pipelineDiagnostics.matchesUnsupportedCount,'Unexplained pipeline creation errors');
  assert.equal(finalState.optimization.asyncPrecacheFailed,0);
  assert.equal(finalState.optimization.runtimeAsyncFailed,0);
  assert.deepEqual(report.pipelineDiagnostics.otherLogErrors,[]);
  report.pass=true;
}catch(e){report.error=e.stack;process.exitCode=1;}finally{
  await context?.close();if(log)await new Promise(r=>log.end(r));
  if(pm&&pm.exitCode===null){
    const stop=spawn(path.join(__dirname,'../../.tools/presentmon/PresentMon-2.3.0-x64.exe'),['--session_name',tag,'--terminate_existing_session'],{windowsHide:true,stdio:'ignore'});
    await new Promise(r=>stop.once('exit',r));
    await Promise.race([new Promise(r=>pm.once('exit',r)),new Promise(r=>setTimeout(r,10000))]);
    if(pm.exitCode===null)pm.kill();
  }
  report.presentMonCsv=fs.existsSync(output+'-present.csv')?audit(output+'-present.csv'):null;
  save();console.log(JSON.stringify({pass:report.pass,error:report.error,output}));
}})();
