'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n+'.json'),'utf8'));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function metrics(a){
  assert(a.length>100&&a.every(v=>Number.isFinite(v)&&v>0));const s=a.toSorted((a,b)=>a-b);
  return {frames:a.length,seconds:a.reduce((s,v)=>s+v,0)/1000,fps:1000/mean(a),
    low1:1000/mean(s.slice(-Math.ceil(s.length*.01))),p50:s[Math.floor(s.length*.5)],
    p95:s[Math.floor(s.length*.95)],p99:s[Math.floor(s.length*.99)],max:s.at(-1),
    over20:a.filter(v=>v>20).length,over25:a.filter(v=>v>25).length,
    over33:a.filter(v=>v>33.333).length,over50:a.filter(v=>v>50).length};
}
function capture(tag){
  const j=read(tag);assert(j.pass,tag);assert.deepEqual(j.errors,[]);assert(!j.presentMonEnabled);
  const intervals=[];
  const windows=j.runs.map(r=>{
    assert.deepEqual(r.before.camera,r.after.camera);assert.deepEqual(r.before.settings,r.after.settings);
    assert.deepEqual(r.capture.errors,[]);
    const values=r.capture.frames.slice(1).map((f,i)=>f.at-r.capture.frames[i].at);intervals.push(...values);
    const done=r.capture.frames.filter(f=>f.done&&f.submit),delays=done.map(f=>f.done-f.submit).sort((a,b)=>a-b);
    return {result:metrics(values),rhiMs:r.rhiMs,workload:r.workload,budget:r.after.gpuBudget,
      gpu:done.length?{records:done.length,peak:Math.max(...r.capture.frames.map(f=>f.pending||0)),
        meanMs:mean(delays),p99Ms:delays[Math.floor(delays.length*.99)],maxMs:delays.at(-1)}:null};
  });
  return {intervals,raw:j,summary:{tag,raw:audit(path.join(root,tag+'.json')),source:j.source,
    folder:j.folder,wakePriority:j.wakePriority,frameBudget:j.frameBudget,
    instrumentation:{gpu:j.gpuCompletionProbe,api:j.apiCountProbe,uploads:j.uploadValidationProbe},windows}};
}
const normal={};
for(const [name,tags] of Object.entries({control:['periodic-final-a1-20261106'],
  candidate:['periodic-final-b1-20261106','periodic-final-b2-20261106']})){
  const runs=tags.map(capture);for(const c of runs)assert(!c.raw.gpuCompletionProbe&&!c.raw.apiCountProbe&&!c.raw.uploadValidationProbe);
  normal[name]={result:metrics(runs.flatMap(r=>r.intervals)),captures:runs.map(r=>r.summary)};
}
const packages={};
for(const [name,folder]of Object.entries({control:'villa-address32-compute-20261106',candidate:'villa-owner-credit-transient-20261106'})){
  const base=path.join(__dirname,'build',folder),manifest=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [n,h]of Object.entries(manifest))assert.equal(audit(path.join(base,n)).sha256,h.sha256);
  packages[name]={folder,manifest,settings:JSON.parse(fs.readFileSync(path.join(base,'config-files.json')))
    .filter(v=>v.path==='/Engine/Platforms/Web/Config/WebEngine.ini').map(v=>Buffer.from(v.data,'base64').toString())};
}
for(const n of ['UEWebEngineThreads.js','UEWebEngineThreads.wasm','content-files.json'])
  assert.equal(packages.control.manifest[n].sha256,packages.candidate.manifest[n].sha256);
const screens=['periodic-owner-budget3-screen','periodic-owner-budget4-screen','periodic-owner-control-screen',
  'periodic-fresh-budget3-screen','periodic-fresh-budget4-screen','periodic-owner-credit3-screen',
  'periodic-owner-credit2-budget3-screen','periodic-transient-reduction-screen',
  'periodic-owner-credit2-budget4-screen','periodic-owner-transient-budget4-screen',
  'periodic-rhi-visible-budget3-retry','periodic-owner-bundles-budget3-screen'].map(n=>capture(n+'-20261106').summary);
const gpu={control:capture('periodic-owner-control-gpu-20261106').summary,
  rejectedFour:capture('periodic-owner-transient-gpu-20261106').summary,
  candidate:capture('periodic-owner-transient-budget3-gpu-20261106').summary};
const validation=read('periodic-owner-transient-gpu-20261106');
assert(validation.readbackTest.pass);assert.equal(validation.uploadValidation.completed,1024);
assert.deepEqual(validation.uploadValidation.errors,[]);
const routes={};
for(const [name,tag]of Object.entries({control:'periodic-owner-control-route-20261106',candidate:'periodic-owner-transient-route-screen-20261106'})){
  const r=read(tag);assert(r.pass);const run=r.runs[0];
  routes[name]={raw:audit(path.join(root,tag+'.json')),source:r.source,phases:run.phases.map(p=>({name:p.name,
    result:metrics(p.summary.intervals),creations:p.summary.creations,travel:p.summary.travelCm,turn:p.summary.turnDegrees}))};
}
const diagnosis=read('memory-owner-periodic-trace-20261106-analysis');
assert(diagnosis.pass);
const remainingDiagnosis=read('periodic-candidate-gpu-trace-20261106-analysis');
assert(remainingDiagnosis.pass);
const visuals=read('periodic-visual-comparison-20261106');
const inputs={};
for(const [name,mode]of Object.entries({control:'owner',candidate:'page3'})){
  const tag='periodic-real-input-'+mode+'-20261106',j=read(tag);assert(j.pass);const r=j.runs[0];
  assert(r.pass);assert.deepEqual(r.errors,[]);assert.deepEqual(r.before.settings,r.after.settings);
  assert.equal(r.after.optimization.graphicsPipelines,r.before.optimization.graphicsPipelines);
  assert.equal(r.after.optimization.computePipelines,r.before.optimization.computePipelines);
  const delays=r.gpu.records.map(f=>{assert(Number.isFinite(f.done));return f.done-f.at}).sort((a,b)=>a-b);
  inputs[name]={raw:audit(path.join(root,tag+'.json')),source:j.capturedSource,result:r.result,
    gpu:{...r.gpuSummary,p95Ms:delays[Math.floor(delays.length*.95)],p99Ms:delays[Math.floor(delays.length*.99)]},
    budget:r.after.ownerBudget,visibility:r.visibility,travel:r.travel,turn:r.turn,workload:r.workload,display:r.display};
}
const output={date:new Date().toISOString(),pass:true,performanceAccepted:false,periodicStallsEliminated:false,
  physicalPresentationValidated:false,packages,normal,screens,gpu,routes,inputs,
  validation:{raw:audit(path.join(root,'periodic-owner-transient-gpu-20261106.json')),
    tour:validation.tour,uploads:validation.uploadValidation,readback:validation.readbackTest,visuals},diagnosis,remainingDiagnosis,
  rejected:{fourCredits:'Higher throughput but GPU completion mean/p99 increased; final candidate uses three.',
    bundles:'Lower mean FPS and 1% low than the three-credit candidate.',
    userVisiblePriority:'Lower 1% low and longer worst frame; keep the existing user-blocking priority.',
    firstPriorityCapture:{source:audit(path.join(root,'periodic-rhi-visible-budget3-screen-20261106-source.cjs')),
      log:audit(path.join(root,'periodic-rhi-visible-budget3-screen-20261106.log')),
      reason:'Harness applied the Worker patch to the HTML route and asserted before engine startup. No timing JSON was produced. Retained source/log; corrected retry has a separate tag.'}},
  boundary:'B/A/A/B, 60 seconds per window. Submission intervals, all long frames retained. Same compiled runtime/Cook; candidate combines opt-in owner submission/GPU credits with resource-reuse settings. Three total reservations, at most two not yet submitted. Four-credit option rejected for increased completion latency. The candidate reduces periodic stalls but does not eliminate them. No local Game clock, frame-rate cap or quality reduction. GPU feedback includes callback scheduling and is not physical presentation.'};
const dest=path.join(__dirname,'evidence/villa-periodic-stalls-20261106.json');
fs.writeFileSync(dest,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({dest,normal:Object.fromEntries(Object.entries(normal).map(([k,v])=>[k,v.result])),gpu,routes},null,2));
