'use strict';
// Run after all measured windows: full content/objects hashing is deliberately separate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const file=n=>path.join(__dirname,'results',n),read=n=>JSON.parse(fs.readFileSync(file(n),'utf8').replace(/^\uFEFF/,''));
const hashes=new Map(),valid=p=>{if(!hashes.has(p.file))hashes.set(p.file,audit(p.file).sha256);assert.equal(hashes.get(p.file),p.sha256,p.file);};
const record=n=>audit(file(n)),average=a=>a.reduce((x,y)=>x+y,0)/a.length;
const build=read('villa-native-metadata-v57-build.json'),compile=read('v57-native-metadata-compile-audit.json');
assert(build.pass&&build.fullLinkVerified&&build.fullLinkAttempted&&build.wasmValidated&&build.allocator==='mimalloc'&&!build.allocationProbe&&compile.pass);
build.sourceFiles.forEach(valid);build.products.forEach(valid);
valid(compile.source);valid(compile.build);valid(compile.link.source);
for(const unit of build.objects)for(const part of ['source','definitions','response','object'])valid(unit[part]);
for(const unit of compile.objects){valid(unit.object);valid(unit.response);}
assert.deepEqual(compile.compileCounts,{'-O2':416,'-O1':1});assert.equal(compile.objects.length,417);
assert(!compile.simdUnits&&!compile.ltoUnits&&!compile.link.optimization.length&&compile.link.assertions==='1');
const packages={};
for(const name of ['villa-native-metadata-v57','villa-native-metadata-pso-v57']){
 const p=read(name+'-package.json');assert(p.pass&&p.projectQualityOverrides.length===0);valid(p.build);p.sources.forEach(valid);p.products.forEach(valid);
 assert.equal(p.products.find(x=>path.basename(x.file)==='content.bin').sha256,'bb707f08ad34fcfc2ca0da99893edf063d733a9a4ddf75efc1cd4d63c800190d');
 packages[name]={report:record(name+'-package.json'),products:p.products,psoPrecache:p.psoPrecache};
}
const probe=read('villa-native-metadata-probe-v56/metadata-probe.json');
assert(probe.pass&&probe.runtimeMetadataMatches===3852&&probe.nativeMalformedInputsRejected===13);
const views=read('villa-native-metadata-v57-views.json');assert(views.pass&&views.views.length===6&&views.windowMetrics.length===4&&!views.errors.length);
valid(views.source);views.packageFiles.forEach(valid);assert(views.metadata.nativeLoads>100&&views.metadata.domLoads===0);
const gameplay={};
for(const mode of ['reference','native-validation']){
 const name='project-gameplay-native-metadata-v57-'+mode+'.json',g=read(name);assert(g.pass&&g.validateBindingCache&&g.requireGPUScene&&g.requireResourceTables&&g.requireRenderThreads);
 assert.equal(g.sourceSha256,audit(path.join(__dirname,'probe-web-project-gameplay.cjs')).sha256);
 const r=g.runs[0],s=r.samples.at(-1);assert(r.pass&&!r.errors.length&&r.maxTravelCm>50&&r.maxTurnDegrees>10&&s.bindings.bindingEntriesValidated>1000000);
 assert(s.metadata.native&&s.metadata.nativeLoads>100);
 if(mode==='reference')assert(s.metadata.domLoads>100&&s.bindings.storageContractRejectionChecks===1200);
 else assert(s.metadata.domLoads===0&&s.bindings.storageContractRejectionChecks===0);
 gameplay[mode]={file:record(name),travelCm:r.maxTravelCm,turnDegrees:r.maxTurnDegrees,frames:s.frame,metadata:s.metadata,bindings:s.bindings};
}
const captures={},windows=[];
const stamp=(profile,name)=>{const found=profile.marks.find(x=>x.name===name);assert(found,name);return found.at;};
for(const kind of ['normal','pso']){
 const name='villa-native-metadata-v57-'+kind+'-startup.json',x=read(name);
 assert(x.pass&&x.runs.length===5&&!x.errors.length&&!x.cpuProfile&&!x.startupTrace&&!x.browserTrace&&!x.browserArgs.length);
 assert.deepEqual(x.metadataModes,['native','dom','native','native','dom']);valid(x.source);valid(x.capturedSource);x.sources.forEach(valid);x.package.forEach(valid);
 const rows=x.runs.map(r=>{
  assert(!r.errors.length&&!r.owner.errors.length&&!r.owner.dropped&&!r.page.dropped);
  const m=r.state.metadata;assert.equal(m.native,r.metadataMode==='native');assert.equal(m.domLoads===0,r.metadataMode==='native');
  if(r.index>0){assert.equal(r.state.io.downloadedBytes,0);assert.equal(r.state.io.persistentHits,2);
   windows.push([Date.parse(r.started),stamp(r.page,'recorder.frozen')]);}
  const count=m.nativeLoads+m.domLoads;
  return {index:r.index,mode:r.metadataMode,cachePreparation:r.index===0,metadata:m,loadedShaders:count,metadataMsPerShader:m.readMs/count,
   initMs:stamp(r.owner,'native.Init.end')-stamp(r.owner,'native.Init.begin'),
   preInitMs:stamp(r.owner,'native.PreInit.end')-stamp(r.owner,'native.PreInit.begin'),
   visibleTwoRAFMs:stamp(r.page,'page.visibleTwoRAF')-r.page.timeOrigin,
   firstGameFrameCompletedMs:stamp(r.owner,'gpu.firstGameFrameCompleted')-r.page.timeOrigin,
   wasmCapacityBytes:r.state.memory.wasmCapacityBytes,downloadedBytes:r.state.io.downloadedBytes,persistentHits:r.state.io.persistentHits,
   modules:r.owner.modules.length,pipelines:r.owner.pipelines.length,rejectedPipelines:r.owner.pipelines.filter(p=>p.error).length,
   settings:r.state.settings,view:r.state.view};
 });
 const summary={};
 // Keep cumulative reading time explicitly; it is not the whole-page saving.
 for(const mode of ['dom','native']){
  const rs=rows.filter(r=>r.index>0&&r.mode===mode);
  assert.equal(rs.length,2);
  summary[mode]=Object.fromEntries(['loadedShaders','metadataMsPerShader','initMs','preInitMs','visibleTwoRAFMs','firstGameFrameCompletedMs','wasmCapacityBytes'].map(k=>[k,average(rs.map(r=>r[k]))]));
  summary[mode].metadataReadMs=average(rs.map(r=>r.metadata.readMs));
 }
 captures[kind]={file:record(name),rows,summary};
}
const fpsName='villa-native-metadata-v57-fps-abba.json',fps=read(fpsName);
assert(fps.pass&&fps.performanceAccepted&&fps.runs.length===4&&!fps.allocationProbe&&!fps.psoPrecache);
valid(fps.source);valid(fps.capturedSource);Object.values(fps.packages).forEach(p=>Object.values(p.files).forEach(valid));
assert.deepEqual(fps.runs.map(r=>r.folder),['villa-rhi-hotspots-v52','villa-native-metadata-v57','villa-native-metadata-v57','villa-rhi-hotspots-v52']);
for(const r of fps.runs){assert(!r.errors.length);windows.push([r.measurement.timeOrigin+r.measurement.start,r.measurement.timeOrigin+r.measurement.end]);}
const envFile=file('villa-native-metadata-v57-environment.jsonl'),env=fs.readFileSync(envFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const measured=env.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));assert(measured.length>30&&measured.every(e=>!e.blockers.length));
for(const [a,b] of windows)assert(env.some(e=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));
const output=path.join(__dirname,'evidence/native-shader-metadata-20261104.json');
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),build:{report:record('villa-native-metadata-v57-build.json'),compile:record('v57-native-metadata-compile-audit.json'),compileCounts:compile.compileCounts,link:compile.link,sources:build.sourceFiles},packages,
 corpus:{file:record('villa-native-metadata-probe-v56/metadata-probe.json'),data:probe,buildLog:record('native-metadata-probe-only-build-v2.log'),
  artifacts:['tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderMetadataProbe.cpp',
   'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Public/WebGPUShaderRuntimeMetadata.h',
   'tests/ue-shader-host/Intermediate/Build/Win64/x64/UnrealEditor/Development/UEShaderHost/WebShaderMetadataProbe.cpp.obj',
   'tests/ue-shader-host/Intermediate/Build/Win64/x64/UnrealEditor/Development/UEShaderHost/WebShaderMetadataProbe.cpp.obj.rsp',
   'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll',
   'tests/web-platform/results/villa-shader-metadata-corpus-v28.bin'].map(audit),
  boundary:'Native NullRHI commandlet, all 3852 library entries. Object footprint model excludes allocator overhead/fragmentation and GPU memory; not browser RSS. Full native RHI build failed on pre-existing MSVC bool-conversion warnings; only the UEShaderHost module was built for this probe.'},
 correctness:{views:record('villa-native-metadata-v57-views.json'),screenshot:record('villa-native-metadata-v57-views.png'),imageAccepted:true,metadata:views.metadata,gameplay},startup:captures,
 fps:{file:record(fpsName),summary:fps.summary,runs:fps.runs.map(r=>({folder:r.folder,fps:r.fps,low1:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,threads:r.before.threads,settings:r.before.settings,view:r.before.view}))},
 environment:{file:audit(envFile),samples:measured.length,blockers:[],backgroundCPU:measured.flatMap(e=>e.topCPU.filter(p=>p.name!=='msedge')).reduce((m,p)=>({...m,[p.name]:Math.max(m[p.name]||0,p.cpuCores)}),{})},
 earlyValidationFailure:{file:record('project-gameplay-native-metadata-v55-validate.json'),includedInPerformance:false,reason:'Late validation referenced a DOM omitted by native loading. v56/v57 use fresh native validation without a DOM, and explicit startup validation retains the original DOM for the JSON oracle.'},
 boundary:'Same Cook/config and same Wasm for DOM/native startup ABBA. First run retained as cache preparation and excluded from summary. PSO variant is an explicit bulk-load diagnostic, not the default game. Owner read scope, UE Init and navigation-to-two-RAF visibility are different boundaries. WASM memory capacity is not live allocator use or process RSS. FPS measured separately without startup recorder/profiler. Background user apps retained.'};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:true,output,corpus:probe,startup:Object.fromEntries(Object.entries(captures).map(([k,v])=>[k,v.summary])),fps:fps.summary,environment:result.environment}));
