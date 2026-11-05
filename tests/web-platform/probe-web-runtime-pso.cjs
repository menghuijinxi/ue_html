'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder'),tag=option('tag');assert([folder,tag].every(v=>v&&/^[a-z0-9-]+$/.test(v)));
const modes=(option('modes')||'sync,async,async,sync').split(',');assert(modes.every(m=>['sync','async'].includes(m)));
const coreLimits=option('core-limits')?.split(',').map(Number);
assert(!coreLimits||(coreLimits.length===modes.length&&coreLimits.every(n=>[4,6,8].includes(n))));
const disableDiskCache=option('disable-disk-cache')==='true';
const schedules=option('schedules')?.split(',');
assert(!schedules||(schedules.length===modes.length&&schedules.every(s=>['fifo','shared'].includes(s))));
const hold=Number(option('hold')||5),warmup=Number(option('warmup')||10);
const verifyUse=option('verify-use')==='true';
const trace=option('trace')==='true',captureCorpus=option('capture-corpus')==='true';
assert(!captureCorpus||modes.every(mode=>mode==='async'),'Corpus export requires asynchronous runs');
assert(hold>=1&&hold<=10&&warmup>=5&&warmup<=60);
const output=path.join(__dirname,'results',tag),base=path.join(__dirname,'build',folder);
assert(!fs.existsSync(output+'.json'),'Use a fresh tag');
fs.copyFileSync(__filename,output+'-source.cjs');
const report={date:new Date().toISOString(),folder,modes,coreLimits,schedules,disableDiskCache,hold,warmup,verifyUse,trace,captureCorpus,pass:false,runs:[],qualityOverrides:[],
  source:audit(output+'-source.cjs'),packageFiles:['index.html','UEWebEngineThreads.js','UEWebEngineThreads.wasm',
    'content-files.json','config-files.json','web-engine-host.js','web-engine-worker.js'].map(n=>audit(path.join(base,n))),
  boundary:'Runtime first-use PSOs only; no PSO precaching or camera warm tour. Fresh visible Edge per run; driver caches retained; optional shader disk-cache disable, UE core-limit overrides and shared-stage async scheduling recorded. Shared scheduling queues actual first-use requests only and awaits every original pipeline. Same WASM/Cook, resolution, history/local-clock/priority-wake defaults. Rare pipeline/shader creation observation and one record per submit; no resource creation wrappers, CPU profiler or additional GPU query. Submission intervals are not physical display latency. '+
    (verifyUse?'Diagnostic only: per-bind identity tracking enabled; do not use these timings for performance claims.':'No per-draw or per-bind wrappers.')+
    (trace||captureCorpus?' Diagnostic browser trace/descriptor capture enabled; timings excluded from normal performance claims.':' No browser trace or descriptor corpus capture.')};
const save=()=>fs.writeFileSync(output+'.json',JSON.stringify(report,null,2)+'\n');
function install(verifyUse,schedule){
  const c=globalThis.__runtimePSOCapture={active:false,frames:[],events:[],counts:{},pending:0,failures:[]};
  c.scheduling={mode:schedule,submitted:0,deferred:0,peak:0};
  if(schedule==='shared'){
    const devices=new WeakMap(),modules=new WeakMap();let nextModule=1;
    for(const name of ['createRenderPipelineAsync','createComputePipelineAsync']){
      const original=GPUDevice.prototype[name];
      GPUDevice.prototype[name]=function(descriptor){
        let state=devices.get(this);if(!state){state={busy:new Set(),queue:[],active:0};devices.set(this,state);}
        const keys=['vertex','fragment','compute'].map(s=>descriptor[s]).filter(Boolean).map(s=>{
          if(!modules.has(s.module))modules.set(s.module,nextModule++);
          return modules.get(s.module)+':'+s.entryPoint;
        });
        if(keys.some(k=>state.busy.has(k)))c.scheduling.deferred++;
        return new Promise((resolve,reject)=>{
          const device=this;
          state.queue.push({keys,run(){
            keys.forEach(k=>state.busy.add(k));state.active++;c.scheduling.submitted++;
            c.scheduling.peak=Math.max(c.scheduling.peak,state.active);
            let promise;try{promise=original.call(device,descriptor);}catch(e){promise=Promise.reject(e);}
            Promise.resolve(promise).then(resolve,reject).finally(()=>{
              keys.forEach(k=>state.busy.delete(k));state.active--;pump();
            });
          }});
          function pump(){
            for(;;){const i=state.queue.findIndex(r=>r.keys.every(k=>!state.busy.has(k)));if(i<0)break;
              state.queue.splice(i,1)[0].run();}
          }
          pump();
        });
      };
    }
  }
  const identities=verifyUse?new WeakMap():null;
  c.usage={};
  if(verifyUse){
    for(const type of [GPURenderPassEncoder,GPURenderBundleEncoder,GPUComputePassEncoder]){
      const original=type.prototype.setPipeline;
      type.prototype.setPipeline=function(pipeline){
        const info=identities.get(pipeline);
        if(info){const usage=c.usage[info.name]||={unique:0,binds:0};
          usage.binds++;if(!info.used){info.used=true;usage.unique++;}}
        return original.call(this,pipeline);
      };
    }
  }
  for(const name of ['createRenderPipeline','createComputePipeline','createRenderPipelineAsync','createComputePipelineAsync','createShaderModule']){
    const original=GPUDevice.prototype[name];if(!original)continue;
    GPUDevice.prototype[name]=function(...args){
      const start=performance.now();c.counts[name]=(c.counts[name]||0)+1;
      const item={name,start,label:args[0]?.label};
      if(c.active)c.events.push(item);
      try{const result=original.apply(this,args);
        if(name.endsWith('Async')){c.pending++;result.then(pipeline=>{c.pending--;item.completed=performance.now();
          if(identities)identities.set(pipeline,{name,used:false});},error=>{
          c.pending--;item.completed=performance.now();item.error=error.message;c.failures.push(item);});}
        else if(identities&&name!=='createShaderModule')identities.set(result,{name,used:false});
        return result;
      }finally{item.end=performance.now();}
    };
  }
  let frame=0,previous;
  Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,get:()=>frame,set(v){
    if(v>frame){const time=performance.now();if(c.active&&previous!==undefined)c.frames.push({frame:v,time,ms:time-previous,
      rhiTotal:globalThis.__webThreadStages?.rhiWorkMilliseconds,gameMs:globalThis.__webThreadFrameTimes?.at(-1)});
      previous=time;}frame=v;
  }});
}
function summarize(data){
  const a=data.frames.map(f=>f.ms).toSorted((x,y)=>x-y);assert(a.length>40);
  const tail=a.slice(-Math.ceil(a.length*.01));
  return {frames:a.length,fps:a.length*1000/a.reduce((s,v)=>s+v,0),low1Fps:tail.length*1000/tail.reduce((s,v)=>s+v,0),
    p50:a[Math.floor(a.length*.5)],p99:a[Math.floor(a.length*.99)],maximum:a.at(-1),
    over20:a.filter(v=>v>20).length,over50:a.filter(v=>v>50).length,over100:a.filter(v=>v>100).length,
    creations:data.events.reduce((o,e)=>(o[e.name]=(o[e.name]||0)+1,o),{}),
    worst:data.frames.toSorted((a,b)=>b.ms-a.ms).slice(0,10).map(f=>({...f,
      events:data.events.filter(e=>e.start<=f.time&&(e.completed??e.end)>=f.time-f.ms)}))};
}
let context,log;
(async()=>{try{
  for(const mode of modes){
    const run={index:report.runs.length+1,mode,coreLimit:coreLimits?.[report.runs.length],schedule:schedules?.[report.runs.length]||'fifo',errors:[],phases:[]};report.runs.push(run);save();
    run.idleGpu=execFileSync('nvidia-smi',['--query-gpu=utilization.gpu,memory.used','--format=csv,noheader,nounits'],
      {encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    assert(run.idleGpu.split(/\r?\n/).every(l=>Number(l.split(',')[0])<=50),'GPU busy before run');
    context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/runtime-pso'),
      {channel:'msedge',headless:false,viewport:{width:2289,height:1287},deviceScaleFactor:1,args:disableDiskCache?['--disable-gpu-shader-disk-cache']:[]});
    if(run.coreLimit)await context.route('**/index.html?*',async route=>{
      const response=await route.fetch(),html=await response.text();
      const match=html.match(/arguments: (\[[^\n]+\]),/);assert(match,'Package arguments not found');
      const args=JSON.parse(match[1]);assert(!args.some(v=>v.startsWith('-corelimit=')));
      args.push('-corelimit='+run.coreLimit);
      await route.fulfill({response,body:html.replace(match[0],'arguments: '+JSON.stringify(args)+',')});
    });
    await context.route('**/web-engine-worker.js?*',async route=>{
      const response=await route.fetch();
      const corpusRecorder=captureCorpus?'globalThis.__webStartupPSOCorpus=true;\n'+fs.readFileSync(path.join(__dirname,'web-startup-profile.js'),'utf8')+'\n':'';
      await route.fulfill({response,body:corpusRecorder+'('+install.toString()+')('+verifyUse+','+JSON.stringify(run.schedule)+');\n'+await response.text()});
    });
    const page=context.pages()[0],cdp=await context.newCDPSession(page);
    run.browser=await cdp.send('Browser.getVersion');
    await cdp.send('Input.setIgnoreInputEvents',{ignore:true});await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    log=fs.createWriteStream(output+'-'+run.index+'-'+mode+'.log');
    page.on('console',m=>{const t=m.text();log?.write(t+'\n');
      if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(t))run.errors.push(t);});
    page.on('pageerror',e=>run.errors.push(e.message));page.on('crash',()=>run.errors.push('Page crashed'));
    run.url='http://127.0.0.1:8765/build/'+folder+'/index.html?pso='+mode;
    console.log('Runtime PSO start',run.index,mode,'cores',run.coreLimit||'default');const start=Date.now();
    await page.goto(run.url,{waitUntil:'commit'});await page.bringToFront();
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=30,null,{timeout:180000});
    assert(!await page.evaluate(()=>globalThis.__webEngineFailure));run.first30FramesMs=Date.now()-start;
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    // Game can publish frame 30 before RHI publishes its first 30-frame diagnostics.
    const diagnosticsDeadline=Date.now()+30000;
    while(!await owner.evaluate(()=>!!globalThis.__webOptimizationRHI)){
      assert(Date.now()<diagnosticsDeadline,'RHI diagnostics did not become ready');
      await page.waitForTimeout(100);
    }
    const state=()=>owner.evaluate(()=>({frame:__webRHIFrames,game:__webEngineFrames,arguments:Module.arguments,
      rhi:__webOptimizationRHI,pso:__webPSOPrecache,history:__webOcclusionHistory,clock:__webGameFrameClock,threads:globalThis.__webEngineThreads,
      wake:__webRHIWakeScheduler,camera:__webDefaultCamera,view:__webRenderView,settings:__webProjectSettings,
      streaming:__webTextureStreaming,io:globalThis.__webContentIO?.stats,
      counts:__runtimePSOCapture.counts,pending:__runtimePSOCapture.pending,failures:__runtimePSOCapture.failures,scheduling:__runtimePSOCapture.scheduling,
      usage:__runtimePSOCapture.usage,
      failure:globalThis.__webEngineFailure}));
    run.initial=await state();assert(!run.initial.arguments.includes('-WebPSOPrecacheTest'));assert(!run.initial.pso.enabled);
    if(run.coreLimit){assert.equal(run.initial.threads.cores,run.coreLimit);assert.equal(run.initial.threads.taskWorkers,run.coreLimit-1);}
    assert.equal(run.initial.arguments.includes('-WebRuntimeAsyncPSO'),mode==='async');
    assert.equal(run.initial.rhi.runtimeAsyncPSO,mode==='async');
    assert.equal(run.initial.clock.mode,'local');assert.equal(run.initial.wake.active,'priority');assert(run.initial.history.enabled);
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=600&&
      globalThis.__webTextureStreaming?.pending===0,null,{timeout:120000});
    assert(!await page.evaluate(()=>globalThis.__webEngineFailure));await page.waitForTimeout(warmup*1000);
    run.ready=await state();save();
    async function capture(name,action){
      const before=await state();const begin=await owner.evaluate(name=>{const c=__runtimePSOCapture;c.frames=[];c.events=[];c.active=true;
        performance.mark('RuntimePSO.'+name+'.begin');return performance.now();},name);
      await action();const data=await owner.evaluate(()=>{const c=__runtimePSOCapture;c.active=false;return{frames:c.frames,events:c.events};});
      const end=await owner.evaluate(name=>{performance.mark('RuntimePSO.'+name+'.end');return performance.now();},name);
      const after=await state(),summary=summarize(data);run.phases.push({name,begin,end,before,after,summary,data});save();
      console.log(JSON.stringify({index:run.index,mode,phase:name,...summary,worst:summary.worst.slice(0,2)}));
      assert(!run.errors.length&&!after.failure&&!after.failures.length,run.errors.join('\n'));
    }
    await capture('standing',()=>page.waitForTimeout(5000));
    const camera=run.ready.camera;
    const tour=async()=>{for(const delta of [0,90,180,270,0]){
      assert.equal(await page.evaluate(v=>__webEngineRPC('WebProjectViewTest',v.x,v.y,v.z,v.pitch,v.yaw),{...camera,yaw:camera.yaw+delta}),1);
      await page.waitForTimeout(hold*1000);
    }};
    let traceDone;
    if(trace){
      run.histogramsBefore=(await cdp.send('Browser.getHistograms')).histograms.filter(h=>/dawn|webgpu|(?:^|\.)tint(?:\.|$)/i.test(h.name));
      traceDone=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));
      await cdp.send('Tracing.start',{categories:'toplevel,devtools.timeline,blink.user_timing,gpu,gpu.dawn,disabled-by-default-gpu.dawn,disabled-by-default-gpu.service',transferMode:'ReturnAsStream'});
      run.traceClock=await owner.evaluate(()=>{const now=performance.now();performance.mark('RuntimePSO.clock');return{now,timeOrigin:performance.timeOrigin};});
    }
    await capture('first-tour',tour);await capture('repeat-tour',tour);
    if(captureCorpus){
      const corpus=await owner.evaluate(()=>{__webStartupProfile.freeze();return __webStartupProfile.exportPSOCorpus();});
      const phase=run.phases.find(p=>p.name==='first-tour');
      const timeOrigin=await owner.evaluate(()=>performance.timeOrigin);
      corpus.requests=corpus.requests.filter(r=>r.start>=timeOrigin+phase.begin&&r.start<=timeOrigin+phase.end);
      const ids=new Set(corpus.requests.map(r=>r.descriptorId));corpus.descriptors=corpus.descriptors.filter(d=>ids.has(d.id));
      const modules=new Set(corpus.descriptors.flatMap(d=>['vertex','fragment','compute'].map(s=>d.descriptor[s]?.module?.id).filter(Boolean)));
      corpus.modules=corpus.modules.filter(m=>modules.has(m.id));
      run.corpusFile=output+'-'+run.index+'-'+mode+'-corpus.json';
      fs.writeFileSync(run.corpusFile,JSON.stringify(corpus));run.corpus=audit(run.corpusFile);
    }
    if(trace){
      await cdp.send('Tracing.end');const {stream}=await traceDone;
      run.traceFile=output+'-'+run.index+'-'+mode+'-trace.json';const fd=fs.openSync(run.traceFile,'w');
      try{for(;;){const chunk=await cdp.send('IO.read',{handle:stream,size:1024*1024});
        fs.writeSync(fd,Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8'));if(chunk.eof)break;}}
      finally{fs.closeSync(fd);await cdp.send('IO.close',{handle:stream});}
      run.trace=audit(run.traceFile);
      run.histogramsAfter=(await cdp.send('Browser.getHistograms')).histograms.filter(h=>/dawn|webgpu|(?:^|\.)tint(?:\.|$)/i.test(h.name));
    }
    await page.locator('canvas').screenshot({path:output+'-'+run.index+'-'+mode+'.png'});
    run.final=await state();assert(!run.final.pso.enabled);assert.equal(run.final.rhi.asyncPrecacheRequested,0);
    assert.equal(run.final.pending,0);assert.equal(run.final.rhi.runtimeAsyncFailed,0);
    if(mode==='async')assert(run.final.rhi.runtimeAsyncCompleted>0,'Must complete actual runtime asynchronous PSOs');
    if(verifyUse){
      for(const kind of ['Render','Compute'])assert(run.final.usage['create'+kind+'Pipeline'+(mode==='async'?'Async':'')]?.unique>0,
        'Must actually bind '+kind+' pipelines returned by the selected API');
    }
    run.pass=true;save();await context.close();context=null;log.end();log=null;
  }
  const ref=report.runs[0].ready;
  for(const run of report.runs){assert.deepEqual(run.ready.settings,ref.settings);assert.deepEqual(run.ready.camera,ref.camera);
    for(const k of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(run.ready.view[k],ref.view[k]);}
  report.packageFiles.forEach(f=>assert.equal(audit(f.file).sha256,f.sha256));report.pass=true;
}catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{save();await context?.close();log?.end();}})();
