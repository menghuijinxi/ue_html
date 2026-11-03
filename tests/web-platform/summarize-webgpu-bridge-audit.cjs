'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),results=path.join(__dirname,'results');
const read=name=>{const file=path.join(results,name);return {value:JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')),file:audit(file)};};
const passed=name=>{const result=read(name);assert.equal(result.value.pass,true,name);return result;};
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const ue=passed('villa-bridge-extras-v37-repeat.json'),micro=passed('bridge-extras-shared-final.json');
const equivalence=passed('bridge-extras-equivalence-v2.json'),views=passed('villa-bridge-extras-v38-views.json');
const audits=['bridge-import-audit-v37-baseline.json','bridge-import-audit-v37-all.json'].map(passed);
assert.equal(ue.value.runs.length,8);assert(!micro.value.validateCalls);assert(equivalence.value.validateCalls);
assert.equal(micro.value.rounds,3);assert.equal(micro.value.runs.length,6);
assert.deepEqual(micro.value.variants,['legacy-both','original']);
const packageProof=passed('villa-bridge-extras-v37-package.json');
for(const p of packageProof.value.products)assert.equal(audit(p.file).sha256,p.sha256,'Package changed: '+p.file);
const base=ue.value.packageFiles.find(p=>p.file.endsWith('.wasm')).sha256;
for(const a of audits)assert.equal(a.value.packageFiles.find(p=>p.file.endsWith('.wasm')).sha256,base);
const finalPackage=passed('villa-bridge-extras-v38-package.json'),finalAB=passed('villa-bridge-extras-v38-abba.json');
for(const p of finalPackage.value.products)assert.equal(audit(p.file).sha256,p.sha256,'Final package changed: '+p.file);
const finalWasm=finalPackage.value.products.find(p=>p.file.endsWith('.wasm')).sha256;
assert.equal(views.value.packageFiles.find(p=>p.file.endsWith('.wasm')).sha256,finalWasm);
assert.equal(finalAB.value.packageFiles.find(p=>p.file.endsWith('.wasm')).sha256,finalWasm);
assert.deepEqual(finalAB.value.transports,['baseline','all','all','baseline']);
assert.deepEqual(audits.map(a=>a.value.transport),['baseline','all']);
const viewKeys=['width','height','outputWidth','outputHeight','antiAliasing','x','y','outputX','outputY'];
for(const run of ue.value.runs){
 assert.equal(run.errors.length,0);assert.deepEqual(run.before.settings,ue.value.runs[0].before.settings);
 assert.deepEqual(viewKeys.map(k=>run.before.view[k]),viewKeys.map(k=>ue.value.runs[0].before.view[k]));
 assert.deepEqual(run.before.camera,ue.value.runs[0].before.camera);
}
const environmentFile=path.join(results,'villa-bridge-extras-v37-repeat-environment.jsonl');
const environment=fs.readFileSync(environmentFile,'utf8').trim().split(/\r?\n/).map(JSON.parse);
const start=Date.parse(ue.value.runs[0].started),end=Date.parse(ue.value.runs.at(-1).started)+180000;
const samples=environment.filter(s=>Date.parse(s.utc)>=start&&Date.parse(s.utc)<=end);
assert(samples.length);assert(samples.every(s=>s.blockers.length===0),'Compiler, UE or game overlapped normal FPS');
const environmentSummary={file:audit(environmentFile),samples:samples.length,blockers:[],
 backgroundProcesses:[...new Set(samples.flatMap(s=>s.topCPU.filter(p=>p.name!=='msedge').map(p=>p.name)))],
 boundary:'Background programs remain running. No exclusive-machine claim. Process monitor does not measure per-thread frequency or prove the cause of earlier environmental slowdowns.'};
const finalEnvironmentFile=path.join(results,'villa-bridge-extras-v38-environment.jsonl');
const finalEnvironment=fs.readFileSync(finalEnvironmentFile,'utf8').trim().split(/\r?\n/).map(JSON.parse);
assert(finalEnvironment.length&&finalEnvironment.every(s=>s.blockers.length===0),'Final FPS had compiler, game or UE overlap');
environmentSummary.final={file:audit(finalEnvironmentFile),samples:finalEnvironment.length,
 backgroundProcesses:[...new Set(finalEnvironment.flatMap(s=>s.topCPU.filter(p=>p.name!=='msedge').map(p=>p.name)))]};
const imports=audits.map(({file,value:a})=>({file,transport:a.transport,frames:a.measurement.frames,
 importsPerFrame:Object.values(a.measurement.calls).reduce((s,v)=>s+v.count,0)/a.measurement.frames,
 bigintArgumentsPerFrame:Object.values(a.measurement.calls).reduce((s,v)=>s+v.bigintArguments,0)/a.measurement.frames,
 viewChecksPerFrame:Object.values(a.measurement.calls).reduce((s,v)=>s+v.viewChecks,0)/a.measurement.frames,
 ranking:a.ranking.slice(0,35),nativePerFrame:Object.fromEntries(Object.entries(a.measurement.native).map(([k,v])=>[k,v/a.measurement.frames])),
 groupEntryHistogram:a.measurement.groupEntryCounts,
 boundary:a.boundary}));
const bindGroups=micro.value.variants.map(variant=>({variant,counts:[0,1,8,16,32].map(entries=>({entries,groupsPerSample:80,
 medianMs:median(micro.value.runs.filter(r=>r.variant===variant).map(r=>r.bindGroupCreation.find(g=>g.entries===entries).creation.medianMs))}))}));
const draws=micro.value.variants.map(variant=>({variant,cases:micro.value.runs.find(r=>r.variant===variant).cases.map(c=>({draws:c.draws,mode:c.mode,
 totalFrontendMs:median(micro.value.runs.filter(r=>r.variant===variant).map(r=>r.cases.find(v=>v.draws===c.draws&&v.mode===c.mode).totalFrontend.medianMs))}))}));
const profiles=views.value.profile;
const profile=read(path.basename(profiles)+'-analysis.json');
const report={date:new Date().toISOString(),pass:true,package:packageProof.file,packageFiles:ue.value.packageFiles,
 finalPackage:finalPackage.file,finalAB:{file:finalAB.file,summary:finalAB.value.summary,runs:finalAB.value.runs.map(r=>({index:r.index,transport:r.transport,fps:r.fps,low1Fps:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload})),
  boundary:'v38 adds an owner-thread fallback to the v37 descriptor prototype. Four-run same-WASM confirmation; the eight-run component ablation and import audit above remain the immutable v37 package.'},
 projectQualityOverrides:[],ue:{file:ue.file,summary:ue.value.summary,runs:ue.value.runs.map(r=>({index:r.index,transport:r.transport,fps:r.fps,
 low1Fps:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,transportConfirmed:r.transportConfirmed})),boundary:ue.value.boundary},
 micro:{file:micro.file,sources:micro.value.sources,bindGroups,draws,boundary:'Shared-memory WASM64, JSPI, same binary, three rounds in forward/reverse order. Descriptor batches time creation of 80 groups; release and queue completion are outside that timer. Groups are not used by benchmark draws. GPU preflights run separately from timed draws.'},
 equivalence:{file:equivalence.file,variants:equivalence.value.variants,runs:equivalence.value.runs.map(r=>({variant:r.variant,passes:r.apiRecords.length,
 preflightPasses:r.preflightApiRecords.length,groupDescriptors:r.groupDescriptors}))},
 correctness:{file:views.file,views:views.value.views.length,errors:views.value.errors},imports,environment:environmentSummary,
 profile:{file:profile.file,profiles:profile.value.profiles.filter(p=>p.role==='RHI').map(p=>({role:p.role,categories:p.categories,self:p.self.slice(0,15)})),boundary:profile.value.boundary},
 earlierEnvironmentSensitiveRun:{file:read('villa-bridge-extras-v37-six.json').file,summary:read('villa-bridge-extras-v37-six.json').value.summary,
 boundary:'Preserved for review; not used for improvement claims. Baseline fell to about 27 FPS, then both old v36 and same v37 baseline recovered above 52 FPS. Background downloads were present during the first set; causation was not isolated.'},
 sources:[__filename,'audit-webgpu-bridge.cjs','benchmark-villa-threading.cjs','draw-api-webgpu.cpp','benchmark-draw-bridge.cjs'].map(f=>audit(path.resolve(__dirname,f)))};
const output=path.join(__dirname,'evidence/webgpu-bridge-audit-20261103.json');
fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify({pass:true,file:path.relative(root,output),summary:report.ue.summary}));
