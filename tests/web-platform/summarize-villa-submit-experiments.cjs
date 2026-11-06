'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n),'utf8').replace(/^\uFEFF/,''));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function metrics(a){
  assert(a.length>100&&a.every(v=>Number.isFinite(v)&&v>0));const s=a.toSorted((a,b)=>a-b);
  return {frames:a.length,fps:1000/mean(a),low1:1000/mean(s.slice(-Math.ceil(a.length*.01))),p99:s[Math.floor(s.length*.99)],
    maximum:s.at(-1),over33:a.filter(v=>v>33.333).length,over50:a.filter(v=>v>50).length};
}
function capture(tag){
  const r=read(tag+'.json');assert(r.pass,tag);assert.deepEqual(r.errors,[]);assert(!r.presentMonEnabled);
  const runs=r.runs.map(v=>{
    assert.equal(v.before.clock.mode,'owner');assert.deepEqual(v.before.camera,v.after.camera);
    assert.deepEqual(v.before.settings,v.after.settings);assert.equal(v.before.view.width,1280);assert.equal(v.before.view.height,720);
    assert.equal(v.before.view.outputWidth,1280);assert.equal(v.before.view.outputHeight,720);assert.equal(v.before.view.antiAliasing,4);
    assert.deepEqual(v.capture.errors,[]);assert.equal(v.before.settings.gi,0);assert.equal(v.before.settings.reflections,0);
    const a=v.before,b=v.after,n=b.frame-a.frame,oc=b.occlusion.sampleFrame-a.occlusion.sampleFrame;
    const intervals=v.capture.frames.slice(1).map((f,i)=>f.at-v.capture.frames[i].at);
    const gpu=v.capture.frames.filter(f=>Number.isFinite(f.done)&&Number.isFinite(f.submit));
    return {intervals,summary:{result:metrics(intervals),rhiMs:v.rhiMs,
      workload:Object.fromEntries(['draws','dispatches','bindGroupsCreated','uniformUploads','uniformWriteCalls'].filter(k=>k in b.occlusion).map(k=>[k,(b.occlusion[k]-a.occlusion[k])/oc])),
      apiPerFrame:b.apiCounts?Object.fromEntries(Object.keys(b.apiCounts).map(k=>[k,(b.apiCounts[k]-(a.apiCounts[k]||0))/n]).filter(([k,v])=>!k.startsWith('buffer:')||v>0)):null,
      staging:b.staging||null,
      gpu:gpu.length?{peak:v.capture.pendingPeak,meanMs:mean(gpu.map(f=>f.done-f.submit)),maxMs:Math.max(...gpu.map(f=>f.done-f.submit))}:null}};
  });
  return {raw:r,intervals:runs.flatMap(v=>v.intervals),summary:{tag,files:['.json','.log','.png','-source.cjs'].map(s=>audit(path.join(root,tag+s))),
    apiCountProbe:!!r.apiCountProbe,gpuCompletionProbe:r.gpuCompletionProbe,uploadValidationProbe:!!r.uploadValidationProbe,
    runs:runs.map(v=>v.summary),tour:r.tour,readback:r.readbackTest,uploadValidation:r.uploadValidation,
    validatedBindingEntries:r.bindingValidationAfter?r.bindingValidationAfter.occlusion.bindingEntriesValidated-r.bindingValidationBefore.occlusion.bindingEntriesValidated:0}};
}
const kinds=['control','batch','present','uniform'];
const normal=Object.fromEntries(kinds.map(k=>{
  const c=capture('parity-submit-'+k+'-normal-20261106');assert(!c.raw.apiCountProbe&&!c.raw.gpuCompletionProbe);
  return [k,{aggregate:metrics(c.intervals),capture:c.summary}];
}));
const checks=Object.fromEntries(kinds.map(k=>[k,capture('parity-submit-'+k+'-check-20261106').summary]));
function aggregate(tags){
  const captures=tags.map(capture),runs=captures.flatMap(c=>c.raw.runs);
  for(const c of captures){assert(!c.raw.apiCountProbe&&!c.raw.gpuCompletionProbe&&!c.raw.uploadValidationProbe);}
  for(const r of runs){assert.deepEqual(r.before.camera,runs[0].before.camera);assert.deepEqual(r.before.settings,runs[0].before.settings);}
  return {aggregate:metrics(captures.flatMap(c=>c.intervals)),captures:captures.map(c=>c.summary)};
}
const upload={
  pages:aggregate(['parity-upload-pages-normal-1-20261106','parity-upload-pages-normal-2-20261106']),
  batch:aggregate(['parity-upload-batch-normal-20261106']),
  check:capture('parity-upload-batch-check-20261106').summary
};
assert.equal(upload.check.uploadValidation.completed,1024);assert.deepEqual(upload.check.uploadValidation.errors,[]);
assert(upload.check.uploadValidation.nonzeroOffsets>0);
const guardCheck=capture('parity-upload-guard-check-20261106').summary;
assert.equal(guardCheck.uploadValidation.completed,1024);assert.deepEqual(guardCheck.uploadValidation.errors,[]);
for(const c of [...Object.values(checks),upload.check,guardCheck]){
  assert.equal(c.readback.pass,true);assert.equal(c.tour.length,5);
  for(const v of c.tour){
    assert.deepEqual(v.camera,checks.control.tour.find(t=>t.name===v.name).camera);
    assert.equal(v.view.width,1280);assert.equal(v.view.height,720);
  }
}
function packageInfo(folder){
  const base=path.join(__dirname,'build',folder),manifest=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [name,v] of Object.entries(manifest))assert.equal(audit(path.join(base,name)).sha256,v.sha256);
  return {folder,manifest:audit(path.join(base,'asset-versions.json')),products:manifest};
}
const packages=kinds.map(k=>packageInfo('villa-submit-'+k+'-20261106'));
const uploadPackages=['pages','batch'].map(k=>packageInfo('villa-upload-'+k+'-20261106'));
for(const group of [packages,uploadPackages])for(const p of group)for(const n of ['UEWebEngineThreads.wasm','UEWebEngineThreads.js','content.bin','content-files.json'])
  assert.equal(p.products[n].sha256,group[0].products[n].sha256);
function native(nativeTag){
const launch=read(nativeTag+'-launch.json'),complete=read(nativeTag+'-complete.json');
const lines=fs.readFileSync(path.join(root,nativeTag+'.csv'),'utf8').trim().split(/\r?\n/),header=lines[0].split(',');
const phase=launch.phases[0],rows=lines.slice(phase.start+1,phase.end+1).map(l=>l.split(','));
const column=k=>{const i=header.indexOf(k);assert(i>=0);return rows.map(r=>Number(r[i]));};
const nativeLog=fs.readFileSync(path.join(root,nativeTag+'.log'),'utf8');
for(const cvar of ['t.MaxFPS','r.VSync','r.FinishCurrentFrame'])assert(nativeLog.includes(cvar+' = "0"'));
assert(nativeLog.includes('r.Shadow.CSMCaching = "1"'));
return {tag:nativeTag,stats:metrics(column('FrameTime')),arguments:launch.arguments,
  shaderPlatform:nativeLog.match(/Metadata set : shaderplatform="([^"]+)"/)?.[1],
  workload:Object.fromEntries(['RHI/DrawCalls','RHIThreadTime','GPUTime','DrawCall/ShadowDepths'].map(k=>[k,mean(column(k))])),
  exitCode:complete.exitCode,cleanExit:complete.cleanExit,
  raw:['.csv','.log','.png','-launch.json','-complete.json'].map(s=>audit(path.join(root,nativeTag+s)))};
}
const desktop=native('parity-native-submit-sm5-repeat-20261106');assert.equal(desktop.shaderPlatform,'PCD3D_SM5');
const desktopSM6=native('parity-native-submit-repeat-20261106');assert.equal(desktopSM6.shaderPlatform,'PCD3D_SM6');
const output={date:new Date().toISOString(),pass:true,performanceAccepted:false,physicalPresentationValidated:false,
  lowDefinition:'1000 / mean of slowest ceil(N*0.01) raw RHI intervals; no long frames removed; no cross-window gaps.',
  controls:{resolution:[1280,720],clock:'owner',rhiWake:'priority',fpsCap:0,vsync:0,csm:1,gpuAhead:0,computeReuse:0,rdgMerge:0,replayScratch:0},
  normal,checks,upload,desktop,desktopSM6,packages,uploadPackages,
  guard:{check:guardCheck,package:packageInfo('villa-upload-guard-check-20261106'),
    boundary:'Final build adds a flush when switching batching off. Correctness was rerun; earlier static timing used fixed startup settings and is not relabeled as timing of this final build. Hot toggling has code review coverage, not an automated live-toggle test.'},
  builds:['villa-submit-runtime-20261106-build.json','villa-upload-batch-runtime-20261106-build.json','villa-upload-guard-runtime-20261106-build.json'].map(n=>audit(path.join(root,n))),
  visual:{...read('parity-submit-tour-comparison-20261106.json'),
    files:['parity-submit-tour-comparison-20261106.json','parity-submit-tour-comparison-20261106.jpg','parity-submit-visual-20261106.py'].map(n=>audit(path.join(root,n)))},
  testPage:{source:audit(path.join(__dirname,'villa-parity-test.html')),
    validation:audit(path.join(root,'parity-submit-test-page-20261106.json')),screenshot:audit(path.join(root,'parity-submit-test-page-20261106.png'))},
  initialApiDiagnostic:capture('parity-submit-counts-20261106').summary,
  limitations:['API wrappers and GPU completion probes only in separate diagnostic windows.',
    'RHI throughput and GPU callback latency do not verify physical presentation.',
    'First three candidates were measured sequentially, without an interleaved end control. Tiny gains may be run drift.',
    'Control and batch API diagnostics recorded first stacks for each size; later captures bound stacks per usage. GPU callback latency in those diagnostic runs is not a fair performance comparison.',
    'Native exit 777003, when present, is the known post-CSV/log-close failure and not a clean lifecycle pass.',
    'All candidate switches remain opt-in until stable tail latency and moving-scene behavior are established.']};
const out=path.join(__dirname,'evidence/villa-submit-experiments-20261106.json');fs.writeFileSync(out,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({output:out,normal:Object.fromEntries(kinds.map(k=>[k,normal[k].aggregate])),upload:{pages:upload.pages.aggregate,batch:upload.batch.aggregate},desktop:desktop.stats}));
