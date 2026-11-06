'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const results=path.join(__dirname,'results');
const read=name=>JSON.parse(fs.readFileSync(path.join(results,name),'utf8').replace(/^\uFEFF/,''));
function stats(values){
  assert(values.length>=100&&values.every(v=>Number.isFinite(v)&&v>0));
  const sorted=values.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(values.length*.01));
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  return {frames:values.length,fps:1000/mean,low1:1000*tail.length/tail.reduce((a,b)=>a+b,0),
    meanMs:mean,p99:sorted[Math.floor(sorted.length*.99)],max:sorted.at(-1),
    over33:values.filter(v=>v>33.333).length,over50:values.filter(v=>v>50).length};
}
function capture(tag){
  const raw=read(tag+'.json');assert(raw.pass);assert.deepEqual(raw.errors,[]);
  return {raw,summary:{tag,raw:audit(path.join(results,tag+'.json')),log:audit(path.join(results,tag+'.log')),
    image:audit(path.join(results,tag+'.png')),folder:raw.folder,readback:raw.readbackTest??null,
    gpuCompletionProbe:raw.gpuCompletionProbe,runs:raw.runs.map(v=>{
      assert.equal(v.before.clock.mode,'owner');assert.deepEqual(v.before.settings,v.after.settings);
      const n=v.after.occlusion.sampleFrame-v.before.occlusion.sampleFrame;
      const done=v.capture.frames.filter(f=>Number.isFinite(f.done)&&Number.isFinite(f.submit));
      return {result:v.result,rhiMs:v.rhiMs,workload:v.workload,view:v.before.view,camera:v.before.camera,
        reuseComputePass:v.after.occlusion.reuseComputePass,
        openedPerFrame:(v.after.occlusion.computePassesOpened-v.before.occlusion.computePassesOpened)/n,
        reusedPerFrame:(v.after.occlusion.computePassesReused-v.before.occlusion.computePassesReused)/n,
        gpu:done.length?{peak:v.capture.pendingPeak,meanMs:done.reduce((s,f)=>s+f.done-f.submit,0)/done.length,
          maxMs:Math.max(...done.map(f=>f.done-f.submit))}:null};
    })}};
}
const normalTags=['parity-compute-reuse-on-1-20261106','parity-compute-reuse-off-12-20261106','parity-compute-reuse-on-2-20261106'];
const captures=normalTags.map(capture);
function aggregate(enabled){
  const runs=captures.flatMap(c=>c.raw.runs).filter(v=>v.after.occlusion.reuseComputePass===enabled);
  const intervals=runs.flatMap(v=>v.capture.frames.slice(1).map((f,i)=>f.at-v.capture.frames[i].at));
  const count=runs.reduce((s,v)=>s+v.after.frame-v.before.frame,0);
  return {...stats(intervals),rhiMs:runs.reduce((s,v)=>s+v.after.stages.rhiWorkMilliseconds-v.before.stages.rhiWorkMilliseconds,0)/count};
}
const off=aggregate(false),on=aggregate(true);
function native(tag){
  const launch=read(tag+'-launch.json'),complete=read(tag+'-complete.json');
  const lines=fs.readFileSync(path.join(results,tag+'.csv'),'utf8').trim().split(/\r?\n/),h=lines[0].split(',');
  const p=launch.phases[0],rows=lines.slice(p.start+1,p.end+1).map(l=>l.split(','));
  const column=k=>{const i=h.indexOf(k);assert(i>=0);return rows.map(r=>Number(r[i]));};
  const mean=k=>column(k).reduce((a,b)=>a+b,0)/rows.length;
  return {tag,raw:['.csv','.log','.png','-launch.json','-complete.json'].map(s=>audit(path.join(results,tag+s))),
    arguments:launch.arguments,exitCode:complete.exitCode,cleanExit:complete.cleanExit,stats:stats(column('FrameTime')),
    workload:Object.fromEntries(['RHI/DrawCalls','DrawCall/ShadowDepths','DrawCall/Basepass','DrawCall/Prepass',
      'ShadowCacheUsageMB','RHIThreadTime','GPUTime'].map(k=>[k,mean(k)]))};
}
const nativeCSM=native('parity-native-csm-sm5-20261106');
assert(nativeCSM.arguments.some(v=>v.includes('r.Shadow.CSMCaching 1')));
const gpu=['on','off'].map(k=>capture('parity-compute-reuse-'+k+'-gpu-20261106').summary);
for(const c of gpu)assert(c.readback.pass);
const motion=['on','off'].map(k=>{
  const tag='parity-compute-reuse-'+k+'-motion-20261106',r=read(tag+'.json');assert(r.pass);
  assert.deepEqual(r.modes,['owner']);assert.equal(r.inputMode,'owner-forwarded');
  return {tag,raw:audit(path.join(results,tag+'.json')),runs:r.runs.map(v=>({result:v.result,gpu:v.gpuSummary,
    travel:v.travel,turn:v.turn,workload:v.workload,errors:v.errors}))};
});
const diagnostics=read('parity-owner-stalls-20261106-analysis.json');assert(diagnostics.pass);
const immediates=read('parity-webgpu-immediates-20261106.json');assert(immediates.pass&&immediates.supported);
const build=read('parity-compute-reuse-build-20261106.json');assert(build.pass&&build.buildSucceeded);
for(const p of build.products)assert.equal(audit(p.file).sha256,p.sha256);
const previous=JSON.parse(fs.readFileSync(path.join(__dirname,'evidence/villa-parity-20261106.json')));
const archivedBuild=audit(path.join(results,'parity-before-compute-reuse-build-20261106.json'));
assert.equal(archivedBuild.sha256,previous.build.raw.sha256);
const report={date:new Date().toISOString(),pass:true,performanceAccepted:false,physicalPresentationValidated:false,
  lowDefinition:'1000 / arithmetic mean of slowest ceil(N*0.01) frame intervals; no long frames removed. Aggregate concatenates measured intervals, never cross-run gaps.',
  controls:{resolution:[1280,720],clock:'owner',rhiWake:'priority',fpsCap:0,vsync:0,csmCaching:1,
    order:'on, off, off, on; two off windows share one warmed process; each window 45 seconds',
    quality:'same runtime/Cook/config except r.WebGPU.ReuseComputePass; all dispatches retained'},
  off,on,relativeChange:{fps:on.fps/off.fps-1,low1:on.low1/off.low1-1,rhiMs:on.rhiMs/off.rhiMs-1},
  nativeCSM,nativePrevious:native('parity-native-sm5-no-etw-20261106'),
  parity:{averageGap:1-on.fps/nativeCSM.stats.fps,low1Gap:1-on.low1/nativeCSM.stats.low1},
  normal:captures.map(c=>c.summary),gpu,motion,
  imageComparison:{raw:audit(path.join(results,'parity-compute-reuse-image-comparison-20261106.json')),
    ...read('parity-compute-reuse-image-comparison-20261106.json')},
  ownerDiagnostics:{raw:audit(path.join(results,'parity-owner-stalls-20261106-analysis.json')),
    capture:audit(path.join(results,'parity-owner-stalls-20261106.json')),trace:diagnostics.trace,
    normal:read('parity-owner-stalls-20261106.json').phases[0].summary,
    traceSummary:diagnostics.summary,boundary:'Tracing perturbs stalls, especially its initial sweep burst; correlation is not complete causal attribution.'},
  immediates:{raw:audit(path.join(results,'parity-webgpu-immediates-20261106.json')),...immediates,
    boundary:'Actual API and GPU readback supported. Not integrated with UE shaders, no performance benefit claimed.'},
  build:audit(path.join(results,'parity-compute-reuse-build-20261106.json')),previousBuildArchived:archivedBuild,
  limitations:['Physical display frame intervals are not verified. RHI submissions and GPU completion are separate measurements.',
    'Static worst frame did not improve in the normal aggregate; long frames remain.',
    'Motion trajectories vary with event timing and game speed; they are regression stress tests, not an identical-path benchmark.',
    'Native historical exit code 777003 follows completed CSV and log closure; not a clean lifecycle pass.',
    'CSM caching must be evaluated visually during movement. Static image similarity is not exhaustive visual correctness.',
    'Browser/desktop performance parity is not achieved. The experiment remains off by default.']};
const output=path.join(__dirname,'evidence/villa-compute-reuse-20261106.json');
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,off,on,relativeChange:report.relativeChange,parity:report.parity}));
