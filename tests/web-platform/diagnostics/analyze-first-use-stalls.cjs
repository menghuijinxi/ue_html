'use strict';
// Associate actual first-use pipeline requests with viewport submission gaps.
// Whole-tour FPS and percentiles cannot identify this transient event.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const [tag]=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(tag));
const prefix=path.resolve(__dirname,'../results',tag),input=prefix+'.json';
const report=JSON.parse(fs.readFileSync(input));assert(report.pass&&!report.trace&&!report.captureCorpus);
const median=a=>{a=a.toSorted((a,b)=>a-b);return(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2;};
const stats=frames=>({frames:frames.length,maximumMs:frames.length?Math.max(...frames.map(f=>f.ms)):null,
  over33:frames.filter(f=>f.ms>1000/30).length,over50:frames.filter(f=>f.ms>50).length,over100:frames.filter(f=>f.ms>100).length});
const out={date:new Date().toISOString(),pass:false,input:audit(input),source:audit(__filename),
  boundary:'Reanalysis of saved, untraced full-scene runs; no new performance run. Event windows are the union of overlapping first-use async PSO request-to-callback intervals. Frames are measured viewport submission intervals, not physical presentation. A frame overlapping a request is associated with the first-use event; its entire duration is not pure DXC time. Requests themselves can hit browser caches; companion GPU traces establish actual DXC work separately. 1000/frameMs is an equivalent single-frame rate, not a one-second FPS average. Post-event 500ms tail is checked for shifted stalls. Both sides use runtime async PSOs; comparison is 3 versus 7 UE task workers, not sync versus async.',
  runs:[],groups:[]};
let labels;
for(const run of report.runs){
  assert(run.pass);assert.deepEqual(run.errors,[]);assert.deepEqual(run.final.failures,[]);
  const first=run.phases.find(p=>p.name==='first-tour'),repeat=run.phases.find(p=>p.name==='repeat-tour');assert(first&&repeat);
  const requests=first.data.events.filter(e=>e.name.endsWith('PipelineAsync')).toSorted((a,b)=>a.start-b.start);
  assert(requests.length&&requests.every(e=>Number.isFinite(e.completed)&&e.completed>=e.start&&!e.error));
  const currentLabels=requests.map(e=>e.label).sort();if(labels)assert.deepEqual(currentLabels,labels);else labels=currentLabels;
  const bursts=[];
  for(const request of requests){
    const previous=bursts.at(-1);
    if(!previous||request.start>previous.end)bursts.push({start:request.start,end:request.completed,requests:[request]});
    else{previous.end=Math.max(previous.end,request.completed);previous.requests.push(request);}
  }
  const frames=first.data.frames;
  for(let i=1;i<frames.length;i++){
    assert(frames[i].time>frames[i-1].time);
    assert(Math.abs(frames[i].time-frames[i].ms-frames[i-1].time)<0.001,'Missing interval in captured frames');
  }
  const events=bursts.map((burst,index)=>{
    const overlapping=frames.filter(f=>f.time>burst.start&&f.time-f.ms<burst.end);assert(overlapping.length);
    const last=overlapping.at(-1),worst=overlapping.reduce((a,b)=>a.ms>b.ms?a:b);
    const before=frames.filter(f=>f.time<=overlapping[0].time-overlapping[0].ms).slice(-3);
    const after=frames.filter(f=>f.time>last.time&&f.time<=last.time+500);
    assert(first.end>last.time+500,'Insufficient post-event tail');
    const relative=f=>({frame:f.frame,startMs:f.time-f.ms-burst.start,endMs:f.time-burst.start,ms:f.ms});
    return {index:index+1,startOffsetMs:burst.start-first.begin,requests:burst.requests.length,pendingSpanMs:burst.end-burst.start,
      submissionsWhilePending:frames.filter(f=>f.time>=burst.start&&f.time<burst.end).length,
      associatedFrames:overlapping.map(relative),worstFrameMs:worst.ms,equivalentSingleFrameFps:1000/worst.ms,
      firstSubmissionAfterCompletionMs:last.time-burst.end,associatedFrameStats:stats(overlapping),
      beforeFrames:before.map(relative),nextFrames:after.slice(0,5).map(relative),post500ms:stats(after),
      requestsRelative:burst.requests.map(e=>({label:e.label,startMs:e.start-burst.start,completedMs:e.completed-burst.start}))};
  });
  const affectedIds=new Set(events.flatMap(e=>e.associatedFrames.map(f=>f.frame)));
  const outsideSlowFrames=frames.filter(f=>!affectedIds.has(f.frame)&&f.ms>50).map(f=>({frame:f.frame,ms:f.ms,offsetMs:f.time-first.begin}));
  out.runs.push({index:run.index,cores:run.coreLimit,workers:run.initial.threads.taskWorkers,mode:run.mode,
    schedule:run.schedule||'fifo',newModules:first.data.events.filter(e=>e.name==='createShaderModule').length,
    pipelineRequests:requests.length,events,outsideEventFramesOver50ms:outsideSlowFrames,
    repeat:{pipelineRequests:repeat.data.events.filter(e=>e.name.includes('Pipeline')).length,
      shaderModules:repeat.data.events.filter(e=>e.name==='createShaderModule').length,
      framesOver50:repeat.data.frames.filter(f=>f.ms>50).length}});
}
for(const key of new Set(out.runs.map(r=>[r.mode,r.workers,r.schedule].join('/')))){
  const runs=out.runs.filter(r=>[r.mode,r.workers,r.schedule].join('/')===key),events=runs.flatMap(r=>r.events);
  const worstFrameMs=median(events.map(e=>e.worstFrameMs));
  out.groups.push({key,runs:runs.length,events:events.length,medianWorstFrameMs:worstFrameMs,
    equivalentSingleFrameFps:1000/worstFrameMs,medianPendingSpanMs:median(events.map(e=>e.pendingSpanMs)),
    eventsOver100ms:events.filter(e=>e.worstFrameMs>100).length,
    maximumPost500msFrame:Math.max(...events.map(e=>e.post500ms.maximumMs)),
    post500msFramesOver50:events.reduce((s,e)=>s+e.post500ms.over50,0)});
}
out.pass=true;fs.writeFileSync(prefix+'-first-use-events.json',JSON.stringify(out,null,2)+'\n');
console.log(JSON.stringify({groups:out.groups,runs:out.runs.map(r=>({run:r.index,workers:r.workers,
  events:r.events.map(e=>({requests:e.requests,frameMs:e.worstFrameMs,equivalentSingleFrameFps:e.equivalentSingleFrameFps,
    pendingSpanMs:e.pendingSpanMs,submissionsWhilePending:e.submissionsWhilePending,post500ms:e.post500ms})),outsideEventFramesOver50ms:r.outsideEventFramesOver50ms,repeat:r.repeat}))},null,2));
