'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2]; assert(/^[a-z0-9-]+$/.test(tag));
const minimumWindowFrames = Number(process.argv.find(a=>a.startsWith('--minimum-window-frames='))?.split('=')[1] || 100);
assert(Number.isInteger(minimumWindowFrames) && minimumWindowFrames >= 10);
const directory = path.join(__dirname, 'results', tag), input = path.join(directory, 'report.json');
const report = JSON.parse(fs.readFileSync(input)); assert(report.walk && report.pass);
function distribution(intervals) {
  const sorted = intervals.toSorted((a,b) => a-b), tail = sorted.slice(-Math.ceil(sorted.length / 100));
  return {frames:intervals.length, fps:intervals.length*1000/intervals.reduce((a,b)=>a+b,0),
    low1:tail.length*1000/tail.reduce((a,b)=>a+b,0), maxMs:sorted.at(-1),
    over33Ms:intervals.filter(x=>x>1000/30).length, over50Ms:intervals.filter(x=>x>50).length,
    over100Ms:intervals.filter(x=>x>100).length};
}
const runs = report.runs.map(run => {
  assert(run.pass && run.errors.length === 0);
  const p = run.phases[0]; assert(['walk-and-turn-first','interior-tour-first'].includes(p.name));
  const frames = p.frames.slice(1).map((row,i) => ({frame:row[0], time:row[1], ms:row[1]-p.frames[i][1],
    gameFrame:row[2], lastGameMs:row[4], rhiDeltaMs:row[3]-p.frames[i][3]}));
  let lowest = {low1:Infinity};
  const windows = [];
  for (let end=p.times[0]+5000; end<=p.times.at(-1); end+=250) {
    const values=frames.filter(f=>f.time>end-5000&&f.time<=end).map(f=>f.ms);
    if(values.length<minimumWindowFrames)continue;
    const s={endSeconds:(end-p.times[0])/1000,...distribution(values)};
    windows.push(s); if(s.low1<lowest.low1)lowest=s;
  }
  const counterDelta = (a,b,name) => Object.fromEntries(Object.entries(b[name]||{})
    .filter(([k,v])=>typeof v==='number'&&typeof a[name]?.[k]==='number').map(([k,v])=>[k,v-a[name][k]]));
  const worst=frames.toSorted((a,b)=>b.ms-a.ms).slice(0,20).map(f=>{
    const before=p.samples.findLast(s=>s.time<=f.time-f.ms)||p.samples[0];
    const after=p.samples.find(s=>s.time>=f.time)||p.samples.at(-1);
    return {...f,offsetSeconds:(f.time-p.times[0])/1000,cameraBefore:before.camera,cameraAfter:after.camera,
      diagnosticWindowMs:after.time-before.time,history:counterDelta(before,after,'history'),
      rhi:counterDelta(before,after,'rhi'),optimization:counterDelta(before,after,'optimization'),
      io:counterDelta(before,after,'io'),streamingBefore:before.streaming,streamingAfter:after.streaming};
  });
  return {index:run.index,mode:run.mode,nanite:run.nanite,hierarchy:run.hierarchy,occlusion:run.occlusion,pack:run.pack,micro:run.micro,materialPrecache:run.materialPrecache,browser:run.browser,initialCamera:run.initial.camera,finalCamera:p.after.camera,
    view:p.before.view,travelCm:p.travelCm,radiusCm:p.radiusCm,turnDegrees:p.turnDegrees,pitchRange:p.pitchRange,
    driver:report.tour?'native-camera-tour':'keyboard-and-mouse',inputEvents:run.motion.events||0,
    keyEvents:run.motion.keyEvents?.length||0,overall:distribution(frames.map(f=>f.ms)),
    lowest5s:lowest,windows,worst};
});
const analysis={date:new Date().toISOString(),source:audit(__filename),input:audit(input),minimumWindowFrames,runs,
  boundary:(report.tour?'First native game-frame camera tour with simultaneous translation and rotation. ':'First simultaneous keyboard/mouse movement. ')
    +'No route warmup. Five-second windows sampled every 250 ms with the HUD low definition. '
    +'Actual paths can diverge despite identical requested inputs. RHI/game fields are asynchronous publications; nearest 200 ms telemetry brackets a stall and does not prove exclusive causation.'};
fs.writeFileSync(path.join(directory,'analysis.json'),JSON.stringify(analysis,null,2)+'\n');
fs.copyFileSync(__filename,path.join(directory,'analysis-source.cjs'));
console.log(JSON.stringify(runs.map(r=>({mode:r.mode,overall:r.overall,lowest5s:r.lowest5s,
  travelCm:r.travelCm,radiusCm:r.radiusCm,turnDegrees:r.turnDegrees,pitchRange:r.pitchRange,
  worst:r.worst.slice(0,3).map(f=>({offset:f.offsetSeconds,ms:f.ms,rhiDeltaMs:f.rhiDeltaMs,lastGameMs:f.lastGameMs,
    pipelines:f.optimization.runtimeAsyncRequested,camera:f.cameraAfter}))})),null,2));
