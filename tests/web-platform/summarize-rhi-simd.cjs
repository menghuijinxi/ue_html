'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const directory=path.join(__dirname,'results'),read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8').replace(/^\uFEFF/,''));
const valid=x=>{assert.equal(audit(x.file).sha256,x.sha256,x.file);return x;};
const median=values=>[...values].sort((a,b)=>a-b)[values.length>>1];
const raw=read('rhi-isolation-final.json');assert(raw.pass&&raw.rounds===3&&raw.runs.length===15);raw.sources.forEach(valid);raw.products.forEach(valid);
const standalone={};
for(const kind of ['dx12','dawn','scalar','simd','js']){
 const runs=raw.runs.filter(x=>x.kind===kind);assert.equal(runs.length,3);const model=runs[0];
 const group=(items,key,value)=>items.map(item=>({...key(item),medianMs:median(runs.map(run=>value(run,item)))}));
 standalone[kind]={
  preparation:kind==='js'?null:group(model.cpu,x=>({mode:x.mode,workers:x.workers,draws:x.draws,entries:x.entries}),
   (run,item)=>run.cpu.find(x=>x.mode===item.mode&&x.workers===item.workers).wall.medianMs),
  rendering:(model.render||model.cases).map(item=>({mode:item.mode,encodingMedianMs:median(runs.map(run=>(run.render||run.cases).find(x=>x.mode===item.mode).encode.medianMs)),
   wallMsPerFrameMedian:median(runs.map(run=>(run.render||run.cases).find(x=>x.mode===item.mode).wallMsPerFrame))})),
  stateTracking:kind==='js'?null:group(model.stateTracking,x=>({cached:x.cached,bindingCalls:x.bindingCalls}),
   (run,item)=>run.stateTracking.find(x=>x.cached===item.cached).encoding.medianMs),
  descriptors:group(model.descriptorCreation,x=>({entries:x.entries,groups:x.groups}),
   (run,item)=>{const x=run.descriptorCreation.find(x=>x.entries===item.entries);return (x.create||x.copyIntoPreallocatedHeap).medianMs;}),
  parallelRecording:kind==='dx12'?group(model.parallelRecording,x=>({workers:x.workers,commandLists:x.commandLists,draws:x.draws}),
   (run,item)=>run.parallelRecording.find(x=>x.workers===item.workers).record.medianMs):null};
}
const ab=read('villa-simd-v41-abba.json');assert(ab.pass&&ab.runs.length===4);valid(ab.source);for(const p of Object.values(ab.packages))Object.values(p.files).forEach(valid);
const views=read('villa-simd-v41-views.json');assert(views.pass&&views.views.length===6&&views.errors.length===0);
views.packageFiles.forEach(valid);
const namedViews=read('villa-o2-keep-names-v42-views.json');assert(namedViews.pass&&namedViews.views.length===6&&namedViews.errors.length===0);namedViews.packageFiles.forEach(valid);
const compile=read('v41-simd-compile-audit.json');assert(compile.pass&&compile.simdUnits===417&&compile.ltoUnits===0&&compile.link.optimization.length===0);
const metrics=fs.readFileSync(path.join(directory,'v41-simd-wasm-metrics.txt'),'utf8'),scalarMetrics=fs.readFileSync(path.join(directory,'v38-scalar-wasm-metrics.txt'),'utf8');assert(/SIMDLoad\s+:/.test(metrics)&&!scalarMetrics.includes('SIMD'));
const diagnosis=read('final-link-render-diagnosis-v3.json');assert(diagnosis.pass);const shaderCounts=[];
for(const run of diagnosis.runs)for(const c of run.cases){
 const frames=c.endFrame-c.startFrame;let shadows=0;const df=[];
 for(const [key,count]of Object.entries(c.draw)){const p=JSON.parse(key);if(c.shaders[p.key]?.markers.some(m=>m.startsWith('ShadowDepthPass')))shadows+=count;}
 for(const [key,count]of Object.entries(c.compute)){const p=JSON.parse(key);if(c.shaders[p.key]?.distanceField)df.push({key:p.key,perFrame:count/frames});}
 shaderCounts.push({folder:run.folder,mode:c.name,frames,drawsPerFrame:Object.values(c.draw).reduce((s,v)=>s+v,0)/frames,shadowDepthDrawsPerFrame:shadows/frames,dfDispatch:df,fields:c.diagnostics.fields});
}
const envFile=path.join(directory,'rhi-simd-final-environment.jsonl'),environment=fs.readFileSync(envFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const windows=[...raw.runs.map(r=>[Date.parse(r.started),Date.parse(r.ended)]),...ab.runs.map(r=>[r.measurement.timeOrigin+r.measurement.start,r.measurement.timeOrigin+r.measurement.end])];
const measured=environment.filter(e=>windows.some(([a,b])=>Date.parse(e.utc)>=a&&Date.parse(e.utc)<=b));assert(measured.length>20&&measured.every(e=>e.blockers.length===0));
const restored=read('rhi-simd-default-restored-compile-audit.json'),baseline=read('v38-compile-optimization-audit.json');
assert(restored.pass&&restored.objects.length===417&&restored.simdUnits===0&&restored.ltoUnits===0&&restored.link.optimization.length===0);
for(const p of restored.products.filter(x=>/\.(js|wasm)$/.test(x.file))){valid(p);assert.equal(p.sha256,baseline.products.find(x=>path.basename(x.file)===path.basename(p.file)).sha256);}
for(const unit of restored.objects){const old=baseline.objects.find(x=>x.source===unit.source);assert(old);assert.equal(unit.object.sha256,old.object.sha256);assert.equal(unit.response.sha256,old.response.sha256);}
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),standalone:{file:audit(path.join(directory,'rhi-isolation-final.json')),rounds:3,summary:standalone,validation:audit(path.join(directory,'rhi-isolation-validation-final.json')),validationLog:audit(path.join(directory,'rhi-isolation-validation-final.log'))},
 simd:{comparison:audit(path.join(directory,'villa-simd-v41-abba.json')),summary:ab.summary,runs:ab.runs.map(x=>({folder:x.folder,fps:x.fps,low1:x.frameMs.low1Fps,rhiWorkMs:x.rhiWorkMs,workload:x.workload})),compile:audit(path.join(directory,'v41-simd-compile-audit.json')),metrics:audit(path.join(directory,'v41-simd-wasm-metrics.txt')),scalarMetrics:audit(path.join(directory,'v38-scalar-wasm-metrics.txt')),views:audit(path.join(directory,'villa-simd-v41-views.json')),screenshot:audit(path.join(directory,'villa-simd-v41-views.png'))},
 finalLinkDiagnosis:{file:audit(path.join(directory,'final-link-render-diagnosis-v3.json')),shaderCounts,shadowCache:audit(path.join(directory,'final-link-shadow-cache-v1.json')),keepNamesViews:audit(path.join(directory,'villa-o2-keep-names-v42-views.json')),
  compile:audit(path.join(directory,'v42-o2-keep-names-compile-audit.json')),dwarfStrip:audit(path.join(directory,'web-engine-full-thread-20261103-173433.log.strip-dwarf.json')),stripIdempotence:audit(path.join(directory,'v42-dwarf-idempotent.json')),
  imageAccepted:false,performanceAccepted:false,routeAbandoned:false,manualReview:'Disabling whole-scene shadow caching restores shadow draw counts but not correct brightness. O2 with names preserved is still too bright. DF dispatch is present; DF inputs/output correctness remains unresolved.'},
 restoredDefault:{compile:audit(path.join(directory,'rhi-simd-default-restored-compile-audit.json')),products:restored.products,objectsEqualBaseline:417,jsWasmEqualV38:true},
 tools:['strip-wasm-dwarf.cjs','diagnose-final-link-rendering.cjs'].map(n=>audit(path.join(__dirname,n))),
 simdTarget:audit(path.join(__dirname,'../ue-web-smoke/Source/UEWebEngineThreadsSIMD.Target.cs')),
 environment:{file:audit(envFile),measurementSamples:measured.length,blockersDuringMeasurements:[],boundary:'User applications retained. No proof of exclusive CPU/GPU ownership. See raw environment for background activity.'},
 boundary:'Synthetic preparation is not the linked UE CreateGroups/SetDrawBindings implementation. Lock stress is not proof of actual UE lock contention. CPU sums do not include all browser backend work; API/object semantics and native/Web parallel capabilities differ. No standalone time is subtracted from the UE frame.'};
const output=path.join(__dirname,'evidence/rhi-simd-isolation-20261103.json');fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:true,output,standalone,simd:ab.summary}));
