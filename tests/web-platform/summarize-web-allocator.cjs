'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const directory=path.join(__dirname,'results');
const file=name=>path.join(directory,name);
const read=name=>JSON.parse(fs.readFileSync(file(name),'utf8').replace(/^\uFEFF/,''));
const valid=item=>{assert.equal(audit(item.file).sha256,item.sha256,item.file);return item;};
const mean=values=>values.reduce((sum,n)=>sum+n,0)/values.length;
function comparison(name){
 const raw=read(name);assert(raw.pass&&raw.performanceAccepted&&!raw.allocationProbe&&raw.runs.length===4);
 // The post-measurement diagnostic pointer conversion was corrected after
 // these runs. Preserve and verify the exact captured driver, without editing
 // raw reports or pretending their historical hash names the current source.
 const capturedSource=audit(file('villa-allocator-v44-v45-capture-source.cjs'));
 assert.equal(raw.source.sha256,capturedSource.sha256);
 for(const p of Object.values(raw.packages))Object.values(p.files).forEach(valid);
 for(const run of raw.runs)assert(run.errors.length===0&&run.before.threads.cores===4&&run.before.threads.taskWorkers===3);
 return {file:audit(file(name)),capturedSource,sourceBoundary:'Only the allocation-probe snapshot pointer conversion changed after capture. Normal FPS branches unchanged; archived source hash verified.',summary:raw.summary,runs:raw.runs.map(r=>({folder:r.folder,started:r.started,
  fps:r.fps,low1:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,view:r.before.view,
  settings:r.before.settings,threads:r.before.threads,pageBefore:r.pageBefore,pageAfter:r.pageAfter})),raw};
}
const proxy=comparison('villa-allocator-no-proxy-v44-abba.json');
const mimalloc=comparison('villa-mimalloc-no-proxy-v45-abba.json');
const contract=read('allocator-contract-v43-final-v2.json');assert(contract.pass&&contract.runs.length===4);
valid(contract.source);contract.sources.forEach(valid);contract.products.forEach(valid);
const preparation=[];
for(const allocator of ['dlmalloc','mimalloc'])for(const workers of [1,2,4])for(const mode of ['rebuild-stack','rebuild-allocation']){
 const times=contract.runs.filter(r=>r.allocator===allocator).map(r=>r.cpu.find(x=>x.workers===workers&&x.mode===mode).wall.medianMs);
 preparation.push({allocator,workers,mode,runMediansMs:times,meanOfRunMediansMs:mean(times)});
}
function sameObjects(a,b){
 assert(a.pass&&b.pass&&a.objects.length===417&&b.objects.length===417);
 for(const unit of a.objects){const old=b.objects.find(x=>x.source===unit.source);assert(old);assert.equal(unit.object.sha256,old.object.sha256);}
 return 417;
}
const baseline=read('v38-compile-optimization-audit.json'),withProxy=read('v43-mimalloc-proxy-compile-audit.json');
const noProxy=read('v44-no-proxy-compile-audit.json'),both=read('v45-mimalloc-no-proxy-compile-audit.json');
const restored=read('v44-default-restored-compile-audit.json');
const objectChecks={mimallocWithProxyVersusBaseline:sameObjects(withProxy,baseline),mimallocWithoutProxyVersusDlmalloc:sameObjects(both,noProxy),restoredVersusNoProxy:sameObjects(restored,noProxy)};
assert(restored.simdUnits===0&&restored.ltoUnits===0&&restored.link.optimization.length===0);
for(const p of restored.products.filter(x=>/\.(js|wasm)$/.test(x.file))){valid(p);assert.equal(p.sha256,noProxy.products.find(x=>path.basename(x.file)===path.basename(p.file)).sha256);}
const views={};
for(const tag of ['villa-mimalloc-proxy-v43-views-v3','villa-allocator-no-proxy-v44-views','villa-mimalloc-no-proxy-v45-views']){
 const view=read(tag+'.json');assert(view.pass&&view.views.length===6&&view.errors.length===0);view.packageFiles.forEach(valid);
 views[tag]={file:audit(file(tag+'.json')),screenshot:audit(file(tag+'.png')),views:6,imageAccepted:true};
}
const failed=read('villa-mimalloc-proxy-v43-views-v2.json');assert(!failed.pass);
const prefix='villa-allocation-probe-v46-profile-1-workers';
const probeRun=read('villa-allocation-probe-v46-profile.json');assert(probeRun.pass&&probeRun.allocationProbe&&!probeRun.performanceAccepted);valid(probeRun.source);
const probe=read(prefix+'-allocations.json');valid(probe.source);
const baselineAnalysis=read('villa-allocation-baseline-v43-profile-v2-1-workers-allocator-analysis.json'),analysis=read(prefix+'-allocator-analysis.json');
const mimallocAnalysis=read('villa-mimalloc-no-proxy-v45-cpu-profile-1-workers-allocator-analysis.json');
for(const a of [baselineAnalysis,analysis,mimallocAnalysis]){valid(a.source);valid(a.targets);a.profiles.forEach(p=>valid(p.file));}
const targets=read(prefix+'-targets.json'),frames=probe.end.frames-probe.start.frames,seconds=(probe.end.at-probe.start.at)/1000;
assert(frames>0&&seconds>=4);
const allocations=probe.data.threads.map(thread=>{
 const index=targets.findIndex(t=>String(t.pthread)===thread.pthread);
 return {pthread:thread.pthread,role:index<0?'unresolved':analysis.profiles[index].role,
  operations:thread.operations.map((op,i)=>({name:probe.operations[i],...op,callsPerFrame:op.calls/frames,requestedBytesPerFrame:op.requestedBytes/frames,inclusiveMsPerFrame:op.inclusiveNs/1e6/frames}))};
});
const envFile=file('villa-allocator-v43-environment.jsonl');
const environment=fs.readFileSync(envFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const windows=[...contract.runs.map(r=>[Date.parse(r.started),Date.parse(r.ended)]),...[...proxy.raw.runs,...mimalloc.raw.runs].map(r=>[r.measurement.timeOrigin+r.measurement.start,r.measurement.timeOrigin+r.measurement.end])];
const measured=environment.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));
assert(measured.length>20&&measured.every(e=>e.blockers.length===0));
delete proxy.raw;delete mimalloc.raw;
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),proxy,mimalloc,
 contract:{file:audit(file('allocator-contract-v43-final-v2.json')),preparation,boundary:contract.boundary},
 builds:{objectChecks,audits:['v43-mimalloc-proxy-compile-audit.json','v44-no-proxy-compile-audit.json','v45-mimalloc-no-proxy-compile-audit.json','v46-allocation-probe-compile-audit.json','v44-default-restored-compile-audit.json'].map(n=>audit(file(n))),restoredProducts:restored.products,default:'dlmalloc, no UE thread-safety proxy, no diagnostic wrappers'},
 views,intermittentFailure:{file:audit(file('villa-mimalloc-proxy-v43-views-v2.json')),log:audit(file('villa-mimalloc-proxy-v43-views-v2.log')),error:failed.error||failed.errors,rootCauseConfirmed:false,mimallocDefaultAccepted:false},
 sampling:{baseline:audit(file('villa-allocation-baseline-v43-profile-v2-1-workers-allocator-analysis.json')),after:audit(file(prefix+'-allocator-analysis.json')),mimalloc:audit(file('villa-mimalloc-no-proxy-v45-cpu-profile-1-workers-allocator-analysis.json')),
  baselineThreads:baselineAnalysis.profiles.filter(p=>p.role!=='Task/IO/auxiliary'),afterThreads:analysis.profiles.filter(p=>p.role!=='Task/IO/auxiliary'),mimallocThreads:mimallocAnalysis.profiles.filter(p=>p.role!=='Task/IO/auxiliary')},
 allocationProbe:{file:audit(file(prefix+'-allocations.json')),frames,seconds,threads:allocations,performanceAccepted:false,boundary:probe.boundary},
 environment:{file:audit(envFile),measurementSamples:measured.length,blockersDuringMeasurements:[],backgroundCPU:measured.flatMap(e=>e.topCPU.filter(p=>p.name!=='msedge')).reduce((map,p)=>({...map,[p.name]:Math.max(map[p.name]||0,p.cpuCores)}),{}),boundary:'User applications retained, including TGitCache and voice software. No claim of exclusive CPU/GPU ownership. Formal runs exclude builds, packaging and profilers.'},
 boundary:'Synthetic allocation speedup is not the game speedup. CPU profile residence includes waits and misses inlined names. Per-thread percentages are not additive frame costs. Instrumented libc timings include clock overhead and exclude outer UE proxy acquisition. Short scene checks cannot prove long-term allocator stability.'};
const output=path.join(__dirname,'evidence/web-allocator-20261103.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,proxy:proxy.summary,mimalloc:mimalloc.summary,preparation,probeFrames:frames}));
