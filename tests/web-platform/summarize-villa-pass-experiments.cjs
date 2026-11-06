'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results');
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,''));
function metrics(values){
  assert(values.length>=100&&values.every(v=>Number.isFinite(v)&&v>0));
  const sorted=values.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length*.01));
  return {frames:values.length,fps:1000*values.length/values.reduce((a,b)=>a+b,0),
    low1:1000*tail.length/tail.reduce((a,b)=>a+b,0),p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1),
    over33:values.filter(v=>v>33.333).length,over50:values.filter(v=>v>50).length};
}
function capture(tag){
  const raw=read(tag+'.json');assert(raw.pass);assert.deepEqual(raw.errors,[]);
  const runs=raw.runs.map(v=>{
    assert.equal(v.before.clock.mode,'owner');assert.deepEqual(v.before.camera,v.after.camera);
    assert.deepEqual(v.before.settings,v.after.settings);assert.equal(v.before.view.width,1280);assert.equal(v.before.view.height,720);
    assert.equal(v.before.view.outputWidth,1280);assert.equal(v.before.view.outputHeight,720);assert.equal(v.before.view.antiAliasing,4);
    assert.equal(v.before.settings.gi,0);assert.equal(v.before.settings.reflections,0);
    const a=v.before.occlusion,b=v.after.occlusion,n=b.sampleFrame-a.sampleFrame;
    const perFrame=Object.fromEntries(['renderPassesOpened','computePassesOpened','computePassesReused','draws','dispatches',
      'bindGroupsCreated','bindingEntriesPrepared','bindingEntriesReused'].map(k=>[k,(b[k]-a[k])/n]));
    const done=v.capture.frames.filter(f=>Number.isFinite(f.done)&&Number.isFinite(f.submit));
    const scratch=v.after.replayScratch?{state:v.after.replayScratch,
      measured:Object.fromEntries(['calls','allocations','reuses'].map(k=>[k,v.after.replayScratch[k]-v.before.replayScratch[k]]))}:null;
    return {result:v.result,rhiMs:v.rhiMs,perFrame,replayScratch:scratch,
      gpu:done.length?{peak:v.capture.pendingPeak,meanMs:done.reduce((s,f)=>s+f.done-f.submit,0)/done.length,
        maxMs:Math.max(...done.map(f=>f.done-f.submit))}:null};
  });
  return {raw,summary:{tag,folder:raw.folder,raw:audit(path.join(root,tag+'.json')),log:audit(path.join(root,tag+'.log')),
    image:audit(path.join(root,tag+'.png')),gpuCompletionProbe:raw.gpuCompletionProbe,runs,
    tour:raw.tour??null,readback:raw.readbackTest??null}};
}
function aggregate(captures){
  const runs=captures.flatMap(c=>c.raw.runs),intervals=runs.flatMap(v=>v.capture.frames.slice(1).map((f,i)=>f.at-v.capture.frames[i].at));
  const frames=runs.reduce((s,v)=>s+v.after.frame-v.before.frame,0);
  return {...metrics(intervals),rhiMs:runs.reduce((s,v)=>s+v.after.stages.rhiWorkMilliseconds-v.before.stages.rhiWorkMilliseconds,0)/frames};
}
function comparison(onTags,offTags){
  const on=onTags.map(capture),off=offTags.map(capture),a=aggregate(on),b=aggregate(off);
  assert([...on,...off].every(c=>!c.raw.gpuCompletionProbe&&!c.raw.presentMonEnabled));
  for(const c of [...on,...off])for(const r of c.raw.runs){
    assert.deepEqual(r.before.camera,on[0].raw.runs[0].before.camera);
    assert.deepEqual(r.before.settings,on[0].raw.runs[0].before.settings);
  }
  return {on:a,off:b,relative:{fps:a.fps/b.fps-1,low1:a.low1/b.low1-1,rhiMs:a.rhiMs/b.rhiMs-1},
    captures:[...on,...off].map(c=>c.summary)};
}
function native(tag){
  const launch=read(tag+'-launch.json'),complete=read(tag+'-complete.json');
  const lines=fs.readFileSync(path.join(root,tag+'.csv'),'utf8').trim().split(/\r?\n/),header=lines[0].split(',');
  const p=launch.phases[0],rows=lines.slice(p.start+1,p.end+1).map(l=>l.split(','));
  const column=k=>{const i=header.indexOf(k);assert(i>=0);return rows.map(r=>Number(r[i]));};
  return {tag,raw:['.csv','.log','.png','-launch.json','-complete.json'].map(s=>audit(path.join(root,tag+s))),
    stats:metrics(column('FrameTime')),workload:Object.fromEntries(['RHI/DrawCalls','RHIThreadTime','GPUTime','DrawCall/ShadowDepths']
      .map(k=>[k,column(k).reduce((a,b)=>a+b,0)/rows.length])),exitCode:complete.exitCode,cleanExit:complete.cleanExit};
}
function fixedRoute(kind){
  const tag='parity-pass-'+kind+'-route-20261106',r=read(tag+'.json');
  assert(r.pass);assert.deepEqual(r.modes,['owner']);assert.deepEqual(r.qualityOverrides,[]);
  assert.equal(r.width,1280);assert.equal(r.height,720);
  const run=r.runs[0];assert.deepEqual(run.errors,[]);assert.equal(run.ready.clock.mode,'owner');
  return {raw:r,summary:{tag,raw:audit(path.join(root,tag+'.json')),source:r.source,
    log:audit(path.join(root,tag+'-1-owner.log')),ready:run.ready,
    phases:run.phases.map(p=>({name:p.name,steadyAccepted:p.steadyAccepted,driver:p.driver,
      result:metrics(p.summary.intervals),camera:{travelCm:p.summary.travelCm,turnDegrees:p.summary.turnDegrees,
        before:p.before.camera,after:p.after.camera},creations:p.summary.creations,
      image:audit(path.join(root,tag+'-1-'+p.name+'.png'))}))}};
}
const rdg=comparison(['parity-rdg-merge-on-1-20261106','parity-rdg-merge-on-2-20261106'],['parity-rdg-merge-off-12-20261106']);
const scratch=comparison(['parity-replay-scratch-on-1-20261106','parity-replay-scratch-on-2-20261106'],['parity-replay-scratch-off-12-20261106']);
const combined=comparison(['parity-pass-combined-normal-20261106'],['parity-replay-scratch-off-12-20261106','parity-pass-reference-repeat-20261106']);
const combinedVsCompute=comparison(['parity-pass-combined-normal-20261106'],['parity-pass-compute-only-normal-20261106']);
const gpu=['combined','reference'].map(k=>capture('parity-pass-'+k+'-gpu-20261106').summary);
for(const c of gpu)assert(c.readback.pass);
const motion=['combined','reference'].map(k=>{
  const tag='parity-pass-'+k+'-motion-20261106',r=read(tag+'.json');assert(r.pass&&r.packagedInput);assert.deepEqual(r.modes,['owner']);
  return {tag,raw:audit(path.join(root,tag+'.json')),log:audit(path.join(root,tag+'-1-owner.log')),
    image:audit(path.join(root,tag+'-1-owner.png')),runs:r.runs.map(v=>({result:v.result,gpu:v.gpuSummary,travel:v.travel,
    turn:v.turn,rhiMs:v.rhiMs,workload:v.workload,display:v.display,errors:v.errors}))};
});
const routeCaptures=['combined','reference','compute-only'].map(fixedRoute);
for(const r of routeCaptures){
  assert.deepEqual(r.summary.ready.camera,routeCaptures[0].summary.ready.camera);
  assert.deepEqual(r.summary.ready.settings,routeCaptures[0].summary.ready.settings);
  for(const p of r.raw.runs[0].phases){
    assert.equal(p.before.view.width,1280);assert.equal(p.before.view.height,720);
    assert.deepEqual(p.before.settings,r.summary.ready.settings);
    assert.deepEqual(p.before.settings,p.after.settings);
    const reference=routeCaptures[0].raw.runs[0].phases.find(q=>q.name===p.name);
    if(reference)for(const end of ['before','after'])for(const key of ['x','y','z','pitch','yaw'])
      assert(Math.abs(p[end].camera[key]-reference[end].camera[key])<.1,'Fixed route endpoint changed: '+p.name+'/'+end+'/'+key);
  }
}
const desktop=native('parity-native-csm-repeat-20261106');
const turnResult=kind=>routeCaptures.find(c=>c.summary.tag==='parity-pass-'+kind+'-route-20261106').summary.phases.find(p=>p.name==='turning').result;
const combinedTurn=turnResult('combined'),computeTurn=turnResult('compute-only');
const nativeLog=fs.readFileSync(path.join(root,desktop.tag+'.log'),'utf8');assert(nativeLog.includes('r.FinishCurrentFrame = "0"'));
const packages=['villa-replay-scratch-off-20261106','villa-replay-scratch-on-20261106','villa-pass-reuse-combined-20261106','villa-pass-compute-only-20261106'].map(folder=>{
  const base=path.join(__dirname,'build',folder),manifest=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [file,v] of Object.entries(manifest))assert.equal(audit(path.join(base,file)).sha256,v.sha256);
  return {folder,manifest:audit(path.join(base,'asset-versions.json')),products:manifest};
});
for(const p of packages)for(const n of ['UEWebEngineThreads.wasm','UEWebEngineThreads.js','content.bin','content-files.json'])
  assert.equal(p.products[n].sha256,packages[0].products[n].sha256);
const report={date:new Date().toISOString(),pass:true,performanceAccepted:false,physicalPresentationValidated:false,
  controls:{resolution:[1280,720],clock:'owner',rhiWake:'priority',fpsCap:0,vsync:0,csmCaching:1,renderAhead:0,
    unchanged:'Cook, shaders, lighting, dispatches, browser owner frame scheduling and browser backpressure'},
  lowDefinition:'1000 divided by mean of slowest ceil(N*0.01) intervals. All long frames retained; no cross-run gaps.',
  rdg,scratch,combined,combinedVsCompute,gpu,motion,routes:routeCaptures.map(r=>r.summary),desktop,packages,
  decision:{enableByDefault:false,reason:'No stable improvement across static and moving cases; native parity and physical presentation remain unverified.',
    combinedTurningVsComputeOnly:{fps:combinedTurn.fps/computeTurn.fps-1,low1:combinedTurn.low1/computeTurn.low1-1,
      maximumMs:{computeOnly:computeTurn.max,combined:combinedTurn.max}},
    boundary:'One fixed-route run per variant is regression screening, not statistical proof of causation.'},
  parity:{fpsGap:1-combined.on.fps/desktop.stats.fps,low1Gap:1-combined.on.low1/desktop.stats.low1},
  visual:['parity-rdg-merge-tour-comparison-20261106','parity-pass-combined-tour-comparison-20261106'].map(tag=>({
    raw:audit(path.join(root,tag+'.json')),contactSheet:audit(path.join(root,tag+'.jpg')),...read(tag+'.json')})),
  nativeWebView:audit(path.join(root,'parity-pass-native-web-view-20261106.jpg')),
  builds:['parity-rdg-merge-build-20261106.json','parity-replay-scratch-build-20261106.json'].map(n=>audit(path.join(root,n))),
  replayValidation:{...read('parity-replay-scratch-validation-20261106.json'),raw:audit(path.join(root,'parity-replay-scratch-validation-20261106.json'))},
  testPage:{source:audit(path.join(__dirname,'villa-parity-test.html')),
    validation:audit(path.join(root,'parity-pass-test-page-20261106.json')),
    screenshot:audit(path.join(root,'parity-pass-test-page-20261106.png'))},
  limitations:['The first RDG-enabled window fell to 77 FPS and is retained. Background activity was observed afterward, not causally attributed to that window.',
    'GPU completion callbacks and RHI submission intervals do not verify physical presentation.',
    'Motion is a regression stress test; actual paths and draw counts vary with timing.',
    'Native 777003 is the existing post-CSV/log-close exit failure, not a clean process lifecycle pass.',
    'Experiments remain opt-in; browser/native average and 1% low parity is not achieved.']};
const output=path.join(__dirname,'evidence/villa-pass-experiments-20261106.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,rdg:{on:rdg.on,off:rdg.off},scratch:{on:scratch.on,off:scratch.off},combined:{on:combined.on,off:combined.off},computeOnly:combinedVsCompute.off,desktop:desktop.stats,parity:report.parity}));
