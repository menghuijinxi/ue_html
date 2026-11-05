'use strict';
// Compare first-turn stalls with UE component/global precaching off/on.
// The enabled side may have no first-use PSO events at all.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const [tag]=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(tag));
const prefix=path.resolve(__dirname,'../results',tag);
const report=JSON.parse(fs.readFileSync(prefix+'.json'));
assert(report.pass&&!report.trace&&!report.captureCorpus&&!report.verifyUse);
assert.deepEqual(report.precacheModes,['off','on','on','off']);
assert(report.disableDiskCache&&report.qualityOverrides.length===0);
const median=values=>{const a=values.toSorted((a,b)=>a-b);return(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2;};
const stats=frames=>({maximumMs:frames.length?Math.max(...frames.map(f=>f.ms)):null,
  over50:frames.filter(f=>f.ms>50).length,over100:frames.filter(f=>f.ms>100).length});
const output={date:new Date().toISOString(),pass:false,input:audit(prefix+'.json'),source:audit(__filename),
  probe:report.source,packageFiles:report.packageFiles,
  boundary:'Four fresh Edge launches, off/on/on/off, same WASM/Cook/view and three UE TaskGraph workers. Enabling UE automatic component/global precaching also activates its existing dedicated pool of eight workers and waits for real completion before the first camera tour. No camera warm tour, trace or per-bind wrapper; browser shader disk cache disabled, driver cache retained. This tests advance preparation and actual object reuse, not equal compiler concurrency or faster compilation. Frame intervals are viewport submissions, not physical presentation. Equivalent single-frame FPS is 1000 / worst frame milliseconds, not a one-second average. Request-overlapping frames are associated with PSO preparation, not pure compiler CPU time. Startup first-30-frame timing is a load milestone, not exact first visibility or interactivity. Static route only; dynamic streaming and material changes remain untested.',
  view:report.runs[0].ready.view,settings:report.runs[0].ready.settings,camera:report.runs[0].ready.camera,
  runs:[],groups:[]};
let offLabels;
for(const run of report.runs){
  assert(run.pass&&run.mode==='async'&&run.schedule==='fifo');
  assert.equal(run.ready.threads.taskWorkers,3);assert.equal(run.coreLimit,4);
  assert.deepEqual(run.errors,[]);assert.deepEqual(run.final.failures,[]);
  assert.equal(run.final.pending,0);assert.equal(run.final.rhi.runtimeAsyncFailed,0);
  assert.equal(run.ready.pso.enabled,run.precache);assert.equal(run.ready.pso.active,0);
  assert.deepEqual(run.ready.settings,output.settings);assert.deepEqual(run.ready.camera,output.camera);
  for(const key of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(run.ready.view[key],output.view[key]);
  const first=run.phases.find(p=>p.name==='first-tour'),repeat=run.phases.find(p=>p.name==='repeat-tour');
  assert(first&&repeat);const frames=first.data.frames;
  for(let i=1;i<frames.length;i++){
    assert(frames[i].time>frames[i-1].time);
    assert(Math.abs(frames[i].time-frames[i].ms-frames[i-1].time)<0.001,'Missing captured frame');
  }
  const requests=first.data.events.filter(e=>e.name.includes('Pipeline')).toSorted((a,b)=>a.start-b.start);
  assert(requests.every(e=>e.name.endsWith('Async')&&Number.isFinite(e.completed)&&e.completed>=e.start&&!e.error));
  const creations={};
  for(const key of new Set([...Object.keys(first.before.counts),...Object.keys(first.after.counts)])){
    const count=(first.after.counts[key]||0)-(first.before.counts[key]||0);
    assert.equal(count,first.data.events.filter(e=>e.name===key).length,'Creation outside captured interval');
    if(count)creations[key]=count;
  }
  if(run.precache){
    assert.equal(requests.length,0);assert.equal(first.data.events.length,0);
    assert(run.ready.rhi.asyncPrecacheRequested>0);
    assert.equal(run.ready.rhi.asyncPrecacheRequested,run.ready.rhi.asyncPrecacheCompleted);
    assert.equal(run.ready.rhi.asyncPrecacheFailed,0);
    assert(first.after.rhi.precachedGraphicsUsed>first.before.rhi.precachedGraphicsUsed,'Must use more prepared PSOs on first tour');
  }else{
    assert.equal(requests.length,15);assert.equal(run.ready.rhi.asyncPrecacheRequested,0);
    const labels=requests.map(e=>e.label).sort();if(offLabels)assert.deepEqual(labels,offLabels);else offLabels=labels;
  }
  const bursts=[];
  for(const request of requests){
    const last=bursts.at(-1);
    if(!last||request.start>last.end)bursts.push({start:request.start,end:request.completed,requests:[request]});
    else{last.end=Math.max(last.end,request.completed);last.requests.push(request);}
  }
  const affected=new Set();
  const events=bursts.map(burst=>{
    const overlapping=frames.filter(f=>f.time>burst.start&&f.time-f.ms<burst.end);assert(overlapping.length);
    overlapping.forEach(f=>affected.add(f.frame));const last=overlapping.at(-1);
    assert(first.end>last.time+500);
    return {startOffsetMs:burst.start-first.begin,pendingSpanMs:burst.end-burst.start,
      requests:burst.requests.map(e=>({label:e.label,startMs:e.start-burst.start,completedMs:e.completed-burst.start})),
      frames:overlapping.map(f=>({frame:f.frame,ms:f.ms,startMs:f.time-f.ms-burst.start,endMs:f.time-burst.start})),
      associated:stats(overlapping),submissionsWhilePending:frames.filter(f=>f.time>=burst.start&&f.time<burst.end).length,
      post500ms:stats(frames.filter(f=>f.time>last.time&&f.time<=last.time+500))};
  });
  const firstStats=stats(frames);
  output.runs.push({index:run.index,precache:run.precache,taskWorkers:run.ready.threads.taskWorkers,
    precachePool:run.ready.rhi.precacheConcurrency,browser:run.browser,idleGpu:run.idleGpu,
    arguments:run.ready.arguments,first30FramesMs:run.first30FramesMs,precacheReadyObservedMs:run.precacheReadyMs,
    ready:{requested:run.ready.rhi.asyncPrecacheRequested,completed:run.ready.rhi.asyncPrecacheCompleted,
      failed:run.ready.rhi.asyncPrecacheFailed,unsupportedSpeculativeRequests:run.ready.rhi.unsupportedPrecacheRequests,
      active:run.ready.pso.active,pending:run.ready.pending},
    used:{before:first.before.rhi.precachedGraphicsUsed,after:first.after.rhi.precachedGraphicsUsed,
      new:first.after.rhi.precachedGraphicsUsed-first.before.rhi.precachedGraphicsUsed},
    firstTour:{...firstStats,equivalentSingleFrameFps:1000/firstStats.maximumMs,creations,events,
      outsidePSOFramesOver50:frames.filter(f=>f.ms>50&&!affected.has(f.frame)).map(f=>({frame:f.frame,ms:f.ms,offsetMs:f.time-first.begin}))},
    repeatTour:{...stats(repeat.data.frames),creations:repeat.summary.creations},
    screenshot:audit(prefix+'-'+run.index+'-'+run.mode+'.png')});
}
for(const precache of [false,true]){
  const runs=output.runs.filter(r=>r.precache===precache),maximumMs=median(runs.map(r=>r.firstTour.maximumMs));
  output.groups.push({precache,runs:runs.length,medianFirstTourWorstFrameMs:maximumMs,
    equivalentSingleFrameFps:1000/maximumMs,medianFirst30FramesMs:median(runs.map(r=>r.first30FramesMs)),
    firstTourFramesOver100:runs.reduce((sum,r)=>sum+r.firstTour.over100,0)});
}
output.pass=true;
fs.writeFileSync(prefix+'-analysis.json',JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({groups:output.groups,runs:output.runs.map(r=>({index:r.index,precache:r.precache,
  first30FramesMs:r.first30FramesMs,used:r.used,firstTour:r.firstTour,repeatTour:r.repeatTour}))},null,2));
