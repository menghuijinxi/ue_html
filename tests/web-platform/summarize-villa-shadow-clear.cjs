'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const results=path.join(__dirname,'results');
const read=tag=>JSON.parse(fs.readFileSync(path.join(results,tag+'.json')));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function metrics(a){
  assert(a.length>100&&a.every(v=>Number.isFinite(v)&&v>0));
  const s=a.toSorted((a,b)=>a-b);
  return {frames:a.length,seconds:a.reduce((s,v)=>s+v,0)/1000,fps:1000/mean(a),
    low1:1000/mean(s.slice(-Math.ceil(s.length*.01))),p95:s[Math.floor(s.length*.95)],
    p99:s[Math.floor(s.length*.99)],max:s.at(-1),over20:a.filter(v=>v>20).length,
    over25:a.filter(v=>v>25).length,over33:a.filter(v=>v>33.333).length,over50:a.filter(v=>v>50).length};
}
const packages={};
for(const kind of ['control','candidate']){
  const folder='villa-shadow-clear-'+kind+'-20261106',base=path.join(__dirname,'build',folder);
  const manifest=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [name,entry]of Object.entries(manifest))assert.equal(audit(path.join(base,name)).sha256,entry.sha256);
  const ini=JSON.parse(fs.readFileSync(path.join(base,'config-files.json'))).find(v=>v.path==='/Engine/Platforms/Web/Config/WebEngine.ini');
  packages[kind]={folder,manifest,ini:Buffer.from(ini.data,'base64').toString()};
}
for(const n of Object.keys(packages.control.manifest).filter(n=>!['index.html','config-files.json'].includes(n)))
  assert.equal(packages.control.manifest[n].sha256,packages.candidate.manifest[n].sha256,n);
assert(!packages.control.ini.includes('r.WebGPU.MergeShadowMaskClear='));
assert(packages.candidate.ini.includes('r.WebGPU.MergeShadowMaskClear=1'));
const captures={},normal={};let reference;
for(const kind of ['control','candidate']){
  const tags=kind==='control'?['a1','a2']:['b1','b2'];
  const runs=tags.map(t=>{
    const tag='turning-clear-'+t+'-20261106',r=read(tag);assert(r.pass&&!r.apiCounts&&!r.profileWorkers);
    assert.equal(r.folder,packages[kind].folder);assert.deepEqual(r.modes,['page3']);
    assert.equal(r.width,1280);assert.equal(r.height,720);const run=r.runs[0];assert.deepEqual(run.errors,[]);
    reference ||= run.ready;assert.deepEqual(run.ready.settings,reference.settings);assert.deepEqual(run.ready.camera,reference.camera);
    for(const p of run.phases){
      assert.deepEqual(p.before.settings,reference.settings);assert.deepEqual(p.before.settings,p.after.settings);
      assert(p.after.gpuBudget[3]<=3&&p.after.gpuBudget[5]<=3&&p.after.gpuBudget[7]<=2);
      if(p.name==='moving'||p.name==='turning')assert.equal(p.data.events.length,0);
    }
    captures[tag]={raw:audit(path.join(results,tag+'.json')),source:r.source,log:audit(path.join(results,tag+'-1-page3.log')),
      phases:run.phases.map(p=>({name:p.name,result:metrics(p.summary.intervals),creations:p.summary.creations,
        start:p.before.camera,end:p.after.camera,driver:p.driver,budget:p.after.gpuBudget}))};return run;
  });
  normal[kind]={};
  for(const name of ['first-area','moving','turning','repeat-area']){
    const phases=runs.map(r=>r.phases.find(p=>p.name===name));
    normal[kind][name]={result:metrics(phases.flatMap(p=>p.summary.intervals)),windows:phases.map(p=>metrics(p.summary.intervals))};
  }
}
const diagnostic={};
for(const [kind,tag]of [['control','turning-pass-diag-20261106'],['candidate','turning-clear-diag-20261106']]){
  const r=read(tag);assert(r.pass&&r.apiCounts);
  diagnostic[kind]={raw:audit(path.join(results,tag+'.json')),source:r.source,
    phases:r.runs[0].phases.map(p=>{
      const n=p.after.frame-p.before.frame;
      return {name:p.name,apiPerFrame:Object.fromEntries(Object.entries(p.after.counts).map(([k,v])=>[k,(v-(p.before.counts[k]||0))/n])),
        rhiMs:(p.after.stages.rhiWorkMilliseconds-p.before.stages.rhiWorkMilliseconds)/n};
    })};
}
const validation={};
for(const kind of ['control','candidate']){
  const tag='turning-clear-'+kind+'-validation-20261106',r=read(tag);assert(r.pass&&r.gpuCompletionProbe&&r.frameBudget===3);
  assert.deepEqual(r.errors,[]);assert.equal(r.tour.length,5);
  const frames=r.runs[0].capture.frames,delays=frames.filter(f=>f.done&&f.submit).map(f=>f.done-f.submit).sort((a,b)=>a-b);
  assert(delays.length>100);
  validation[kind]={raw:audit(path.join(results,tag+'.json')),source:r.source,tour:r.tour,
    gpu:{records:delays.length,meanMs:mean(delays),p99Ms:delays[Math.floor(delays.length*.99)],maxMs:delays.at(-1),
      pendingPeak:Math.max(...frames.map(f=>f.pending||0))},
    readback:r.readbackTest,bindingBefore:r.bindingValidationBefore?.occlusion,bindingAfter:r.bindingValidationAfter?.occlusion};
}
const gains={};
for(const phase of Object.keys(normal.control)){
  const a=normal.control[phase].result,b=normal.candidate[phase].result;
  gains[phase]={fpsPercent:100*(b.fps/a.fps-1),low1Percent:100*(b.low1/a.low1-1)};
}
const buildReport=read('turning-shadow-clear-build-report-20261106');
assert(buildReport.pass&&buildReport.lowerMemory64);
const lightSource=path.resolve(__dirname,'../../reference-engine/Engine/Source/Runtime/Renderer/Private/LightRendering.cpp');
const hostLight=path.resolve(__dirname,'../../.tools/ue58-web-build-host/Engine/Source/Runtime/Renderer/Private/LightRendering.cpp');
assert.equal(audit(lightSource).sha256,audit(hostLight).sha256);
const unit=buildReport.objects.find(v=>fs.readFileSync(v.source.file,'utf8').includes('#include "Runtime/Renderer/Private/LightRendering.cpp"'));
assert(unit,'LightRendering must be in a verified compiled translation unit');
for(const key of ['object','response','definitions','source'])assert.equal(audit(unit[key].file).sha256,unit[key].sha256);
const inputs={};
for(const kind of ['control','candidate']){
  const tag='turning-clear-'+kind+'-input-retry-20261106',r=read(tag);assert(r.pass&&r.packagedInput&&!r.defaultSettings);
  for(const run of r.runs){
    assert.equal(run.after.clock.mode,'page');assert.equal(run.inputBridge.mode,'owner-forwarded');
    assert.equal(run.gpu.records.filter(f=>f.done).length,run.gpu.records.length);
    assert(run.gpuSummary.peak<=3);assert(run.visibility.resumed>run.visibility.paused);
  }
  inputs[kind]={raw:audit(path.join(results,tag+'.json')),source:r.source,runs:r.runs.map(run=>({
    mode:run.mode,result:run.result,workload:run.workload,display:run.display,gpu:run.gpuSummary,
    cameraStart:run.before.camera,cameraEnd:run.after.camera,
    errors:run.errors,travelCm:run.travel,turnDegrees:run.turn,pass:run.pass,
    ownerBudget:run.after.ownerBudget,visibility:run.visibility,
    gpuP99Ms:run.gpu.records.map(f=>f.done-f.at).sort((a,b)=>a-b)[Math.floor(run.gpu.records.length*.99)]}))};
}
const report={date:new Date().toISOString(),pass:true,performanceAccepted:false,defaultEnabled:false,
  physicalPresentationValidated:false,periodicStallsEliminated:false,
  failedInputAttempt:{raw:audit(path.join(results,'turning-clear-control-input-20261106.json')),
    reason:'Invocation used --default-settings, stripping page3 URL switches. Clock assertion rejected owner before the timed window. Reran both sides with explicit page3 URLs and workspace profiles.'},
  definition:'RHI submission intervals, all long frames retained; 1% low = 1000 / mean(slowest ceil(N*0.01) intervals). No cross-window gaps.',
  boundary:'Same rebuilt runtime and Cook for A/B/B/A, page clock with 3 total credits and 2 unsubmitted maximum. API diagnostics are separate, different window durations and previous control binary; never used for FPS claims. No physical input-to-display latency measurement.',
  packages,captures,normal,gains,diagnostic,validation,inputs,
  build:audit(path.join(results,'turning-shadow-clear-build-report-20261106.json')),
  implementation:audit(lightSource),buildHost:audit(hostLight),translationUnit:unit,
  visuals:audit(path.join(results,'turning-clear-views-20261106.json'))};
fs.writeFileSync(path.join(__dirname,'evidence/villa-shadow-clear-20261106.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({normal,gains,gpu:Object.fromEntries(Object.entries(validation).map(([k,v])=>[k,v.gpu]))},null,2));
