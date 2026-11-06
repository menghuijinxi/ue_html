'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const results=path.join(__dirname,'results'),date='20261106';
const read=tag=>JSON.parse(fs.readFileSync(path.join(results,tag+'.json'),'utf8').replace(/^\uFEFF/,''));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function metrics(intervals){
  assert(intervals.length>100&&intervals.every(v=>Number.isFinite(v)&&v>0));
  const s=intervals.toSorted((a,b)=>a-b);
  return {frames:s.length,fps:1000/mean(s),low1:1000/mean(s.slice(-Math.ceil(s.length*.01))),
    p95:s[Math.floor(s.length*.95)],p99:s[Math.floor(s.length*.99)],max:s.at(-1),
    over33:s.filter(v=>v>33.333).length,over50:s.filter(v=>v>50).length};
}
const packages={},normal={},captures={};let reference;
for(const [kind,tags] of [['control',['a1','a2']],['candidate',['b1','b2']]]){
  const folder='villa-mouse-query-'+kind+'-v2-'+date,base=path.join(__dirname,'build',folder);
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [name,entry]of Object.entries(manifest))assert.equal(audit(path.join(base,name)).sha256,entry.sha256);
  packages[kind]={folder,manifest};
  const windows=[];let all=[];
  for(const suffix of tags){
    const tag='mouse-query-'+suffix+'-v2-'+date,r=read(tag),run=r.runs[0];
    assert(r.pass&&r.mouseOnly&&r.resetInput&&r.packagedInput&&!r.gpuProbe&&!r.profileWorkers&&!r.pipeline);
    assert.equal(r.folder,folder);assert.deepEqual(r.modes,['page3']);assert.deepEqual(run.errors,[]);
    reference ||= run.before;assert.deepEqual(run.before.settings,reference.settings);
    assert.deepEqual(run.before.camera,reference.camera);
    for(const k of ['width','height','outputWidth','outputHeight'])assert.equal(run.before.view[k],reference.view[k]);
    assert.equal(run.after.history.motionQueryInterval,kind==='candidate'?4:0);
    assert(run.after.ownerBudget[3]<=3&&run.after.ownerBudget[5]<=3&&run.after.ownerBudget[7]<=2);
    const intervals=run.measurement.slice(1).map((v,i)=>v-run.measurement[i]);all.push(...intervals);
    const frames=run.after.history.frame-run.before.history.frame;
    const history=Object.fromEntries(['polls','ready','hits','zero','fallback','cameraRejected','queryCaptured','motionQueriesSkipped']
      .map(k=>[k,(run.after.history[k]-run.before.history[k])/frames]));
    if(kind==='candidate')assert(history.motionQueriesSkipped>0);else assert.equal(history.motionQueriesSkipped,0);
    const window={tag,result:metrics(intervals),history,workload:run.workload,rhiMs:run.rhiMs,
      cameraStart:run.before.camera,cameraEnd:run.after.camera,travelCm:run.travel,turnDegrees:run.turn,
      display:run.display,budget:run.after.ownerBudget};windows.push(window);
    captures[tag]={raw:audit(path.join(results,tag+'.json')),source:r.source,log:audit(path.join(results,tag+'-1-page3.log'))};
  }
  normal[kind]={result:metrics(all),windows,history:Object.fromEntries(Object.keys(windows[0].history).map(k=>[k,mean(windows.map(w=>w.history[k]))])),
    rhiMs:mean(windows.map(w=>w.rhiMs)),workload:Object.fromEntries(Object.keys(windows[0].workload).map(k=>[k,mean(windows.map(w=>w.workload[k]))]))};
}
for(const name of Object.keys(packages.control.manifest).filter(n=>!['index.html','config-files.json'].includes(n)))
  assert.equal(packages.control.manifest[name].sha256,packages.candidate.manifest[name].sha256,name);
const report={date:new Date().toISOString(),pass:true,experimentCompleted:true,defaultEnabled:false,performanceAccepted:false,
  physicalPresentationValidated:false,packages,captures,normal,
  definition:'Submission intervals; slowest ceil(N*0.01) intervals form 1% Low; all stalls included, no gaps between independent windows.',
  boundary:'DOM mouse events through the packaged owner-forwarded input bridge and real possessed pawn camera. Orientation reset occurs only between phases. Identical start and input trajectory do not guarantee identical frame-weighted draw counts or physical mouse latency.',
  build:audit(path.join(results,'mouse-query-build-report-v2-'+date+'.json'))};
report.diagnostics={};report.validation={};
for(const kind of ['control','candidate']){
  const tag='mouse-query-'+kind+'-diagnostic-'+date,r=read(tag),run=r.runs[0];
  assert(r.pass&&r.gpuProbe&&r.recoveryCheck&&r.visibilityCheck);
  assert(run.gpuSummary.peak<=3&&run.visibility.resumed>run.visibility.paused);
  assert(run.gpu.records.every(v=>v.done));
  const latency=run.gpu.records.map(v=>v.done-v.at).toSorted((a,b)=>a-b);
  report.diagnostics[kind]={raw:audit(path.join(results,tag+'.json')),source:r.source,
    gpu:{...run.gpuSummary,p99Ms:latency[Math.floor(latency.length*.99)]},visibility:run.visibility,
    recovery:{before:run.recovery.before.history,after:run.recovery.after.history}};
  const validationTag='mouse-query-'+kind+'-validation-'+date,v=read(validationTag);
  assert(v.pass&&v.tour.length===5&&v.readbackTest.pass);assert.deepEqual(v.errors,[]);
  assert(v.bindingValidationAfter.occlusion.bindingEntriesValidated>v.bindingValidationBefore.occlusion.bindingEntriesValidated);
  report.validation[kind]={raw:audit(path.join(results,validationTag+'.json')),source:v.source,tour:v.tour,
    bindingChecks:v.bindingValidationAfter.occlusion.bindingEntriesValidated-v.bindingValidationBefore.occlusion.bindingEntriesValidated,
    readback:v.readbackTest,pipelineDiagnostics:v.pipelineDiagnostics,
    staticResult:v.runs[0].result};
}
report.exploratory={};
for(const tag of ['mouse-turn-diagnostic-orbit-'+date,'mouse-bindings-probe-b1-'+date,
  'mouse-csm128-probe-b1-'+date,'mouse-query-page2-probe-'+date]){
  const r=read(tag),run=r.runs[0];assert(r.pass);
  report.exploratory[tag]={raw:audit(path.join(results,tag+'.json')),source:r.source,result:run.result,
    workload:run.workload,rhiMs:run.rhiMs,resetInput:r.resetInput||false,mode:run.mode,
    start:run.before.camera,end:run.after.camera,recovery:!!run.recovery};
}
report.failures={};
for(const tag of ['mouse-turn-diagnostic-'+date,'mouse-turn-diagnostic-retry-'+date,'mouse-query-a1-'+date]){
  const r=read(tag);assert(!r.pass);report.failures[tag]={raw:audit(path.join(results,tag+'.json')),failure:r.failure};
}
report.failures.validationInvocation={log:audit(path.join(results,'mouse-query-control-validation-'+date+'-run.log')),
  reason:'Absolute profile path rejected before browser launch; retried with a valid profile name.'};
report.ownerProfile=audit(path.join(results,'mouse-turn-diagnostic-orbit-'+date+'-1-mouse-cpu-0.cpuprofile'));
const inputs=['../../reference-engine/Engine/Source/Runtime/Renderer/Private/SceneVisibility.cpp',
  '../../reference-engine/Engine/Source/Runtime/Renderer/Private/SceneOcclusion.cpp',
  '../../reference-engine/Engine/Source/Runtime/Renderer/Private/WebOcclusionHistory.h',
  '../ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp'];
const build=read('mouse-query-build-report-v2-'+date);assert(build.pass&&build.lowerMemory64&&build.threads);
report.implementation=inputs.map(n=>audit(path.resolve(__dirname,n)));
for(const source of report.implementation)assert(build.sourceFiles.some(s=>s.sha256===source.sha256));
report.links=audit(path.join(results,'mouse-query-links-'+date+'.json'));
report.visuals=['mouse-query-tail-'+date+'.png','mouse-query-views-'+date+'.jpg']
  .filter(n=>fs.existsSync(path.join(results,n))).map(n=>audit(path.join(results,n)));
for(const key of ['fps','low1'])report[key+'ChangePercent']=100*(normal.candidate.result[key]/normal.control.result[key]-1);
fs.writeFileSync(path.join(__dirname,'evidence/villa-mouse-query-'+date+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({normal,fpsChangePercent:report.fpsChangePercent,low1ChangePercent:report.low1ChangePercent},null,2));
