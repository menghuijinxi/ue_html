'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder'),tag=option('tag');
assert([folder,tag].every(v=>v&&/^[a-z0-9-]+$/.test(v)));
const modes=(option('modes')||'owner,local,local,owner').split(',');
assert(modes.every(v=>['owner','local'].includes(v)));
const seconds=Number(option('seconds')||20),warmup=Number(option('warmup')||15);
const width=Number(option('width')||2289),height=Number(option('height')||1287);
assert(seconds>=5&&seconds<=60&&warmup>=5&&warmup<=60);
assert(Number.isInteger(width)&&Number.isInteger(height)&&width>=640&&height>=480);
const base=path.join(__dirname,'build',folder),output=path.join(__dirname,'results',tag);
assert(!fs.existsSync(output+'.json'),'Use a fresh measurement tag');
fs.copyFileSync(__filename,output+'-source.cjs');
const report={date:new Date().toISOString(),folder,modes,seconds,warmup,width,height,pass:false,runs:[],qualityOverrides:[],
  source:audit(output+'-source.cjs'),
  packageFiles:['index.html','UEWebEngineThreads.js','UEWebEngineThreads.wasm','config-files.json','content-files.json',
    'web-engine-host.js','web-engine-worker.js'].map(f=>audit(path.join(base,f))),
  methodology:'Visible Edge, identical package/settings; explicit PSO precaching enabled and completed before capture. First-area is the first traversal per engine session, with browser/driver caches retained. Moving/turning routes warmed before steady measurements. A disabled-by-default benchmark updates the camera directly before every Game tick using wall-clock interpolation. RPC is used only to start/reset a route. This scripted camera tour bypasses pawn collision and is not a keyboard/mouse latency test. No profiler, browser trace, per-draw wrapper or extra GPU query. FPS measures RHI submission throughput.'};
const save=()=>fs.writeFileSync(output+'.json',JSON.stringify(report,null,2)+'\n');
function install(){
  const c=globalThis.__motionCapture={active:false,times:[],cameras:[],counts:{},events:[]};
  let frame=0,camera,lastCamera=-Infinity;
  Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,get:()=>frame,set(v){
    if(c.active&&v>frame)c.times.push(performance.now());frame=v;
  }});
  Object.defineProperty(globalThis,'__webDefaultCamera',{configurable:true,get:()=>camera,set(v){
    camera=v;const now=performance.now();if(c.active&&now-lastCamera>=100){
      c.cameras.push({time:now,...v});lastCamera=now;
    }
  }});
  let motion;
  Object.defineProperty(globalThis,'__webMotionBenchmark',{configurable:true,get:()=>motion,set(v){
    motion=v;
    if(c.active&&v.completed&&v.duration>0){c.end=performance.now();c.frames=frame-c.first;c.active=false;}
  }});
  for(const name of ['createRenderPipeline','createComputePipeline','createRenderPipelineAsync','createComputePipelineAsync','createShaderModule']){
    const original=GPUDevice.prototype[name];if(!original)continue;
    GPUDevice.prototype[name]=function(...args){
      c.counts[name]=(c.counts[name]||0)+1;
      if(c.active)c.events.push({name,time:performance.now(),label:args[0]?.label});
      return original.apply(this,args);
    };
  }
}
function pose(kind,t,spawn){
  const room={x:-175,y:-80,z:160,pitch:-5,yaw:50};
  if(kind==='moving'){
    const u=(1-Math.cos(t*8*Math.PI))/2;
    return {...room,x:room.x+275*u,y:room.y+20*u};
  }
  if(kind==='turning')return {...room,yaw:room.yaw+360*t};
  const points=[spawn,{x:610,y:-225,z:170,pitch:-4,yaw:20},
    {x:100,y:-60,z:150,pitch:-10,yaw:50},
    {x:-730,y:-255,z:155,pitch:0,yaw:110},
    {x:-620,y:0,z:160,pitch:0,yaw:0}];
  const step=Math.min(3,Math.floor(t*4)),u=t*4-step,a=points[step],b=points[step+1];
  const result={};for(const k of ['x','y','z','pitch'])result[k]=a[k]+(b[k]-a[k])*u;
  const dy=((b.yaw-a.yaw+540)%360)-180;result.yaw=a.yaw+dy*u;return result;
}
function summarize(data){
  const intervals=data.times.slice(1).map((v,i)=>v-data.times[i]);assert(intervals.length>100);
  const sorted=[...intervals].sort((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length*.01));
  let travel=0,turn=0,movingSamples=0;
  for(let i=1;i<data.cameras.length;i++){
    const a=data.cameras[i-1],b=data.cameras[i],d=Math.hypot(b.x-a.x,b.y-a.y,b.z-a.z);
    travel+=d;turn+=Math.abs(((b.yaw-a.yaw+540)%360)-180);
    if(d>.1)movingSamples++;
  }
  return {frames:data.frames,durationSeconds:(data.end-data.start)/1000,fps:data.frames*1000/(data.end-data.start),
    low1Fps:tail.length*1000/tail.reduce((s,v)=>s+v,0),maximumMs:sorted.at(-1),
    cameraSamples:data.cameras.length,travelCm:travel,turnDegrees:turn,movingSampleFraction:movingSamples/(data.cameras.length-1),
    creations:data.events.reduce((r,e)=>(r[e.name]=(r[e.name]||0)+1,r),{}),intervals};
}
let context,log;
(async()=>{try{
  for(const mode of modes){
    const run={index:report.runs.length+1,mode,errors:[],phases:[]};report.runs.push(run);save();
    run.idleGpu=execFileSync('nvidia-smi',['--query-gpu=name,utilization.gpu,memory.used','--format=csv,noheader,nounits'],
      {encoding:'utf8',windowsHide:true,timeout:10000}).trim();
    assert(run.idleGpu.split(/\r?\n/).every(v=>Number(v.split(',').at(-2))<=50),'GPU busy before test');
    context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/scheduling-motion-pso'),
      {channel:'msedge',headless:false,viewport:{width,height},deviceScaleFactor:1});
    await context.route('**/web-engine-worker.js?*',async route=>{
      const response=await route.fetch();await route.fulfill({response,body:'('+install.toString()+')();\n'+await response.text()});
    });
    const page=context.pages()[0],cdp=await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents',{ignore:true});
    await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
    log=fs.createWriteStream(output+'-'+run.index+'-'+mode+'.log');
    page.on('console',m=>{const t=m.text();log?.write(t+'\n');
      if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(t))run.errors.push(t);});
    page.on('pageerror',e=>run.errors.push(e.message));page.on('crash',()=>run.errors.push('Page crashed'));
    run.url='http://127.0.0.1:8765/build/'+folder+'/index.html?occlusion=history&clock='+mode+'&rhiwake=priority';
    console.log('Motion start',run.index,mode);await page.goto(run.url,{waitUntil:'commit'});await page.bringToFront();
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=600&&
      globalThis.__webPSOPrecacheExpected&&globalThis.__webPSOPrecacheReady&&globalThis.__webTextureStreaming?.pending===0,
      null,{timeout:600000});
    assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    const state=()=>owner.evaluate(()=>({frame:__webRHIFrames,game:__webEngineFrames,camera:__webDefaultCamera,
      view:__webRenderView,settings:__webProjectSettings,streaming:__webTextureStreaming,
      pso:__webPSOPrecache,optimization:__webOptimizationRHI,clock:__webGameFrameClock,wake:__webRHIWakeScheduler,
      history:__webOcclusionHistory,motion:globalThis.__webMotionBenchmark,
      arguments:Module.arguments,counts:__motionCapture.counts,failure:globalThis.__webEngineFailure}));
    async function settled(){
      const deadline=Date.now()+120000;
      for(;;){const s=await state();assert(!s.failure&&!run.errors.length,run.errors.join('\n'));
        if(s.streaming.pending===0&&s.pso.active===0&&s.pso.filePrecompileTasks===0&&
          s.optimization.asyncPrecacheRequested===s.optimization.asyncPrecacheCompleted)return;
        assert(Date.now()<deadline,'PSO/streaming did not settle');await page.waitForTimeout(200);
      }
    }
    await settled();await page.waitForTimeout(warmup*1000);run.ready=await state();
    assert(run.ready.pso.enabled&&run.ready.arguments.includes('-WebPSOPrecacheTest'));
    assert.equal(run.ready.clock.mode,mode);assert.equal(run.ready.wake.active,'priority');assert(run.ready.history.enabled);
    assert.equal(run.ready.optimization.runtimeAsyncPSO,false);
    const spawn=run.ready.camera;run.routes={spawn,movingStart:pose('moving',0,spawn),firstAreaEnd:pose('first-area',1,spawn)};
    async function route(kind,duration){
      const mode={moving:1,turning:2,'first-area':3}[kind];
      const serial=await page.evaluate(({mode,duration})=>__webEngineRPC('WebMotionBenchmarkControl',mode,duration),{mode,duration});
      assert(serial>0,'Motion benchmark did not start');
      await page.waitForFunction(serial=>globalThis.__webEngineFailure||
        globalThis.__webMotionBenchmark?.serial===serial&&globalThis.__webMotionBenchmark.completed,
        serial,{timeout:duration*1000+30000});
      assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
      const driver=await owner.evaluate(()=>__webMotionBenchmark);
      assert.equal(driver.serial,serial);assert.equal(driver.driver,'game-frame');
      if(duration>0)assert(driver.updates>duration*20,'Camera must update on Game frames');
      return driver;
    }
    async function setStart(kind){
      await route(kind,0);
      await page.waitForTimeout(700);await settled();
    }
    async function capture(name,kind){
      await setStart(kind);const before=await state();
      await owner.evaluate(()=>{const c=__motionCapture;c.times=[];c.cameras=[];c.events=[];c.start=performance.now();c.end=null;c.frames=null;c.first=__webRHIFrames;c.active=true;});
      const driver=await route(kind,seconds);
      const data=await owner.evaluate(()=>{const c=__motionCapture;return {start:c.start,end:c.end,frames:c.frames,times:c.times,cameras:c.cameras,events:c.events};});
      assert(data.end>data.start&&data.frames>0,'Completion must stop the owner capture');
      const after=await state(),summary=summarize(data);assert(!run.errors.length&&!after.failure,run.errors.join('\n'));
      assert.deepEqual(before.settings,after.settings);
      for(const k of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(before.view[k],after.view[k]);
      if(kind==='turning')assert(summary.turnDegrees>300&&summary.travelCm<1,'Camera must rotate continuously in place');
      else assert(summary.travelCm>500&&summary.movingSampleFraction>.8,'Camera must actually move throughout capture');
      const phase={name,kind,before,after,driver,data,summary};run.phases.push(phase);save();
      console.log(JSON.stringify({index:run.index,mode,phase:name,...summary,intervals:undefined}));
      await page.locator('canvas').screenshot({path:output+'-'+run.index+'-'+name+'.png'});
      return phase;
    }
    await capture('first-area','first-area');
    for(const kind of ['moving','turning']){
      await setStart(kind);await route(kind,5);await settled();await page.waitForTimeout(2000);
      const phase=await capture(kind,kind);
      if(phase.data.events.length){
        phase.steadyAccepted=false;await settled();await page.waitForTimeout(2000);
        const repeat=await capture(kind+'-warm-retry',kind);assert.equal(repeat.data.events.length,0,'Steady route still creates pipelines/shaders');repeat.steadyAccepted=true;
      }else phase.steadyAccepted=true;
    }
    await capture('repeat-area','first-area');
    run.final=await state();assert.equal(run.final.optimization.asyncPrecacheFailed,0);run.pass=true;save();
    await context.close();context=null;log.end();log=null;
  }
  const reference=report.runs[0].ready;
  for(const r of report.runs){assert.deepEqual(r.ready.settings,reference.settings);assert.deepEqual(r.ready.camera,reference.camera);
    for(const k of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(r.ready.view[k],reference.view[k]);}
  report.packageFiles.forEach(f=>assert.equal(audit(f.file).sha256,f.sha256));
  report.summary={};
  for(const name of ['first-area','moving','turning','repeat-area']){
    const entry=report.summary[name]={};
    for(const mode of new Set(modes)){
      const phases=report.runs.filter(r=>r.mode===mode).map(r=>r.phases.filter(p=>p.name===name||p.name===name+'-warm-retry').findLast(p=>p.steadyAccepted!==false));
      const frames=phases.reduce((s,p)=>s+p.data.frames,0),ms=phases.reduce((s,p)=>s+p.data.end-p.data.start,0);
      const sorted=phases.flatMap(p=>p.summary.intervals).sort((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length*.01));
      entry[mode]={fps:frames*1000/ms,low1Fps:tail.length*1000/tail.reduce((s,v)=>s+v,0),
        runs:phases.map(p=>p.summary.fps),frames,seconds:ms/1000,pipelineShaderCreates:phases.map(p=>p.data.events.length)};
    }
    if(entry.owner&&entry.local)entry.fpsGainPercent=(entry.local.fps/entry.owner.fps-1)*100;
  }
  report.pass=true;console.log(JSON.stringify(report.summary));
}catch(error){report.error=error.stack;console.error(error.stack);process.exitCode=1;}
finally{save();await context?.close();log?.end();}})();
