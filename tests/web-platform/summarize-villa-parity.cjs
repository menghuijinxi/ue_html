'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
function metrics(a){
  assert(a.length>=100 && a.every(v=>Number.isFinite(v)&&v>0));
  const sorted=a.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(a.length*.01));
  const mean=a.reduce((a,b)=>a+b,0)/a.length;
  return {samples:a.length,meanMs:mean,fps:1000/mean,low1:1000*tail.length/tail.reduce((a,b)=>a+b,0),
    p99:sorted[Math.floor(a.length*.99)],max:sorted.at(-1),over33:a.filter(v=>v>33.333).length,over50:a.filter(v=>v>50).length};
}
function native(tag){
  const prefix=path.join(root,tag),launch=read(prefix+'-launch.json'),complete=read(prefix+'-complete.json');
  const lines=fs.readFileSync(prefix+'.csv','utf8').trim().split(/\r?\n/),header=lines[0].split(',');
  const phases=launch.phases.map(p=>{
    const rows=lines.slice(p.start+1,p.end+1).map(l=>l.split(','));assert.equal(rows.length,p.end-p.start);
    return {name:p.name,frames:[p.start,p.end],metrics:Object.fromEntries(['FrameTime','GameThreadTime','RenderThreadTime','RHIThreadTime','GPUTime'].map(k=>{
      const i=header.indexOf(k);assert(i>=0);return [k,metrics(rows.map(r=>Number(r[i])))];
    }))};
  });
  return {tag,launch,complete,phases,raw:['.csv','-launch.json','-complete.json','.log','.png'].map(s=>audit(prefix+s)),
    cleanExit:complete.exitCode===0,boundary:'UE CSV frame intervals; not display intervals. Exit code retained independently of completed measurements.'};
}
function web(tag){
  const file=path.join(root,tag+'.json'),r=read(file);assert(r.pass && r.runs.every(v=>v.result));
  const logFile=['.log','-1-owner.log'].map(s=>path.join(root,tag+s)).find(f=>fs.existsSync(f));
  const log=logFile?fs.readFileSync(logFile,'utf8'):null;
  const failedCreates=log===null?null:(log.match(/Failed to create (?:compute|graphics) pipeline/g)||[]).length;
  const last=r.runs.at(-1).after.optimization;
  if(failedCreates!==null && last)assert.equal(failedCreates,last.unsupportedPrecacheRequests);
  return {tag,raw:audit(file),log:logFile?audit(logFile):null,folder:r.folder,pass:r.pass,physicalPresentationValidated:false,
    pipelineDiagnostics:r.pipelineDiagnostics||{failedCreates,unsupportedPrecacheRequests:last?.unsupportedPrecacheRequests,
      asyncPrecacheFailed:last?.asyncPrecacheFailed,log:logFile},
    runs:r.runs.map(v=>{
      const frames=v.capture?.frames||[],done=frames.filter(f=>Number.isFinite(f.done)&&Number.isFinite(f.submit));
      return {name:v.name||v.mode,result:{...v.result,low1:v.result.low1??v.result.low1Fps},rhiMs:v.rhiMs,workload:v.workload,view:v.before.view,camera:v.before.camera,
        settings:v.before.settings,clock:v.before.clock,errors:v.capture?.errors||v.errors||[],
        computePassMerge:v.after.computePassMerge||null,
        gpuBudget:v.after.gpuBudget||null,
        gpu:v.gpuSummary || (done.length?{peak:v.capture.pendingPeak,meanLatency:done.reduce((s,f)=>s+f.done-f.submit,0)/done.length,maxLatency:Math.max(...done.map(f=>f.done-f.submit))}:null)};
    })};
}
const nativeSM6=native('parity-native-effects-20261106'),nativeSM5=native('parity-native-sm5-visible-20261106'),
  nativeNormal=native('parity-native-sm5-no-etw-20261106');
const tags=['parity-web-effects-safe-20261106','parity-web-csm-20261106','parity-web-csm-bundles-20261106',
  'parity-web-owner-lookahead-20261106','parity-web-csm-staging-20261106','parity-web-csm-memory-20261106',
  'parity-web-no-shadows-20261106','parity-web-csm-compute-20261106','parity-web-csm-no-etw-20261106',
  'parity-web-csm-normal-20261106','parity-web-baseline-normal-20261106',
  'parity-web-csm-budget2-retry-20261106',
  'parity-owner-baseline-20261106','parity-owner-csm-motion-20261106','parity-owner-csm-memory-motion-20261106'];
const browser=tags.map(web),desktop=nativeNormal.phases[0].metrics.FrameTime;
const candidate=browser.find(v=>v.tag==='parity-web-csm-normal-20261106').runs[0].result;
const profileFile=path.join(root,'performance-capture-parity-csm-profile-20261106.json'),profile=read(profileFile);assert(profile.pass);
const report={date:new Date().toISOString(),performanceAccepted:false,userTestReady:false,
  lowDefinition:'1000 / arithmetic mean of slowest ceil(N*0.01) positive frame intervals; no slow frames removed',
  acceptance:{provisionalRelativeTolerance:.1,averageGap:Math.abs(candidate.fps-desktop.fps)/desktop.fps,
    low1Gap:Math.abs(candidate.low1-desktop.low1)/desktop.low1,physicalPresentationValidated:false,
    reason:'Frame rate and 1% low parity not achieved; ETW presentation capture incomplete. No candidate is a final release.'},
  nativeSM6,nativeSM5,nativeNormal,browser,
  profiler:{raw:audit(profileFile),baseline:profile.baseline,instrumented:profile.instrumentedMeasurement,
    sampled:profile.profileMeasurement,gpuPassSums:profile.gpuFrames.map(f=>f.totalPassMs),
    boundary:'GPU pass sums exclude copies and gaps; profiler timings are excluded from normal performance comparison.'},
  rejected:{ownerLookahead:'GPU queue peak and completion latency increased without improving 1% low.',
    bundles:'Average FPS regressed.',staging:'No substantial gain in average FPS or 1% low.',
    computeMergePrototype:'Real dispatch readbacks passed, but the JS prototype did not improve FPS or 1% low.',
    noShadows:'Diagnostic quality reduction, never an accepted optimization.',
    gpuBudgetTwo:'Bounded GPU-completion feedback reduced submission throughput to 84 FPS; low1 remained far below native. Not adopted.',
    localClock:'Previously rejected by user. Never enabled in this comparison.'},
  limitations:['Native movement route is not captured; browser DOM motion trajectories differ with timing.',
    'Native SM5 and Web SM5 have different RHI implementations; screenshots inspected, not exhaustive pixel parity.',
    'Native process exits with historical post-shutdown 777003; not a clean process lifetime pass.',
    'PresentMon output missing or incomplete; a control run reported lost ETW events. No physical-display FPS claim.',
    'Single-device diagnostic runs are not an ABBA release acceptance.']};
report.failedExperiments=[{raw:audit(path.join(root,'parity-web-effects-20261106.json')),
  reason:'Changing ShadowQuality while deferred rendering tasks are queued asserted. Subsequent shadow attribution uses startup-only changes.'},
  {raw:audit(path.join(root,'parity-web-csm-budget2-20261106.json')),
  reason:'Harness expected owner mode for the explicit page-raf/GPU-credit diagnostic; assertion corrected and rerun with a fresh tag.'}];
report.build={raw:audit(path.join(root,'web-engine-full-thread-build-results.json')),
  memorySource:audit(path.resolve(__dirname,'../../reference-engine/Engine/Source/Runtime/Core/Private/GenericPlatform/GenericPlatformMemory.cpp')),
  note:'Web virtual-memory accounting removes per-frame unimplemented warnings; no measurable FPS gain attributed to this fix.'};
const file=path.join(__dirname,'evidence','villa-parity-20261106.json');
fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file,acceptance:report.acceptance,desktop,candidate}));
