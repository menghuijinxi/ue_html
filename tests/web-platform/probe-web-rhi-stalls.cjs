'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder'), tag=option('tag');
assert([folder,tag].every(v=>v&&/^[a-z0-9-]+$/.test(v)));
const seconds=Number(option('seconds')||60), traceSeconds=Number(option('trace-seconds')||20);
const width=Number(option('width')||2289),height=Number(option('height')||1287),clock=option('clock');
assert(width>=640&&width<=3840&&height>=480&&height<=2160);
assert(!clock||['owner','local'].includes(clock));
const immediateMode=option('immediate')||'channel';assert(['channel','priority','native-priority'].includes(immediateMode));
const withoutTaskScheduler=process.argv.includes('--without-task-scheduler');
assert(!withoutTaskScheduler||immediateMode==='native-priority');
assert(seconds>=10&&seconds<=180&&traceSeconds>=0&&traceSeconds<=60);
const output=path.join(__dirname,'results',tag), base=path.join(__dirname,'build',folder);
assert(!fs.existsSync(output+'.json'),'Use a fresh tag');
const runtime=fs.readdirSync(base).find(v=>/^UEWebEngineThreads\w*\.js$/.test(v)); assert(runtime);
const report={date:new Date().toISOString(),folder,seconds,traceSeconds,width,height,clock,immediateMode,withoutTaskScheduler,pass:false,errors:[],phases:[],
  packageFiles:['index.html',runtime,runtime.replace(/\.js$/,'.wasm'),'web-engine-worker.js','web-engine-host.js',
    'content-files.json','config-files.json'].map(f=>audit(path.join(base,f))),qualityOverrides:[],
  boundary:'Static camera, visible Edge, original Cook and quality; resolution and optional clock are recorded explicitly. RHI submission intervals, not physical display. No CPU profiler, per-draw wrappers or additional GPU queries. Diagnostic JS records native setImmediate delivery and execution; it does not measure the first native proxy hop. Trace is a separate diagnostic phase.'};
fs.copyFileSync(__filename,output+'-source.cjs');report.source=audit(output+'-source.cjs');
const save=()=>fs.writeFileSync(output+'.json',JSON.stringify(report,null,2)+'\n');
function install(){
  const c=globalThis.__rhiStallCapture={active:false,frames:[],immediates:[],pipelines:[]};
  let count=0;
  Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,get:()=>count,set(v){
    if(c.active&&v>count){
      const s=globalThis.__webThreadStages||{}, o=globalThis.__webOptimizationRHI||{};
      c.frames.push({frame:v,time:performance.now(),rhi:s.rhiWorkMilliseconds||0,
        game:globalThis.__webEngineFrames,gameMs:globalThis.__webThreadFrameTimes?.at(-1),
        graphics:o.graphicsPipelines,compute:o.computePipelines,io:globalThis.__webContentIO?.stats?.completed,
        streamPending:globalThis.__webTextureStreaming?.pending});
    }count=v;
  }});
  const post=globalThis.postMessage;
  globalThis.postMessage=function(message,...args){
    if(c.active&&message.type==='state')c.pipelines.push(...(message.state?.__webFramePacing?.events||[]));
    return post.call(this,message,...args);
  };
}
function stats(values){
  const sorted=values.toSorted((a,b)=>a-b), tail=sorted.slice(-Math.ceil(sorted.length*.01));
  return {count:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,
    p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],
    p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1),
    low1Fps:1000*tail.length/tail.reduce((a,b)=>a+b,0)};
}
let context,log;
(async()=>{try{
  report.idleGpu=execFileSync('nvidia-smi',['--query-gpu=utilization.gpu,memory.used','--format=csv,noheader,nounits'],
    {encoding:'utf8',windowsHide:true,timeout:10000}).trim();
  assert(report.idleGpu.split(/\r?\n/).every(l=>Number(l.split(',')[0])<=50),'GPU already busy');save();
  context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/rhi-stalls'),
    {channel:'msedge',headless:false,viewport:{width,height},deviceScaleFactor:1});
  await context.route('**/web-engine-worker.js?*',async route=>{
    const response=await route.fetch();let body='('+install.toString()+')();\n'+await response.text();
    if(withoutTaskScheduler)body="Object.defineProperty(globalThis,'scheduler',{configurable:true,value:undefined});\n"+body;
    if(immediateMode==='priority')body=body.replace('const diagnosticStateKeys = [',`{
      if(!globalThis.scheduler?.postTask)throw Error('scheduler.postTask unavailable');
      let sequence=0;const pending=new Map();
      globalThis.setImmediate=callback=>{const id=++sequence,controller=new AbortController();pending.set(id,controller);
        scheduler.postTask(()=>{pending.delete(id);callback();},{priority:'user-blocking',signal:controller.signal})
          .catch(e=>{if(e.name!=='AbortError')throw e;});return id;};
      globalThis.clearImmediate=id=>{pending.get(id)?.abort();pending.delete(id);};
    }
    const diagnosticStateKeys = [`);
    fs.writeFileSync(output+'-worker.js',body);report.workerProbe=audit(output+'-worker.js');
    await route.fulfill({response,body});
  });
  await context.route('**/'+runtime+'?*',async route=>{
    const response=await route.fetch(), original=await response.text();
    const begin=original.indexOf('var _emscripten_set_immediate = function(cb, userData) {');
    const end=original.indexOf('\nvar _emscripten_set_main_loop_arg',begin);assert(begin>=0&&end>begin);
    const body=original.slice(0,begin)+`var _emscripten_set_immediate = function(cb, userData) {
      cb=bigintToI53Checked(cb);userData=bigintToI53Checked(userData);runtimeKeepalivePush();
      const c=globalThis.__rhiStallCapture,queued=c?.active?performance.now():0;
      return emSetImmediate(()=>{
        const started=queued?performance.now():0,frame=globalThis.__webRHIFrames||0;
        runtimeKeepalivePop();
        try{callUserCallback(()=>(a1=>getWasmTableEntry(cb).call(null,BigInt(a1)))(userData));}
        finally{if(queued){const ended=performance.now();
          c.immediates.push([queued,started,ended,frame,globalThis.__webRHIFrames||0,cb]);
          if(ended-started>16||started-queued>8)performance.mark('UE RHI slow immediate');}}
      });
    };
`+original.slice(end);
    fs.writeFileSync(output+'-runtime.js',body);report.runtimeProbe=audit(output+'-runtime.js');
    await route.fulfill({response,body});
  });
  const page=context.pages()[0],cdp=await context.newCDPSession(page);
  await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  log=fs.createWriteStream(output+'.log');
  page.on('console',m=>{const t=m.text();log.write(t+'\n');
    if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(t))report.errors.push(t);});
  page.on('pageerror',e=>report.errors.push(e.message));page.on('crash',()=>report.errors.push('Page crashed'));
  await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html'+
    (immediateMode==='native-priority'?'?rhiwake=priority':'?rhiwake=channel')+(clock?'&clock='+clock:''),{waitUntil:'commit'});await page.bringToFront();
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=600&&
    globalThis.__webTextureStreaming?.pending===0,null,{timeout:180000});
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure));await page.waitForTimeout(20000);
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  const state=()=>owner.evaluate(()=>({time:performance.now(),origin:performance.timeOrigin,frames:__webRHIFrames,
    stages:__webThreadStages,camera:__webDefaultCamera,view:__webRenderView,stream:__webTextureStreaming,
    optimization:globalThis.__webOptimizationRHI,history:globalThis.__webOcclusionHistory,
    pso:globalThis.__webPSOPrecache,io:globalThis.__webContentIO?.stats,clock:globalThis.__webGameFrameClock,
    rhiWake:globalThis.__webRHIWakeScheduler,
    immediateMappingLength:typeof setImmediateWrapped==='function'?setImmediateWrapped.mapping?.length:null}));
  async function capture(name,duration){
    const before=await state();
    if(clock)assert.equal(before.clock.mode,clock);
    if(immediateMode==='native-priority')assert.equal(before.rhiWake.active,withoutTaskScheduler?'channel':'priority');
    await owner.evaluate(()=>{const c=__rhiStallCapture;c.frames=[];c.immediates=[];c.pipelines=[];c.start=performance.now();c.active=true;performance.mark('UE RHI capture start');});
    await page.waitForTimeout(duration*1000);
    const data=await owner.evaluate(()=>{const c=__rhiStallCapture;c.active=false;return{...c,end:performance.now()};});
    assert(data.frames.length>2&&data.immediates.length>2,'Insufficient frame/wake samples');
    const after=await state(),frames=data.frames.slice(1).map((f,i)=>({...f,ms:f.time-data.frames[i].time}));
    const summary={fps:1000*(data.frames.length-1)/(data.frames.at(-1).time-data.frames[0].time),
      frames:stats(frames.map(f=>f.ms)),queue:stats(data.immediates.map(v=>v[1]-v[0])),
      execution:stats(data.immediates.map(v=>v[2]-v[1])),pipelineEvents:data.pipelines.length,
      over20:frames.filter(f=>f.ms>20).length,over30:frames.filter(f=>f.ms>30).length,
      worst:frames.toSorted((a,b)=>b.ms-a.ms).slice(0,30)};
    report.phases.push({name,before,after,summary,data});save();console.log(JSON.stringify({phase:name,...summary,worst:summary.worst.slice(0,3)}));
    assert.deepEqual(before.camera,after.camera);assert.equal(after.stream.pending,0);assert(!report.errors.length);
  }
  await capture('standing',seconds);
  if(traceSeconds){
    const done=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
    await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc',transferMode:'ReturnAsStream'});
    await capture('standing-trace',traceSeconds);
    await cdp.send('Tracing.end');const {stream}=await done;
    const file=output+'-trace.json',fd=fs.openSync(file,'w');
    try{for(;;){const chunk=await cdp.send('IO.read',{handle:stream,size:1024*1024});
      fs.writeSync(fd,Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8'));if(chunk.eof)break;}}
    finally{fs.closeSync(fd);await cdp.send('IO.close',{handle:stream});}
    report.trace=audit(file);
  }
  report.packageFiles.forEach(f=>assert.equal(audit(f.file).sha256,f.sha256));
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure),'Engine reported failure');
  assert(!report.errors.length);report.pass=true;
}catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{save();await context?.close();log?.end();}})();
