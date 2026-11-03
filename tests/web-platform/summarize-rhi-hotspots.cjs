'use strict';
// Hashing and aggregation run only after all timed experiments finish.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const file=n=>path.join(__dirname,'results',n),read=n=>JSON.parse(fs.readFileSync(file(n),'utf8').replace(/^\uFEFF/,''));
const cache=new Map(),valid=p=>{if(!cache.has(p.file))cache.set(p.file,audit(p.file).sha256);assert.equal(cache.get(p.file),p.sha256,p.file);return p;};
const record=n=>audit(file(n));
function capture(name,count){
 const x=read(name);assert(x.pass&&x.performanceAccepted&&!x.allocationProbe&&x.runs.length===count);valid(x.source);valid(x.capturedSource);assert.equal(x.source.sha256,x.capturedSource.sha256);
 assert.deepEqual(x.qualityOverrides,[]);assert.equal(x.psoPrecache,false);
 for(const p of Object.values(x.packages))Object.values(p.files).forEach(valid);
 return x;
}
const isolate=capture('villa-rhi-hotspots-v52-reboot-isolation.json',8),combined=capture('villa-rhi-hotspots-v52-reboot-combined-abba.json',4),reverse=capture('villa-rhi-hotspots-v52-reboot-combined-baab.json',4);
assert.deepEqual(isolate.runs.map(r=>r.rhiExperiment),['control','tick','metadata','storage','storage','metadata','tick','control']);
assert.deepEqual(combined.runs.map(r=>r.folder),['villa-browser-metrics-v47','villa-rhi-hotspots-v52','villa-rhi-hotspots-v52','villa-browser-metrics-v47']);
assert.deepEqual(reverse.runs.map(r=>r.folder),['villa-rhi-hotspots-v52','villa-browser-metrics-v47','villa-browser-metrics-v47','villa-rhi-hotspots-v52']);
const counters=['noopRHITicksSkipped','nativeStorageContractUses','storageDescriptorRevalidations','storageContractRejectionChecks','bindingEntriesPrepared','bindingEntriesReused','groupPreparationHits','groupFrameMisses','groupAccessMisses','groupVersionMisses','groupTextureMisses','bindGroupCacheHits','bindGroupsCreated'];
function runs(x){return x.runs.map(r=>{
 assert.equal(r.errors.length,0);assert(r.before.threads.cores===4&&r.before.threads.taskWorkers===3&&r.before.threads.renderThread&&r.before.threads.rhiThread);
 assert.deepEqual(r.before.settings,r.after.settings);assert.deepEqual(r.before.camera,r.after.camera);
 const count=r.after.occlusion.sampleFrame-r.before.occlusion.sampleFrame;assert(count>0);
 const perFrame=Object.fromEntries(counters.filter(k=>typeof r.after.occlusion[k]==='number'&&typeof r.before.occlusion[k]==='number').map(k=>[k,(r.after.occlusion[k]-r.before.occlusion[k])/count]));
 if(r.rhiExperiment){
  assert.equal(r.rhiExperimentConfirmed,r.rhiExperiment);assert.equal(perFrame.storageContractRejectionChecks,0);
  assert.equal(perFrame.noopRHITicksSkipped>0,r.rhiExperiment==='tick');
  assert.equal(perFrame.nativeStorageContractUses>0,r.rhiExperiment==='metadata');
  assert.equal(perFrame.storageDescriptorRevalidations>0,r.rhiExperiment==='storage');
 }else if(r.folder==='villa-rhi-hotspots-v52'){
  assert.equal(r.rhiExperimentConfirmed,'all');
  assert(r.before.occlusion.skipNoopRHITick&&r.before.occlusion.nativeStorageContracts&&r.before.occlusion.revalidateStorageDescriptors);
  assert(perFrame.noopRHITicksSkipped>0&&perFrame.nativeStorageContractUses>0&&perFrame.storageDescriptorRevalidations>0);
 }
 return {folder:r.folder,mode:r.rhiExperiment||'default',started:r.started,fps:r.fps,low1:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,countersPerFrame:perFrame,settings:r.before.settings,view:r.before.view,threads:r.before.threads,pageBefore:r.pageBefore,pageAfter:r.pageAfter};
});}
const isolationRuns=runs(isolate),combinedRuns=runs(combined),reverseRuns=runs(reverse);
function pooled(records){
 const intervals=records.flatMap(r=>r.intervals),sorted=[...intervals].sort((a,b)=>a-b),slow=sorted.slice(-Math.ceil(sorted.length*.01));
 return {fps:records.reduce((n,r)=>n+r.measurement.frames,0)/records.reduce((n,r)=>n+r.measurement.end-r.measurement.start,0)*1000,
  low1Fps:1000/(slow.reduce((a,b)=>a+b,0)/slow.length),frames:intervals.length,over33ms:intervals.filter(v=>v>1000/30).length};
}
const combinedPooled=Object.fromEntries(['villa-browser-metrics-v47','villa-rhi-hotspots-v52'].map(folder=>[folder,pooled([...combined.runs,...reverse.runs].filter(r=>r.folder===folder))]));
const combinedChange={fpsPercent:(combinedPooled['villa-rhi-hotspots-v52'].fps/combinedPooled['villa-browser-metrics-v47'].fps-1)*100,
 lowPercent:(combinedPooled['villa-rhi-hotspots-v52'].low1Fps/combinedPooled['villa-browser-metrics-v47'].low1Fps-1)*100};
for(const run of [...isolate.runs,...combined.runs,...reverse.runs]){
 assert.deepEqual(run.before.camera,isolate.runs[0].before.camera);
 assert.deepEqual(run.before.settings,isolate.runs[0].before.settings);
 assert.deepEqual(['width','height','outputWidth','outputHeight','antiAliasing'].map(k=>run.before.view[k]),
  ['width','height','outputWidth','outputHeight','antiAliasing'].map(k=>isolate.runs[0].before.view[k]));
}
const baseline=isolate.summary.control;
const independent=Object.fromEntries(['tick','metadata','storage'].map(k=>[k,{fps:isolate.summary[k].fps,low1:isolate.summary[k].frameMs.low1Fps,fpsChangePercent:(isolate.summary[k].fps/baseline.fps-1)*100,lowChangePercent:(isolate.summary[k].frameMs.low1Fps/baseline.frameMs.low1Fps-1)*100}]));
const packaged=read('villa-rhi-hotspots-v52-package.json'),build=read('villa-rhi-hotspots-v52-build.json'),compile=read('v52-rhi-hotspots-compile-audit.json');
assert(packaged.pass&&build.pass&&compile.pass&&build.allocator==='mimalloc'&&!build.allocationProbe);valid(packaged.build);packaged.products.forEach(valid);packaged.sources.forEach(valid);
const sources=build.sourceFiles.filter(p=>/WebGPUDynamicRHI\.(cpp|h)$|\/UEWebEngine\.cpp$|\\UEWebEngine\.cpp$/.test(p.file));assert.equal(sources.length,3);sources.forEach(valid);
assert.equal(compile.objects.length,417);assert.deepEqual(compile.compileCounts,{'-O2':416,'-O1':1});assert(compile.simdUnits===0&&compile.ltoUnits===0&&compile.link.optimization.length===0&&compile.link.assertions==='1');
assert.equal(compile.build.sha256,packaged.build.sha256);
assert.equal(packaged.products.find(p=>path.basename(p.file)==='content.bin').sha256,'bb707f08ad34fcfc2ca0da99893edf063d733a9a4ddf75efc1cd4d63c800190d');
const view=read('villa-rhi-hotspots-v52-reboot-views.json');assert(view.pass&&view.views.length===6&&view.windowMetrics.length===4&&view.errors.length===0);valid(view.source);view.packageFiles.forEach(valid);
const gameplay=read('project-gameplay-rhi-hotspots-v52-reboot-validate.json');assert(gameplay.pass&&gameplay.validateBindingCache&&gameplay.requireGPUScene&&gameplay.requireResourceTables&&gameplay.requireRenderThreads);
assert.equal(gameplay.sourceSha256,audit(path.join(__dirname,'probe-web-project-gameplay.cjs')).sha256);
const validation=gameplay.runs.map(r=>{
 assert(r.pass&&r.errors.length===0&&r.maxTravelCm>50&&r.maxTurnDegrees>10);const s=r.samples.at(-1);
 assert(s.bindings.bindingEntriesValidated>1000&&s.bindings.groupPreparationValidated>1000&&s.bindings.storageContractRejectionChecks>100);
 assert(s.bindings.skipNoopRHITick&&s.bindings.nativeStorageContracts&&s.bindings.revalidateStorageDescriptors);
 return {travelCm:r.maxTravelCm,turnDegrees:r.maxTurnDegrees,frames:s.frame,bindings:s.bindings};
});
const profiles={};
for(const mode of ['control','all']){
 const tag='villa-rhi-hotspots-v52-reboot-profile-'+mode,raw=read(tag+'.json');assert(raw.pass&&raw.rhi[0]===mode);valid(raw.source);valid(raw.capturedSource);
 const costsFile=path.join(__dirname,'evidence/rhi-hotspots-v52-reboot-'+mode+'-costs-20261104.json'),costs=JSON.parse(fs.readFileSync(costsFile,'utf8'));valid(costs.source);valid(costs.targets);costs.threads.forEach(t=>valid(t.profile));
 profiles[mode]={capture:record(tag+'.json'),costs:audit(costsFile),threads:costs.threads.map(t=>({role:t.role,durationMs:t.durationMs,inclusive:t.inclusive}))};
}
const failed=read('project-gameplay-rhi-hotspots-v49-validate.json');assert(!failed.pass&&failed.failure.includes('FCommandLine::Get'));
const flagFailure=read('villa-rhi-hotspots-v51-isolation.json');assert(!flagFailure.pass&&flagFailure.runs.length===1&&!flagFailure.runs[0].measurement&&flagFailure.error.includes("'all' !== 'control'"));
const interrupted=read('villa-rhi-hotspots-v52-isolation.json');assert(!interrupted.pass);
const envFile=file('villa-rhi-hotspots-v52-reboot-environment.jsonl'),environment=fs.readFileSync(envFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const windows=[...isolate.runs,...combined.runs,...reverse.runs].map(r=>[r.measurement.timeOrigin+r.measurement.start,r.measurement.timeOrigin+r.measurement.end]);
const measured=environment.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));assert(measured.length>=40&&measured.every(e=>e.blockers.length===0));
assert(windows.every(([a,b])=>environment.filter(e=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b).length>=3));
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),isolation:{file:record('villa-rhi-hotspots-v52-reboot-isolation.json'),summary:isolate.summary,independent,runs:isolationRuns},combined:{file:record('villa-rhi-hotspots-v52-reboot-combined-abba.json'),summary:combined.summary,runs:combinedRuns,reverse:{file:record('villa-rhi-hotspots-v52-reboot-combined-baab.json'),summary:reverse.summary,runs:reverseRuns},pooled:combinedPooled,change:combinedChange},
 build:{package:record('villa-rhi-hotspots-v52-package.json'),capture:record('villa-rhi-hotspots-v52-build.json'),compile:record('v52-rhi-hotspots-compile-audit.json'),sources,compileCounts:compile.compileCounts,link:compile.link},
 correctness:{view:record('villa-rhi-hotspots-v52-reboot-views.json'),screenshot:record('villa-rhi-hotspots-v52-reboot-views.png'),imageAccepted:true,windowMetrics:view.windowMetrics,gameplay:record('project-gameplay-rhi-hotspots-v52-reboot-validate.json'),validation},profiles,
 earlyFailure:{file:record('project-gameplay-rhi-hotspots-v49-validate.json'),reason:'Experiment flags were read before FCommandLine initialization. Moved to ConfigureStartup; v49 excluded from FPS.'},flagForwardingFailure:{file:record('villa-rhi-hotspots-v51-isolation.json'),reason:'Startup mode assertion detected all instead of control before measurement. v52 forwards the explicitly validated experiment argument to UE.'},
 interruptedCapture:{file:record('villa-rhi-hotspots-v52-isolation.json'),includedInPerformance:false,runs:interrupted.runs.filter(r=>r.after).map(r=>({mode:r.rhiExperiment,fps:r.fps,low1:r.frameMs.low1Fps})),reason:'Incomplete before the user-reported power interruption. Retained as raw history; all final performance windows were collected after restart.'},
 environment:{file:audit(envFile),measurementSamples:measured.length,blockersDuringMeasurements:[],backgroundCPU:measured.flatMap(e=>e.topCPU.filter(p=>p.name!=='msedge')).reduce((map,p)=>({...map,[p.name]:Math.max(map[p.name]||0,p.cpuCores)}),{}),boundary:'User apps retained. Formal tests serial without builds, packaging or profilers. No exclusive CPU/GPU ownership.'},
 boundary:'Fixed-spawn ABBA, not a traversal low-frame or long-term stability test. Same Wasm switches isolate each change; a separate v47 comparison measures the combined net effect. 1% Low is inverse mean slowest 1% intervals. Short per-thread stack samples include waits, overlap inclusively, and exclude browser GPU process/GPU execution. No per-thread percentage is an exact saved frame cost.'};
const output=path.join(__dirname,'evidence/rhi-hotspots-20261104.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:true,output,independent,combined:combined.summary,validation,measurementSamples:measured.length}));
