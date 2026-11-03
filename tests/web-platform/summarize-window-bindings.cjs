'use strict';
// Verify saved experiments after all timed work has stopped.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {audit}=require('./content-file-metadata.cjs');
const file=name=>path.join(__dirname,'results',name);
const read=name=>JSON.parse(fs.readFileSync(file(name),'utf8').replace(/^\uFEFF/,''));
const hashes=new Map();
const valid=item=>{if(!hashes.has(item.file))hashes.set(item.file,audit(item.file).sha256);assert.equal(hashes.get(item.file),item.sha256,item.file);return item;};
const record=name=>audit(file(name));
function comparison(name){
 const raw=read(name);assert(raw.pass&&raw.performanceAccepted&&!raw.allocationProbe&&raw.runs.length===4);valid(raw.source);
 for(const p of Object.values(raw.packages))Object.values(p.files).forEach(valid);
 const runs=raw.runs.map(r=>{
  assert(r.errors.length===0&&r.before.threads.cores===4&&r.before.threads.taskWorkers===3);
  assert(r.before.threads.renderThread&&r.before.threads.rhiThread);
  assert(!r.before.occlusion.manualVertexFetchEnabled&&r.before.occlusion.manualVertexFetchDraws===0);
  const count=r.after.occlusion.sampleFrame-r.before.occlusion.sampleFrame;
  const counters=Object.fromEntries(['unchangedResourceBindings','skippedBindingShaderScans','groupPreparationHits','resourceTableCommits','bindingRouteResolutions','bindingEntriesReused'].filter(k=>typeof r.after.occlusion[k]==='number'&&typeof r.before.occlusion[k]==='number').map(k=>[k,(r.after.occlusion[k]-r.before.occlusion[k])/count]));
  return {folder:r.folder,started:r.started,fps:r.fps,low1:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,countersPerSampleFrame:counters,
   view:r.before.view,settings:r.before.settings,threads:r.before.threads,browserMetrics:r.before.browserMetrics,pageBefore:r.pageBefore,pageAfter:r.pageAfter};
 });
 return {file:record(name),source:raw.source,summary:raw.summary,runs,raw};
}
const window=comparison('villa-browser-metrics-v47-abba.json'),binding=comparison('villa-binding-skips-v48-abba.json');
function build(tag,auditName){
 const packaged=read(tag+'-package.json'),build=read(tag+'-build.json'),compile=read(auditName);
 assert(packaged.pass&&build.pass&&compile.pass&&build.allocator==='mimalloc'&&!build.allocationProbe);
 valid(packaged.build);assert.equal(packaged.build.sha256,compile.build.sha256);
 assert.equal(compile.objects.length,417);assert.deepEqual(compile.compileCounts,{'-O2':416,'-O1':1});
 assert(compile.simdUnits===0&&compile.ltoUnits===0&&compile.link.optimization.length===0);
 assert.equal(compile.link.assertions,'1');assert.deepEqual(packaged.projectQualityOverrides,[]);
 packaged.products.forEach(valid);
 assert.equal(packaged.products.find(p=>path.basename(p.file)==='content.bin').sha256,'bb707f08ad34fcfc2ca0da99893edf063d733a9a4ddf75efc1cd4d63c800190d');
 for(const item of compile.products.filter(p=>/\.(js|wasm)$/.test(p.file)))assert.equal(packaged.products.find(p=>path.basename(p.file)===path.basename(item.file)).sha256,item.sha256);
 return {package:record(tag+'-package.json'),build:record(tag+'-build.json'),compile:record(auditName),compileCounts:compile.compileCounts,link:compile.link,raw:compile};
}
const v47=build('villa-browser-metrics-v47','v47-browser-metrics-compile-audit.json'),v48=build('villa-binding-skips-v48','v48-binding-skips-compile-audit.json');
const currentBuild=read('villa-binding-skips-v48-build.json');
const implementationSources=currentBuild.sourceFiles.filter(p=>/WebApplication\.cpp$|WebGPUDynamicRHI\.(cpp|h)$/.test(p.file)).map(p=>{
 if(!/WebGPUDynamicRHI\.(cpp|h)$/.test(p.file)){valid(p);return p;}
 const archived=audit(file('v48-candidate-'+path.basename(p.file)));assert.equal(archived.sha256,p.sha256);
 return {captured:p,archived};
});
assert(implementationSources.length>=3);
const patch=path.join(__dirname,'experiments/web-binding-skips-v48.patch');
const applyCheck=spawnSync('git',['apply','--check',patch],{cwd:path.join(__dirname,'../..'),encoding:'utf8'});
assert.equal(applyCheck.status,0,applyCheck.stderr);
const restored=read('v47-default-restored-compile-audit.json');
assert(restored.pass&&restored.objects.length===417&&restored.link.optimization.length===0);
for(const unit of restored.objects)assert.equal(unit.object.sha256,v47.raw.objects.find(o=>o.source===unit.source).object.sha256);
for(const p of restored.products.filter(p=>/\.(js|wasm)$/.test(p.file))){valid(p);assert.equal(p.sha256,v47.raw.products.find(o=>path.basename(o.file)===path.basename(p.file)).sha256);}
function changed(a,b){
 assert(a.objects.length===b.objects.length);
 return a.objects.filter(o=>{const before=b.objects.find(v=>v.source===o.source);assert(before);return before.object.sha256!==o.object.sha256;}).map(o=>({module:o.module,source:o.source}));
}
const changedObjects={v47VersusV45:changed(v47.raw,read('v45-mimalloc-no-proxy-compile-audit.json')),v48VersusV47:changed(v48.raw,v47.raw)};
assert(changedObjects.v47VersusV45.length===1&&changedObjects.v47VersusV45.every(o=>o.module==='ApplicationCore'));
assert(changedObjects.v48VersusV47.length===6&&changedObjects.v48VersusV47.every(o=>o.module==='WebGPURHI'));
const views={};
for(const tag of ['villa-browser-metrics-v47-views-v4','villa-binding-skips-v48-views']){
 const v=read(tag+'.json');assert(v.pass&&v.views.length===6&&v.errors.length===0);valid(v.source);v.packageFiles.forEach(valid);
 if(v.windowMetrics)assert.equal(v.windowMetrics.length,4);
 views[tag]={file:record(tag+'.json'),screenshot:record(tag+'.png'),views:v.views.length,windowMetrics:v.windowMetrics,imageAccepted:true};
}
const gameplay=read('project-gameplay-binding-skips-v48-validate.json');
assert(gameplay.pass&&gameplay.validateBindingCache&&gameplay.requireGPUScene&&gameplay.requireResourceTables&&gameplay.requireRenderThreads);
assert.equal(gameplay.sourceSha256,audit(path.join(__dirname,'probe-web-project-gameplay.cjs')).sha256);
const validation=gameplay.runs.map(r=>{
 assert(r.pass&&r.errors.length===0&&r.maxTravelCm>50&&r.maxTurnDegrees>10);
 const last=r.samples.at(-1),b=last.bindings;
 assert(b.groupPreparationValidated>1000&&b.bindingEntriesValidated>1000);
 return {maxTravelCm:r.maxTravelCm,maxTurnDegrees:r.maxTurnDegrees,frames:last.frame,bindings:b};
});
const costs=JSON.parse(fs.readFileSync(path.join(__dirname,'evidence/window-bindings-v48-frame-costs-20261103.json'),'utf8'));
valid(costs.source);valid(costs.targets);costs.threads.forEach(t=>valid(t.profile));
const baselineCosts=JSON.parse(fs.readFileSync(path.join(__dirname,'evidence/mimalloc-v45-frame-costs-20261103.json'),'utf8'));
const analysisName='villa-binding-skips-v48-cpu-profile-1-workers-analysis.json';
const analysis=read(analysisName),gameWaits=analysis.profiles.find(p=>p.role==='Game').waits;
const environmentFile=file('villa-window-bindings-v47-v48-environment.jsonl');
const environment=fs.readFileSync(environmentFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const windows=[...window.raw.runs,...binding.raw.runs].map(r=>[r.measurement.timeOrigin+r.measurement.start,r.measurement.timeOrigin+r.measurement.end]);
const measured=environment.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));
assert(measured.length>=20&&measured.every(e=>e.blockers.length===0));
for(const r of binding.runs.filter(r=>r.folder==='villa-binding-skips-v48')){
 assert(r.countersPerSampleFrame.unchangedResourceBindings>0&&r.countersPerSampleFrame.skippedBindingShaderScans>0);
}
const testCorrections=['villa-browser-metrics-v47-views.json','villa-browser-metrics-v47-views-v2.json','villa-browser-metrics-v47-metrics-v3.json'].map(name=>{const r=read(name);assert(!r.pass);return {file:record(name),error:r.error,boundary:'Test expectation corrected for canvas aspect ratio and actual browser floating-point DPR; engine source unchanged between these checks and the passing v4.'};});
delete window.raw;delete binding.raw;delete v47.raw;delete v48.raw;
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),window,binding,builds:{v47,v48,changedObjects,implementationSources,restored:record('v47-default-restored-compile-audit.json'),experimentalBindingPatch:audit(patch),bindingPatchApplies:true,currentRuntimeMatches:'villa-browser-metrics-v47',defaultAllocator:'Build script remains dlmalloc by default; all compared packages and the restored current runtime explicitly use mimalloc.'},views,
 gameplay:{file:record('project-gameplay-binding-skips-v48-validate.json'),validation},
 sampling:{baseline:audit(path.join(__dirname,'evidence/mimalloc-v45-frame-costs-20261103.json')),after:audit(path.join(__dirname,'evidence/window-bindings-v48-frame-costs-20261103.json')),stackAnalysis:record(analysisName),gameWaits,baselineThreads:baselineCosts.threads.map(t=>({role:t.role,exclusive:t.exclusive,inclusive:t.inclusive})),afterThreads:costs.threads.map(t=>({role:t.role,exclusive:t.exclusive,inclusive:t.inclusive})),boundary:costs.boundary},
 environment:{file:audit(environmentFile),measurementSamples:measured.length,blockersDuringMeasurements:[],backgroundCPU:measured.flatMap(e=>e.topCPU.filter(p=>p.name!=='msedge')).reduce((map,p)=>({...map,[p.name]:Math.max(map[p.name]||0,p.cpuCores)}),{}),boundary:'User background applications retained. Timed experiments are serial, without builds, packaging or profilers. No exclusive CPU/GPU ownership claimed.'},testCorrections,
 boundary:'ABBA fixed spawn is not a traversal or a long-term stability test. FPS uses completed RHI viewport presents; 1% Low is inverse mean of the slowest 1% intervals. Cached binding validation recomputes descriptors in a separate gameplay run and is disabled in normal FPS. CPU stack percentages are per-thread sampled residence and are not additive frame costs. Cook, quality, scalar compilation and final-link policy are preserved. No claim of eliminating all WebGPU interaction overhead or diagnosing all low-frame causes.'};
const output=path.join(__dirname,'evidence/window-bindings-20261103.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,window:window.summary,binding:binding.summary,changedObjects,validation,measurementSamples:measured.length}));
