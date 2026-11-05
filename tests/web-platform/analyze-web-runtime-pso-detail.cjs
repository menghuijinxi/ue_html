'use strict';
// Stream large Chrome JSON traces: GPU service traces can exceed V8's string limit.
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const tag=process.argv[2];assert(tag&&/^[a-z0-9-]+$/.test(tag));
const prefix=path.join(__dirname,'results',tag),input=prefix+'.json';
const report=JSON.parse(fs.readFileSync(input,'utf8'));
const names=['DawnPlatformImpl::RunWorkerTask','CreatePipelineAsyncEvent::InitializeImpl','ShaderModuleD3D12::Compile',
  'CompileShaderDXC','CompileShaderFXC','tint::hlsl::writer::Generate','DeviceBase::APICreateShaderModule','DawnCachingInterface::CacheHit'];
async function readTrace(file){
  const scopes=[],marks=[],threads=[],memoryCaches=[];let count=0;
  for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})){
    const value=line.trim().replace(/,$/,'');if(!value.startsWith('{"'))continue;
    let e;try{e=JSON.parse(value);}catch{continue;}count++;
    if(e.name==='thread_name'||e.name==='process_name')threads.push(e);
    if(e.name?.startsWith('RuntimePSO.'))marks.push(e);
    if(names.includes(e.name)&&e.ph==='X')scopes.push(e);
    if(e.ph==='v')for(const [name,value]of Object.entries(e.args.dumps?.allocators||{}))
      if(name.includes('webgpu_cache'))memoryCaches.push({pid:e.pid,name,
        bytes:parseInt(value.attrs.size.value,16),entries:parseInt(value.attrs.object_count.value,16)});
  }
  assert(count>0&&scopes.length>0,'Expected newline-delimited Chrome trace events');return{count,scopes,marks,threads,memoryCaches};
}
function stats(events){
  const sorted=events.toSorted((a,b)=>a.ts-b.ts),points=[];let total=0,cpu=0,union=0,start,end,peak=0,live=0;
  for(const e of sorted){total+=e.dur;cpu+=e.tdur||0;points.push([e.ts,1],[e.ts+e.dur,-1]);
    if(start===undefined){start=e.ts;end=e.ts+e.dur;}
    else if(e.ts>end){union+=end-start;start=e.ts;end=e.ts+e.dur;}else end=Math.max(end,e.ts+e.dur);}
  if(start!==undefined)union+=end-start;
  for(const [,delta]of points.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){live+=delta;peak=Math.max(peak,live);}
  return{count:events.length,summedElapsedMs:total/1000,summedThreadCpuMs:cpu/1000,activeUnionMs:union/1000,
    spanMs:sorted.length?(Math.max(...sorted.map(e=>e.ts+e.dur))-sorted[0].ts)/1000:0,
    maximumMs:sorted.length?Math.max(...sorted.map(e=>e.dur))/1000:0,peakConcurrent:peak};
}
(async()=>{
  const out={date:new Date().toISOString(),pass:false,input:audit(input),sources:[audit(__filename)],runs:[],
    boundary:'Diagnostic traces only. Summed nested scopes overlap and must not be added. Summed elapsed time across worker threads differs from wall time and from measured thread CPU time. Unscoped pipeline initialization remainder is not a pure driver measurement. Generic cache-hit events do not identify individual shader/PSO cache hits.'};
  for(const [index,run]of report.runs.entries()){
    assert(run.traceFile||run.trace,'Missing trace');const file=run.traceFile||run.trace;
    const trace=await readTrace(file);const result={index,trace:audit(file),eventCount:trace.count,marks:trace.marks,memoryCaches:trace.memoryCaches,stages:{}};
    for(const name of names)result.stages[name]=stats(trace.scopes.filter(e=>e.name===name));
    if(run.phases){
      result.phases=[];
      for(const phase of run.phases.filter(p=>p.name!=='standing')){
        const begin=trace.marks.find(m=>m.name==='RuntimePSO.'+phase.name+'.begin'),end=trace.marks.find(m=>m.name==='RuntimePSO.'+phase.name+'.end');
        assert(begin&&end);const events=trace.scopes.filter(e=>e.ts>=begin.ts&&e.ts+e.dur<=end.ts);
        result.phases.push({name:phase.name,submissionSummary:phase.summary,
          stages:Object.fromEntries(names.map(name=>[name,stats(events.filter(e=>e.name===name))]))});
      }
      const clock=trace.marks.find(m=>m.name==='RuntimePSO.clock');assert(clock);
      const offset=clock.ts-clock.args.data.startTime*1000;
      const first=run.phases.find(p=>p.name==='first-tour'),worst=first.data.frames.toSorted((a,b)=>b.ms-a.ms)[0];
      const a=offset+(worst.time-worst.ms)*1000,b=offset+worst.time*1000;
      result.worstFrame={submissionMs:worst.ms,scopes:Object.fromEntries(names.map(name=>[name,
        stats(trace.scopes.filter(e=>e.name===name&&e.ts>=a&&e.ts+e.dur<=b))]))};
    }
    if(run.attempts)result.replay={pipelineWallMs:run.pipelineWallMs,preparationAndPipelinesMs:run.preparationAndPipelinesMs,
      moduleApiMs:run.moduleApiMs,moduleReadyMs:run.moduleReadyMs,layoutApiMs:run.layoutApiMs,successful:run.successful,failed:run.failed};
    out.runs.push(result);
  }
  assert(report.pass);out.pass=true;fs.writeFileSync(prefix+'-analysis.json',JSON.stringify(out,null,2)+'\n');
  console.log(JSON.stringify({pass:true,runs:out.runs.map(r=>({index:r.index,stages:r.stages,replay:r.replay,worstFrame:r.worstFrame}))},null,2));
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
