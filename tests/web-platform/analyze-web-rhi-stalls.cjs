'use strict';
const fs=require('node:fs'),readline=require('node:readline'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const input=process.argv[2];assert(input,'Usage: node analyze-web-rhi-stalls.cjs capture.json [--owner-thread=N --offset-ms=N]');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const capture=JSON.parse(fs.readFileSync(input,'utf8'));
const phase=capture.phases.find(p=>p.name==='standing-trace');assert(capture.pass&&phase);
const trace=input.replace(/\.json$/,'-trace.json'),marks=[],sweeps=[],gc=[],calls=[];
function distribution(values){const a=values.toSorted((x,y)=>x-y);return{count:a.length,
  total:values.reduce((s,v)=>s+v,0),p50:a[Math.floor(a.length*.5)],max:a.at(-1)};}
(async()=>{
  let events=0;
  for await(let line of readline.createInterface({input:fs.createReadStream(trace),crlfDelay:Infinity})){
    line=line.trim().replace(/,$/,'');if(!line.startsWith('{"'))continue;
    let e;try{e=JSON.parse(line);}catch{continue;}++events;
    if(e.name==='UE RHI capture start')marks.push(e);
    if(e.ph!=='X')continue;
    if(e.name==='ThreadControllerImpl::RunTask'&&/cppgc.*sweeper/.test(e.args?.src_file||''))sweeps.push(e);
    if(['MajorGC','MinorGC'].includes(e.name))gc.push(e);
    if(e.name==='FunctionCall'&&e.args?.data?.functionName==='channel.port1.onmessage')calls.push(e);
  }
  const mark=marks.at(-1),ownerThread=option('owner-thread')?Number(option('owner-thread')):mark?.tid;
  const offset=option('offset-ms')?Number(option('offset-ms')):mark?.ts/1000-phase.data.start;
  assert(Number.isInteger(ownerThread)&&Number.isFinite(offset),'Need a capture-start mark or explicit trace clock calibration');
  const calibrationSamples=[];
  if(!mark){
    const ownerCalls=calls.filter(e=>e.tid===ownerThread);assert(ownerCalls.length);
    for(const im of phase.data.immediates.slice(0,6)){
      const nearest=ownerCalls.reduce((best,e)=>Math.abs(e.ts/1000-offset-im[1])<Math.abs(best.ts/1000-offset-im[1])?e:best);
      const errorMs=nearest.ts/1000-offset-im[1],durationErrorMs=nearest.dur/1000-(im[2]-im[1]);
      assert(Math.abs(errorMs)<.05&&Math.abs(durationErrorMs)<.1,'Explicit trace clock calibration does not match RHI callbacks');
      calibrationSamples.push({capturedStart:im[1],capturedDuration:im[2]-im[1],traceStart:nearest.ts,
        traceDuration:nearest.dur,errorMs,durationErrorMs});
    }
  }
  const start=phase.data.start,end=phase.data.end;
  const owner=e=>e.tid===ownerThread&&e.ts/1000-offset>=start&&e.ts/1000-offset<end;
  const tasks=sweeps.filter(owner),collections=gc.filter(owner),bursts=[];
  for(const e of tasks){if(!bursts.length||e.ts-bursts.at(-1).at(-1).ts>100000)bursts.push([e]);else bursts.at(-1).push(e);}
  const frames=phase.data.frames.slice(1).map((f,i)=>({...f,ms:f.time-phase.data.frames[i].time,start:phase.data.frames[i].time}));
  const overlap=(e,f)=>Math.max(0,Math.min(f.time+offset,(e.ts+e.dur)/1000)-Math.max(f.start+offset,e.ts/1000));
  const longFrames=frames.filter(f=>f.ms>18).map(f=>({frame:f.frame,time:f.time,intervalMs:f.ms,
    sweepMs:tasks.reduce((s,e)=>s+overlap(e,f),0),gcMs:collections.reduce((s,e)=>s+overlap(e,f),0)}));
  const output={pass:true,capture:audit(input),trace:audit(trace),events,ownerThread,
    calibration:{offsetMs:offset,method:mark?'performance.mark at capture start':'Explicit calibration verified against consecutive RHI callback start times and durations',mark,samples:calibrationSamples},
    window:{start,end},summary:phase.summary,
    sweepTasks:distribution(tasks.map(e=>e.dur/1000)),
    bursts:bursts.map(g=>({timeMs:g[0].ts/1000-offset,tasks:g.length,totalMs:g.reduce((s,e)=>s+e.dur/1000,0),maxMs:Math.max(...g.map(e=>e.dur/1000))})),
    longFrames,over18:longFrames.length,over18WithSweepOver4ms:longFrames.filter(f=>f.sweepMs>4).length,
    majorGc:collections.filter(e=>e.name==='MajorGC').map(e=>({timeMs:e.ts/1000-offset,durationMs:e.dur/1000})),
    minorGc:distribution(collections.filter(e=>e.name==='MinorGC').map(e=>e.dur/1000)),
    sampleSweep:tasks[0],
    clockCalibrationSamples:calls.filter(e=>e.tid===ownerThread).slice(0,6).map(e=>({ts:e.ts,duration:e.dur})),
    boundary:'Both sweeper tasks and RHI callbacks execute on the GPU owner Worker. Queue samples measure setImmediate delivery only; the preceding native proxy hop is not measured. Trace overhead is excluded from normal FPS comparisons. Sweep timing establishes the observed stalls; it does not identify which object classes account for collection cost.'};
  const destination=input.replace(/\.json$/,'-analysis.json');fs.writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({destination,sweepTasks:output.sweepTasks,bursts:output.bursts,over18:output.over18,
    over18WithSweepOver4ms:output.over18WithSweepOver4ms}));
})().catch(e=>{console.error(e);process.exitCode=1;});
