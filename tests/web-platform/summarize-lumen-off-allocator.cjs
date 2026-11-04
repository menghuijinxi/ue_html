'use strict';
// Hashing and evidence checks run after every measured window has ended.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const file=n=>path.join(__dirname,'results',n);
const read=n=>JSON.parse(fs.readFileSync(file(n),'utf8').replace(/^\uFEFF/,''));
const record=n=>audit(file(n)),hashes=new Map();
const valid=p=>{assert(p?.file);if(!hashes.has(p.file))hashes.set(p.file,audit(p.file).sha256);assert.equal(hashes.get(p.file),p.sha256,p.file);};
const average=xs=>xs.reduce((a,b)=>a+b,0)/xs.length;
const old='villa-native-metadata-v57',frozen='villa-lumen-off-mimalloc-v58';
const mi='villa-lumen-off-current-mimalloc-v59',dl='villa-lumen-off-current-dlmalloc-v59';
const pair=read('lumen-off-v59-allocator-pair.json');assert(pair.pass&&pair.identicalCompileObjects&&pair.objects===417);
valid(pair.source);valid(pair.mimalloc);valid(pair.dlmalloc);valid(pair.defaultAllocatorSettings);
pair.links.forEach(l=>valid(l.file));Object.values(pair.products).flat().forEach(valid);
for(const u of pair.compileObjects)for(const k of ['source','definitions','response','object'])valid(u[k]);
const builds={};
for(const [folder,kind]of [[mi,'mimalloc'],[dl,'dlmalloc']]){
 const b=read(folder+'-build.json'),c=read('v59-'+kind+'-compile-audit.json');
 assert(b.pass&&b.fullLinkVerified&&b.wasmValidated&&!b.allocationProbe&&!b.rendererRevision);
 b.sourceFiles.forEach(valid);b.products.forEach(valid);valid(b.runtimeSnapshotSource);valid(c.build);valid(c.source);valid(c.link.source);
 assert.deepEqual(c.compileCounts,{'-O2':416,'-O1':1});assert(!c.simdUnits&&!c.ltoUnits&&!c.link.optimization.length);
 builds[folder]={report:record(folder+'-build.json'),compile:record('v59-'+kind+'-compile-audit.json'),allocator:b.allocator,
  compileCounts:c.compileCounts,link:c.link,rendererRevision:b.rendererRevision,products:b.products};
}
const project=audit('G:/UE_HTML/TriplexHouseVilla/Config/DefaultEngine.ini');
assert.equal(project.sha256,'408f1f254531be628c9d285b7ca65ef17a81c90d9dac1dcfcd56f2a82b326183');
const packages={};
for(const folder of [old,frozen,mi,dl]){
 const dir=path.join(__dirname,'build',folder),config=JSON.parse(fs.readFileSync(path.join(dir,'config-files.json'),'utf8'));
 const engine=config.find(e=>e.path==='/Engine/Programs/UEWebEngine/Config/DefaultEngine.ini');assert.equal(engine.sha256,project.sha256);
 assert.deepEqual(Buffer.from(engine.data,'base64'),fs.readFileSync(project.file));
 const admission=config.find(e=>e.path==='/Engine/Platforms/Web/Config/DataDrivenPlatformInfo.ini');assert(admission);
 const admissionText=Buffer.from(admission.data,'base64').toString('utf8');
 const values=Object.fromEntries(['SP_WEBGPU_SM5','SP_WEBGPU_ES31'].map(platform=>{
  const section=admissionText.split('[ShaderPlatform '+platform+']')[1]?.split(/^\[/m)[0];
  const value=section?.match(/^bSupportsLumenGI=(true|false)$/m)?.[1];assert(value);return [platform,value==='true'];
 }));
 assert.equal(values.SP_WEBGPU_SM5,[mi,dl].includes(folder));assert.equal(values.SP_WEBGPU_ES31,false);
 packages[folder]={files:['config-files.json','content-files.json','content.bin','UEWebEngineThreads.js','UEWebEngineThreads.wasm'].map(n=>audit(path.join(dir,n))),projectConfig:engine.sha256,platformLumenAdmission:values};
 if(folder!==old){
  const p=read(folder+'-package.json');assert(p.pass);p.products.forEach(valid);valid(p.build||p.buildReport);
  if(folder!==frozen)(p.sources||p.sourceFiles).forEach(valid);
  packages[folder].report=record(folder+'-package.json');
 }
}
const cook=read('web-project-lumen-off-v59-desktop-cook-results.json');assert(cook.pass&&cook.useProjectSettings&&cook.distanceFields&&cook.exitCode===0);valid(cook.log);
const inventoryPath=path.join(__dirname,'build/web-project-lumen-off-v59-desktop-cook/20261104-120159/ShaderConversion/inventory.json');
const inventory=JSON.parse(fs.readFileSync(inventoryPath,'utf8'));
const lumenTypes=inventory.types.filter(t=>/Lumen/i.test(t.name)||/\/Lumen\//i.test(t.source));
assert(lumenTypes.length>100&&lumenTypes.every(t=>t.permutations===0));
const correctness={};
for(const [name,count]of [['lumen-off-v58-views.json',4],['lumen-off-v59-views.json',0]]){
 const v=read(name);assert(v.pass&&v.views.length===6&&!v.errors.length);if(count)assert.equal(v.windowMetrics.length,count);
 valid(v.source);v.packageFiles.forEach(valid);assert(v.metadata.native&&v.metadata.nativeLoads>100&&v.metadata.domLoads===0);
 correctness[name]={report:record(name),screenshot:record(name.replace(/json$/,'png')),metadata:v.metadata,views:v.views.length,windowMetrics:v.windowMetrics?.length||0};
}
const gameplay=read('project-gameplay-lumen-off-v59-dlmalloc-native.json');assert(gameplay.pass&&gameplay.nativeValidation&&gameplay.requireGPUScene&&gameplay.requireRenderThreads&&gameplay.requireResourceTables);
const g=gameplay.runs[0],last=g.samples.at(-1);assert(g.pass&&!g.errors.length&&g.maxTravelCm>50&&g.maxTurnDegrees>10&&last.bindings.bindingEntriesValidated>1000);
assert(last.metadata.native&&last.metadata.domLoads===0);
correctness.gameplay={report:record('project-gameplay-lumen-off-v59-dlmalloc-native.json'),travelCm:g.maxTravelCm,turnDegrees:g.maxTurnDegrees,bindings:last.bindings};
const memory=read('project-memory-lumen-off-v59-no-lumen.json');assert(memory.pass&&!memory.errors.length&&memory.samples.length===4);
const memorySummary=memory.samples.map(s=>({label:s.label,frame:s.frame,settings:s.settings,lighting:s.lighting,
 liveBytes:s.memory.totals,lumenResources:s.memory.live.filter(r=>/lumen/i.test(r.label)),wddm:s.wddm}));
const windows=[],fps={};
for(const [name,order,differentCook]of [
 ['lumen-off-v58-runtime-abba.json',[old,frozen,frozen,old],false],
 ['lumen-off-v59-runtime-abba.json',[old,mi,mi,old],true],
 ['lumen-off-v59-runtime-repeat-baab.json',[mi,old,old,mi],true],
 ['lumen-off-v59-allocator-abba.json',[dl,mi,mi,dl],false]]){
 const r=read(name);assert(r.pass&&r.performanceAccepted&&!r.allocationProbe&&!r.psoPrecache);assert.equal(r.differentCook,differentCook);
 assert.deepEqual(r.runs.map(x=>x.folder),order);valid(r.source);valid(r.capturedSource);Object.values(r.packages).forEach(p=>Object.values(p.files).forEach(valid));
 for(const x of r.runs){
  assert(!x.errors.length&&x.mode==='full'&&x.before.settings.gi===0&&x.before.settings.reflections===0&&x.before.settings.generateDistanceFields===1);
  assert(x.before.metadata.native&&x.before.metadata.domLoads===0&&x.before.threads.renderThread&&x.before.threads.rhiThread);
  assert.equal(x.before.threads.cores,4);assert.equal(x.before.threads.taskWorkers,3);
  assert(x.pageBefore.visibility==='visible'&&x.pageAfter.visibility==='visible');
  windows.push([x.measurement.timeOrigin+x.measurement.start,x.measurement.timeOrigin+x.measurement.end]);
 }
 const control=name.includes('repeat')?old:order[0],candidate=name.includes('repeat')?mi:order[1];
 const a=r.summary[control],b=r.summary[candidate];
 fps[name]={report:record(name),summary:r.summary,changeFpsPercent:(b.fps/a.fps-1)*100,changeLow1Percent:(b.frameMs.low1Fps/a.frameMs.low1Fps-1)*100,
  rhiWorkMs:Object.fromEntries([order[0],order[1]].map(f=>[f,average(r.runs.filter(x=>x.folder===f).map(x=>x.rhiWorkMs))])),
  runs:r.runs.map(x=>({folder:x.folder,fps:x.fps,frameMs:x.frameMs,rhiWorkMs:x.rhiWorkMs,workload:x.workload,settings:x.before.settings,view:x.before.view,camera:x.before.camera,threads:x.before.threads,wasmCapacityBytes:x.before.wasmCapacityBytes}))};
}
const envPaths=['lumen-off-allocator-environment.jsonl','lumen-off-allocator-repeat-environment.jsonl'].map(file);
const env=envPaths.flatMap(p=>fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse));
const measured=env.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));
assert(measured.length>=24&&measured.every(e=>!e.blockers.length));
for(const [a,b]of windows)assert(env.some(e=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));
const diagnostic=read('lumen-off-v59-pass-diagnostic.json');assert(diagnostic.pass&&diagnostic.runs.length===2);valid(diagnostic.source);valid(diagnostic.observer);
const gpuDiagnostic={report:record('lumen-off-v59-pass-diagnostic.json'),performanceAccepted:false,
 runs:diagnostic.runs.map(r=>{assert(r.pass&&!r.errors.length&&r.frames.length===3);return {folder:r.folder,
  meanPassGpuMs:average(r.summary.map(s=>s.totalPassMs)),meanComputeGpuMs:average(r.summary.map(s=>s.groups.compute.gpuMs)),
  meanComputeEncoderCpuMs:average(r.summary.map(s=>s.groups.compute.cpuMs)),dispatchCounts:r.summary.map(s=>s.groups.compute.dispatches)};})};
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),context:record('lumen-off-v58-context.json'),project,builds,allocatorPair:record('lumen-off-v59-allocator-pair.json'),
 historicalFrozenAllocatorAudit:record('lumen-off-v58-allocator-pair.json'),packages,cook:record('web-project-lumen-off-v59-desktop-cook-results.json'),
 shaderInventory:{report:audit(inventoryPath),lumenRegisteredTypes:lumenTypes.length,lumenCompiledPermutations:0,compiledTypes:inventory.compiledTypes,permutations:inventory.permutations},correctness,
 memory:{report:record('project-memory-lumen-off-v59-no-lumen.json'),samples:memorySummary,performanceAccepted:false},fps,
 gpuDiagnostic,environment:{reports:envPaths.map(audit),measuredSamples:measured.length,blockers:[],backgroundCPU:measured.flatMap(e=>e.topCPU.filter(p=>p.name!=='msedge')).reduce((m,p)=>({...m,[p.name]:Math.max(m[p.name]||0,p.cpuCores)}),{})},
 boundary:'Fixed spawn, full threading, project quality settings. ABBA wall-time FPS uses completed RHI viewport presents; low1 is 1000 / mean of slowest 1% frame intervals. Current-package comparison includes Cook, platform admission and compute TLV changes; it cannot isolate Lumen alone. The first current-package ABBA has a 84-to-71 FPS old-baseline drift and is retained, with a separate reverse-order repeat to test reproducibility. Frozen comparison retains three historical renderer compatibility files. Historical v58 object audit preceded replacement of shared intermediates and is preserved as historical evidence, not revalidated against current objects. Correctness/memory/GPU probes and all build/Cook/hash work are outside FPS windows. GPU diagnostics contain three instrumented frames per package; compute pipeline names are absent, so TLV attribution is a source-based inference, not isolated timing proof. User background apps retained; no game/build/Cook blocker observed in measured windows. WASM capacity is not live memory or RSS.'};
const output=path.join(__dirname,'evidence/lumen-off-allocator-20261104.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,fps:Object.fromEntries(Object.entries(fps).map(([k,v])=>[k,{summary:v.summary,changeFpsPercent:v.changeFpsPercent,changeLow1Percent:v.changeLow1Percent}]))},null,2));
