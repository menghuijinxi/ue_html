'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('../content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const tag=option('tag'),folder=option('folder')||'villa-presentation-performance-20261115';
const origin=option('origin')||'http://127.0.0.1:8775',search=option('search')||'';
const seconds=Number(option('seconds')||20),cpuTrace=process.argv.includes('--cpu-trace'),trace=cpuTrace||process.argv.includes('--trace');
const replay=option('replay');assert(replay===undefined||replay==='on'||replay==='off');
assert([tag,folder].every(v=>/^[a-z0-9-]+$/.test(v))&&seconds>=15&&seconds<=60);
const base=path.resolve(__dirname,'..'),out=path.join(base,'results',tag);assert(!fs.existsSync(out));fs.mkdirSync(out);
fs.copyFileSync(__filename,path.join(out,'source.cjs'));
fs.copyFileSync(path.join(base,'build',folder,'asset-versions.json'),path.join(out,'asset-versions.json'));
const report={date:new Date().toISOString(),pass:false,folder,origin,search,seconds,trace,cpuTrace,replay,
  source:audit(path.join(out,'source.cjs')),package:audit(path.join(base,'build',folder,'asset-versions.json')),
  packageSnapshot:audit(path.join(out,'asset-versions.json')),
  errors:[],phases:[],boundary:'Diagnostic frame and pipeline correlation; normal advancing clocks, fixed 1280x720 DPR 1. Trace runs are excluded from performance acceptance. First and repeat route share one running engine. No per-draw GPU wrapper.'};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
function install(){
 const s=globalThis.__villaLow={active:false,frames:[],events:[]};let count=0;
 Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,get:()=>count,set(next){
  if(s.active&&next>count){const t=globalThis.__webThreadStages||{},io=globalThis.__webContentIO;
   s.frames.push({frame:next,time:performance.now(),rhi:t.rhiWorkMilliseconds,render:t.renderWorkMilliseconds,
    game:globalThis.__webEngineFrames,gameMs:globalThis.__webThreadFrameTimes?.at(-1),
    io:{...io?.stats,activeRequests:io?.requests.size},pendingTextures:globalThis.__webTextureStreaming?.pending,
    prewarmMisses:globalThis.__webPipelinePrewarm?.counts?.misses});}
  count=next;
 }});
}
function summary(frames){
 const ms=frames.slice(1).map((f,i)=>f.time-frames[i].time),sorted=ms.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length*.01));
 return {frames:ms.length,fps:1000*ms.length/ms.reduce((a,b)=>a+b,0),low1:1000*tail.length/tail.reduce((a,b)=>a+b,0),
  p99:sorted[Math.ceil(sorted.length*.99)-1],max:sorted.at(-1),over50:ms.filter(v=>v>50).length,over100:ms.filter(v=>v>100).length};
}
(async()=>{let context,cdp,traceDone,log;try{
 context=await chromium.launchPersistentContext(path.join(require('node:os').homedir(),'.cache/ue-html-build-archive/villa-low-20261115',tag),{
  channel:'msedge',headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1});
 if(replay)await context.route('**/index.html',async route=>{
  const response=await route.fetch(),html=await response.text(),match=html.match(/const localRuntimeAssets = (\{[^\n]+\});/);assert(match);
  const assets=JSON.parse(match[1]);assets.reuseReplayScratch=replay==='on';
  await route.fulfill({response,body:html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';')});
 });
 await context.route('**/web-engine-worker.js?*',async route=>{
  const r=await route.fetch();let text=await r.text();
  const marker='pipelineEvents.push({name,start,end:performance.now(),label:args[0]?.label});';assert(text.includes(marker));
  text=text.replace(marker,marker+'\n          if (__villaLow.active) __villaLow.events.push({name,start,end:performance.now(),label:args[0]?.label});');
  text=text.replace('globalThis.__webRecordPipelineEvent = event => {',
   'globalThis.__webRecordPipelineEvent = event => {\n      if (__villaLow.active) __villaLow.events.push(event);');
  await route.fulfill({response:r,body:'('+install.toString()+')();\n'+text});
 });
 const page=context.pages()[0];log=fs.createWriteStream(path.join(out,'console.log'));
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{log.write(m.text()+'\n');
  if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 const response=await page.goto(origin+'/build/'+folder+'/index.html'+search,{waitUntil:'commit'});assert(response.ok());
 await page.waitForFunction(()=>globalThis.__webEngineFailure||(globalThis.__webEngineFrames>=180&&globalThis.__webPSOPrecacheReady),null,{timeout:300000});
 assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 const state=()=>owner.evaluate(()=>({time:performance.now(),timeOrigin:performance.timeOrigin,
  camera:globalThis.__webDefaultCamera,stages:globalThis.__webThreadStages,settings:globalThis.__webProjectSettings,
  rhi:globalThis.__webOcclusionRHI,history:globalThis.__webOcclusionHistory,
  upload:globalThis.__webUploadStaging,readback:globalThis.__webStagingReadbackPool,
  pso:globalThis.__webOptimizationRHI,prewarm:globalThis.__webPipelinePrewarm,
  io:globalThis.__webContentIO?.stats,threads:globalThis.__webEngineThreads,scratch:globalThis.__webReplayScratchStats,
  replayScratchEnabled:globalThis.__webReuseReplayScratch,
  motion:globalThis.__webMotionBenchmark}));
 await page.waitForTimeout(5000);report.initial=await state();
 const {readPage}=require('../web-pipeline-prewarm-package.cjs');
 const {verifyOptimizationContract,verifyNativeDefaults}=require('../web-optimization-contract.cjs');
 const contract=verifyOptimizationContract(path.join(base,'build',folder),readPage(path.join(base,'build',folder)));
 if(contract&&!replay){report.optimizationAudit=verifyNativeDefaults(contract,report.initial);
  assert.equal(report.initial.replayScratchEnabled,contract.runtime.reuseReplayScratch);}
 report.environmentBefore=await require('../sample-test-environment.cjs')(page);
 report.hud=await page.evaluate(()=>({visible:getComputedStyle(document.querySelector('#web-performance-hud')).display!=='none',live:globalThis.__webLivePerformance}));
 if(trace){cdp=await context.newCDPSession(page);traceDone=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
  await cdp.send('Tracing.start',{categories:cpuTrace ? '-*,toplevel,devtools.timeline,blink.user_timing,v8,disabled-by-default-v8.cpu_profiler,gpu.dawn' :
   'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc,disabled-by-default-gpu.service,disabled-by-default-gpu.dawn,gpu.dawn',transferMode:'ReturnAsStream'});}
 for(const name of ['first-tour','repeat-tour']){
  const phase={name,before:await state()};report.phases.push(phase);
  await owner.evaluate(()=>{Object.assign(__villaLow,{active:true,frames:[],events:[]});performance.mark('villa-low-begin');});
  const serial=await page.evaluate(s=>__webEngineRPC('WebMotionBenchmarkControl',3,s),seconds);assert(serial>0);
  await page.waitForFunction(s=>globalThis.__webMotionBenchmark?.serial===s&&__webMotionBenchmark.completed&&!__webMotionBenchmark.active,serial,{timeout:(seconds+60)*1000});
  phase.data=await owner.evaluate(()=>{__villaLow.active=false;return __villaLow;});phase.after=await state();
  phase.summary=summary(phase.data.frames);
  phase.long=phase.data.frames.slice(1).flatMap((f,i)=>{const b=phase.data.frames[i],ms=f.time-b.time;if(ms<=50)return[];
   return[{frame:f.frame,offset:f.time-phase.data.frames[0].time,ms,rhiMs:f.rhi-b.rhi,renderMs:f.render-b.render,gameAdvance:f.game-b.game,
    gameMs:f.gameMs,ioBefore:b.io,ioAfter:f.io,pendingTextures:f.pendingTextures,prewarmMisses:f.prewarmMisses,
    pipelines:phase.data.events.filter(e=>e.end>=b.time&&e.start<=f.time).map(e=>({...e,ms:e.end-e.start}))}];});
  console.log(JSON.stringify({name,...phase.summary,long:phase.long.filter(f=>f.ms>100)}));save();await page.waitForTimeout(1500);
 }
 if(trace){await cdp.send('Tracing.end');const {stream}=await traceDone;const file=path.join(out,'trace.json'),fd=fs.openSync(file,'w');
  try{for(;;){const c=await cdp.send('IO.read',{handle:stream,size:1024*1024});fs.writeSync(fd,Buffer.from(c.data,c.base64Encoded?'base64':'utf8'));if(c.eof)break;}}
  finally{fs.closeSync(fd);await cdp.send('IO.close',{handle:stream});}report.traceFile=audit(file);}
 await page.screenshot({path:path.join(out,'hud.png')});assert.deepEqual(report.errors,[]);report.pass=true;
 report.environmentAfter=await require('../sample-test-environment.cjs')(page);
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}finally{await context?.close();log?.end();save();console.log(JSON.stringify({pass:report.pass,out}));}})();
