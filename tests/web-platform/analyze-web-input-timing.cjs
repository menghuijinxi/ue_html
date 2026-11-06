'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const file=process.argv[2],report=JSON.parse(fs.readFileSync(file));
assert(report.pass);
const stats=values=>{
  if(!values.length)return null;
  const sorted=values.toSorted((a,b)=>a-b),mean=values.reduce((a,b)=>a+b,0)/values.length;
  return {n:values.length,min:sorted[0],p50:sorted[Math.floor(sorted.length*.5)],
    p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1),mean,
    rms:Math.sqrt(values.reduce((s,v)=>s+v*v,0)/values.length)};
};
const delta=(a,b)=>((a-b+540)%360)-180;
const runs=report.runs.map(run=>{
  const frames=run.inputFrames,events=run.motion.raw;
  assert(frames.length>20&&events.length>20);
  // Project sensitivity .07, FOV scaling .01111 * 90; controller legacy yaw scale 2.5.
  // Verify the actual no-smoothing trace rather than fitting a gain to each run.
  const axisGain=.07*.01111*90,yawGain=axisGain*2.5;
  const active=frames.filter(f=>Math.abs(f[4])>=5);
  const gainErrors=active.map(f=>100*(f[6]/f[4]/axisGain-1));
  let raw=0,axis=0,yaw=0,rawPath=0,yawPath=0,axisYawPath=0;
  const drift=[],cameraErrors=[],consumption=[];
  const epochValid=Math.abs(frames[0][1]-events[0][0])<5000;
  assert(epochValid,'Game and DOM timestamps must share an epoch; do not analyze the first diagnostic build for latency');
  let eventIndex=0,dom=0;
  for(let i=0;i<frames.length;i++){
    const f=frames[i];raw+=f[4];axis+=f[6];rawPath+=Math.abs(f[4]);axisYawPath+=Math.abs(f[6])*2.5;
    if(i){const turn=delta(f[8],frames[i-1][8]);yaw+=turn;yawPath+=Math.abs(turn);
      cameraErrors.push(turn-f[6]*2.5);}
    drift.push(axis/axisGain-raw);
    if(epochValid){
      while(eventIndex<events.length&&events[eventIndex][0]<=f[1])dom+=events[eventIndex++][1];
      consumption.push({time:f[1],raw,axis:axis/axisGain,dom,behindPixels:dom-raw});
    }
  }
  assert(stats(cameraErrors).rms<.0001,'Camera did not apply the captured axis in this frame');
  assert(Math.abs(raw-events.reduce((s,e)=>s+e[1],0))<.001,'DOM delta was lost or duplicated');
  assert(Math.abs(rawPath-events.reduce((s,e)=>s+Math.abs(e[1]),0))<.001,
    'Opposite movements must not hide lost displacement in this trajectory');
  if(run.smoothing===1){
    assert(stats(gainErrors.map(Math.abs)).max<.001,'Raw mode changed sensitivity');
    assert(frames.every(f=>f[4]!==0||Math.abs(f[6])<.000001),'Raw mode extrapolated movement');
  }
  const arrivals=run.pipeline?.game.frames.flatMap(frame=>frame.inputs.filter(input=>Number.isFinite(input.first))
    .map(input=>({bridge:input.arrived-input.first,game:frame.begin-input.first})))||[];
  return {index:run.index,smoothing:run.smoothing===2,epochValid,frames:frames.length,events:events.length,
    frameResult:run.result,axisGain,yawGain,gainErrorPercent:stats(gainErrors),
    absoluteGainErrorPercent:stats(gainErrors.map(Math.abs)),driftPixels:stats(drift),
    rawTotal:raw,rawPath,yawTotal:yaw,yawPath,expectedYawPath:(rawPath-Math.abs(frames[0][4]))*yawGain,
    axisYawPath,expectedAxisYawPath:rawPath*yawGain,
    cameraAxisErrorDegrees:stats(cameraErrors),extrapolatedFrames:frames.filter(f=>f[4]===0&&Math.abs(f[6])>1e-6).length,
    tickMilliseconds:stats(frames.map(f=>f[2]-f[1])),
    inputBehindAtTickPixels:stats(consumption.map(c=>c.behindPixels)),
    inputToGameBeginMs:stats(arrivals.map(v=>v.game)),
    inputBridgeMs:stats(arrivals.map(v=>v.bridge)),
    ownerQueueMs:stats(run.pipeline?.tasks.map(t=>t.begin-t.queued)||[]),
    gpuCompletionFeedbackMs:stats(run.pipeline?.gpu.filter(f=>Number.isFinite(f.done)).map(f=>f.done-f.submitted)||[]),
    boundary:'Game-thread axis/camera values; submission timing is not physical presentation or end-to-end input latency.'};
});
const output={source:file,pass:true,runs};
fs.writeFileSync(file.replace(/\.json$/,'-input-analysis.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
