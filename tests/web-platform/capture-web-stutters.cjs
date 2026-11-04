'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observer = require('./web-stutter-observer.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--'+name+'='))?.slice(name.length+3);
const folder = option('folder') || 'villa-live-fps-v3', tag = option('tag') || 'stutters';
assert([folder,tag].every(s=>/^[a-z0-9-]+$/.test(s)));
const width = Number(option('width') || 1863), height = Number(option('height') || 1030);
const dpr = Number(option('dpr') || 1.25);
assert([width,height].every(n=>Number.isInteger(n)&&n>=320&&n<=7680));
assert(Number.isFinite(dpr)&&dpr>=0.5&&dpr<=4);
const output = path.join(__dirname,'results',tag);
fs.mkdirSync(path.dirname(output),{recursive:true});
assert(!fs.existsSync(output+'.json'),'Use a fresh tag');
const report = {date:new Date().toISOString(),folder,headless:process.argv.includes('--headless'),
  width,height,dpr,phases:[],errors:[],qualityOverrides:[],pass:false};
const save = () => fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
let context, log;
function summarize(data) {
  const values=data.frames.map(f=>f.ms), sorted=values.toSorted((a,b)=>b-a), tail=sorted.slice(0,Math.ceil(sorted.length*.01));
  const begin=data.frames[0],end=data.frames.at(-1);
  const creations=Object.fromEntries(Object.keys(end?.counts||{}).map(k=>[k,end.counts[k]-(begin?.counts[k]||0)]));
  return {frames:values.length,fps:values.length*1000/values.reduce((a,b)=>a+b,0),
    low:1000*tail.length/tail.reduce((a,b)=>a+b,0),p99:sorted[Math.floor(sorted.length*.01)],
    maximum:sorted[0],over50:values.filter(v=>v>50).length,over83:values.filter(v=>v>1000/12).length,
    over166:values.filter(v=>v>1000/6).length,creations,
    ioBefore:begin?.io,ioAfter:end?.io,
    worst:data.frames.toSorted((a,b)=>b.ms-a.ms).slice(0,20).map(f=>({frame:f.frame,time:f.time,ms:f.ms,gameMs:f.gameMs,
      rhiDelta:f.rhiTotal-data.frames[data.frames.indexOf(f)-1]?.rhiTotal,
      events:data.events.filter(e=>e.end>=f.time-f.ms&&e.start<=f.time)}))};
}
(async()=>{
  try {
    context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/stutters'),{
      channel:'msedge',headless:report.headless,viewport:{width,height},deviceScaleFactor:dpr});
    await context.route('**/web-engine-worker.js?*',async route=>{
      const response=await route.fetch();
      await route.fulfill({response,body:`(${observer.toString()})();\n`+await response.text()});
    });
    const page=context.pages()[0],cdp=await context.newCDPSession(page);
    report.browser=await cdp.send('Browser.getVersion');
    report.commandLine=await cdp.send('Browser.getBrowserCommandLine').catch(e=>({unavailable:e.message}));
    await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    log=fs.createWriteStream(output+'.log');
    page.on('pageerror',e=>report.errors.push(e.message));
    page.on('crash',()=>report.errors.push('Renderer crashed'));
    page.on('console',m=>{
      const text=m.text();log.write(text+'\n');
      if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text))report.errors.push(text);
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
    await page.bringToFront();
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=30,null,{timeout:900000});
    assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js')); assert(owner);
    report.environment=await page.evaluate(()=>({hardwareConcurrency:navigator.hardwareConcurrency,
      userAgent:navigator.userAgent,screen:{width:screen.width,height:screen.height},dpr:devicePixelRatio,visibility:document.visibilityState}));
    const state=()=>owner.evaluate(()=>({time:performance.now(),timeOrigin:performance.timeOrigin,frames:__webRHIFrames,
      stages:globalThis.__webThreadStages,threads:globalThis.__webEngineThreads,camera:globalThis.__webDefaultCamera,
      view:globalThis.__webRenderView,optimization:globalThis.__webOptimizationRHI,io:globalThis.__webContentIO?.stats,
      streaming:globalThis.__webTextureStreaming,adapter:__webStutters.adapter}));
    report.initial=await state(); save();
    async function capture(name,action){
      const before=await state();
      await owner.evaluate(()=>__webBeginStutterCapture());
      await action();
      const data=await owner.evaluate(()=>__webEndStutterCapture());
      const phase={name,before,after:await state(),summary:summarize(data),data};
      report.phases.push(phase); save(); console.log(JSON.stringify({phase:name,...phase.summary,worst:phase.summary.worst.slice(0,1)}));
      assert(!data.errors.length,data.errors.join('\n'));
      return phase;
    }
    await capture('initial-warmup',()=>page.waitForTimeout(20000));
    report.hudReset=await page.evaluate(()=>{
      const reset=document.querySelector('#web-performance-hud button');
      if(reset)reset.click();
      return !!reset;
    });
    await capture('standing',()=>page.waitForTimeout(30000));
    await page.screenshot({path:output+'-standing.png'});
    // Repeat the same camera orientations to distinguish first-use compilation
    // from recurring stalls. No rendering quality or lighting controls change.
    const initial=report.initial.camera;
    const tour=async()=>{
      for(const yaw of [initial.yaw,initial.yaw+90,initial.yaw+180,initial.yaw+270,initial.yaw]){
        assert.equal(await page.evaluate(p=>__webEngineRPC('WebProjectViewTest',p.x,p.y,p.z,p.pitch,p.yaw),
          {...initial,yaw}),1);
        await page.waitForTimeout(5000);
      }
    };
    const traceDone=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
    const traceTour=option('trace')==='tour'; report.traceMode=traceTour?'tour-with-gpu-service-trace':'standing';
    const startTrace=()=>cdp.send('Tracing.start',{
      categories:'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc'+
        // CPU-profiler startup itself can stall workers for hundreds of ms.
        // GPU process task scopes locate deferred pipeline work without it.
        (traceTour?',disabled-by-default-gpu.service':''),
      transferMode:'ReturnAsStream'});
    if(traceTour)await startTrace();
    await capture(traceTour?'first-tour-with-trace':'first-tour',tour);
    await capture(traceTour?'repeat-tour-with-trace':'repeat-tour',tour);
    await page.screenshot({path:output+'-tour.png'});
    if(!traceTour){await startTrace();await capture('standing-with-trace',()=>page.waitForTimeout(20000));}
    await cdp.send('Tracing.end');
    const {stream}=await traceDone;
    const fd=fs.openSync(output+'-chrome-trace.json','w');
    try {
      for(;;){const chunk=await cdp.send('IO.read',{handle:stream,size:1024*1024});
        fs.writeSync(fd,Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8')); if(chunk.eof)break;}
    } finally {fs.closeSync(fd);await cdp.send('IO.close',{handle:stream});}
    report.final=await state(); report.hud=await page.evaluate(()=>__webLivePerformance);
    assert(!report.errors.length,report.errors.join('\n'));report.pass=true;
  } catch(e){report.errors.push(e.stack||String(e));throw e;}
  finally{save();await context?.close();log?.end();}
})().catch(e=>{console.error(e);process.exitCode=1;});
