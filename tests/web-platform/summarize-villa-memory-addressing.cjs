'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs'),{auditMemory}=require('./audit-wasm-memory.cjs');
const root=path.join(__dirname,'results');
const read=n=>JSON.parse(fs.readFileSync(path.join(root,n+'.json'),'utf8').replace(/^\uFEFF/,''));
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function metrics(a){
  assert(a.length>100&&a.every(v=>Number.isFinite(v)&&v>0));
  const s=a.toSorted((a,b)=>a-b);
  return {frames:a.length,fps:1000/mean(a),low1:1000/mean(s.slice(-Math.ceil(s.length*.01))),
    p50:s[Math.floor(s.length*.5)],p95:s[Math.floor(s.length*.95)],p99:s[Math.floor(s.length*.99)],
    maximum:s.at(-1),over33:a.filter(v=>v>33.333).length,over50:a.filter(v=>v>50).length};
}
function capture(tag){
  const j=read(tag);assert(j.pass,tag);assert.deepEqual(j.errors,[]);assert(!j.presentMonEnabled);
  const windows=j.runs.map(r=>{
    assert.equal(r.before.clock.mode,'owner');assert.deepEqual(r.before.camera,r.after.camera);
    assert.deepEqual(r.before.settings,r.after.settings);assert.deepEqual(r.capture.errors,[]);
    for(const k of ['width','height','outputWidth','outputHeight'])assert.equal(r.before.view[k],k.toLowerCase().includes('width')?1280:720);
    const intervals=r.capture.frames.slice(1).map((f,i)=>f.at-r.capture.frames[i].at);
    const completed=r.capture.frames.filter(f=>Number.isFinite(f.done)&&Number.isFinite(f.submit));
    return {intervals,result:metrics(intervals),rhiMs:r.rhiMs,workload:r.workload,
      gpu:completed.length?{completed:completed.length,records:r.capture.frames.length,
        pendingPeak:r.capture.pendingPeak,meanCallbackMs:mean(completed.map(f=>f.done-f.submit)),
        maxCallbackMs:Math.max(...completed.map(f=>f.done-f.submit))}:null};
  });
  const b=j.bindingValidationBefore?.occlusion,a=j.bindingValidationAfter?.occlusion;
  return {raw:j,windows,summary:{tag,raw:audit(path.join(root,tag+'.json')),source:j.source,
    windows:windows.map(({intervals,...w})=>w),gpuCompletionProbe:j.gpuCompletionProbe,apiCountProbe:j.apiCountProbe,
    bindingEntries:b?a.bindingEntriesValidated-b.bindingEntriesValidated:0,
    bindingGroups:b?a.groupPreparationValidated-b.groupPreparationValidated:0,tour:j.tour,readback:j.readbackTest}};
}
function normal(bits,infix='compute-'){
  const captures=[1,2].map(i=>capture(`parity-address${bits}-${infix}normal-${i}-20261106`));
  for(const c of captures){
    assert(!c.raw.gpuCompletionProbe&&!c.raw.apiCountProbe&&!c.raw.uploadValidationProbe);
    for(const r of c.raw.runs){
      assert.equal(r.before.occlusion.reuseComputePass,!!infix);
      assert.equal(r.before.occlusion.groupAccessRevalidation,0);
      assert.equal(r.before.occlusion.dynamicGlobalsGroupReuse,false);
    }
  }
  return {aggregate:metrics(captures.flatMap(c=>c.windows.flatMap(w=>w.intervals))),
    rhiMs:mean(captures.flatMap(c=>c.windows.map(w=>w.rhiMs))),captures:captures.map(c=>c.summary)};
}
function route(bits,suffix=''){
  const tag=`parity-address${bits}-compute-route${suffix}-20261106`,j=read(tag);assert(j.pass,tag);
  const run=j.runs[0];assert.equal(run.mode,'owner');assert.deepEqual(run.errors,[]);
  for(const p of run.phases)if(p.name!=='first-area')assert.deepEqual(p.summary.creations,{});
  return {tag,raw:audit(path.join(root,tag+'.json')),source:j.source,phases:run.phases.map(p=>({name:p.name,intervals:p.summary.intervals,
    result:metrics(p.summary.intervals),camera:p.after.camera,driver:p.driver,settings:p.before.settings,
    view:p.before.view,creations:p.summary.creations,steadyAccepted:p.steadyAccepted}))};
}
function packageInfo(bits){
  const folder=`villa-address${bits}-compute-20261106`,base=path.join(__dirname,'build',folder);
  const products=JSON.parse(fs.readFileSync(path.join(base,'asset-versions.json')));
  for(const [file,v] of Object.entries(products))assert.equal(audit(path.join(base,file)).sha256,v.sha256);
  return {folder,products,memory:auditMemory(path.join(base,'UEWebEngineThreads.wasm'))};
}
const packages={control:packageInfo(64),candidate:packageInfo(32)};
const differentFiles=Object.keys(packages.control.products).filter(k=>packages.control.products[k].sha256!==packages.candidate.products[k]?.sha256);
assert.deepEqual(differentFiles.sort(),['UEWebEngineThreads.js','UEWebEngineThreads.wasm','index.html']);
for(const [name,bits] of [['control',64],['candidate',32]]){
  const p=packages[name];assert.equal(p.memory.memories.length,1);
  assert.equal(p.memory.memories[0].addressBits,bits);assert(p.memory.memories[0].shared);
  assert.equal(p.memory.memories[0].maximumBytes,2147483648);assert.equal(p.memory.tables[0].addressBits,bits);
}
const buildNames=['villa-dynamic-globals-runtime-20261106-build','villa-address32-runtime-20261106-build'],builds=buildNames.map(read);
assert(builds.every(b=>b.pass));assert.equal(builds[0].objects.length,builds[1].objects.length);
for(const a of builds[0].objects){
  const b=builds[1].objects.find(b=>b.object.file===a.object.file);assert(b);
  for(const key of ['object','response','source','definitions'])assert.equal(a[key]?.sha256,b[key]?.sha256,key+': '+a.object.file);
}
const staticRuns={control:normal(64),candidate:normal(32)};
const staticReference=read('parity-address64-compute-normal-1-20261106').runs[0].before;
for(const bits of [64,32])for(const suffix of ['normal-1','normal-2','postcleanup']){
  const j=read(`parity-address${bits}-compute-${suffix}-20261106`);
  for(const r of j.runs){
    assert.deepEqual(r.before.settings,staticReference.settings);assert.deepEqual(r.before.camera,staticReference.camera);
    assert.equal(r.before.occlusion.reuseComputePass,true);assert.equal(r.before.staging.enabled,false);
    assert.equal(r.before.occlusion.groupAccessRevalidation,0);assert.equal(r.before.occlusion.dynamicGlobalsGroupReuse,false);
  }
}
const routes={};
for(const [name,bits] of [['control',64],['candidate',32]]){
  const runs=['','-repeat'].map(s=>route(bits,s));
  routes[name]={aggregate:Object.fromEntries(runs[0].phases.map(p=>[p.name,
    metrics(runs.flatMap(r=>r.phases.find(q=>q.name===p.name).intervals))])),
    runs:runs.map(r=>({...r,phases:r.phases.map(({intervals,...p})=>p)}))};
}
for(const r of [...routes.control.runs,...routes.candidate.runs])for(const p of r.phases){
  const q=routes.control.runs[0].phases.find(q=>q.name===p.name);assert.deepEqual(p.settings,q.settings);
  for(const k of ['x','y','z','pitch','yaw'])assert(Math.abs(p.camera[k]-q.camera[k])<.1,'Route endpoint differs');
}
const postCleanup={},allStatic={};
for(const [name,bits] of [['control',64],['candidate',32]]){
  const c=capture(`parity-address${bits}-compute-postcleanup-20261106`);assert(!c.raw.gpuCompletionProbe&&!c.raw.apiCountProbe);
  postCleanup[name]=c.summary;
  const captures=[1,2].map(i=>capture(`parity-address${bits}-compute-normal-${i}-20261106`));
  allStatic[name]=metrics([...captures,c].flatMap(c=>c.windows.flatMap(w=>w.intervals)));
}
const checks={control:capture('parity-address64-compute-gpu-20261106').summary,candidate:capture('parity-address32-compute-gpu-20261106').summary};
for(const c of Object.values(checks)){
  assert(c.gpuCompletionProbe&&!c.apiCountProbe);assert.equal(c.tour.length,5);assert(c.readback.pass);assert(c.bindingEntries>100000);
}
for(const p of checks.control.tour)assert.deepEqual(p.camera,checks.candidate.tour.find(q=>q.name===p.name).camera);
const correctness=read('parity-address32-compute-window-20261106');assert(correctness.pass);assert.equal(correctness.clock.mode,'owner');assert.equal(correctness.windowMetrics.length,4);
const input={};
for(const bits of [64,32]){
  const tag=`parity-address${bits}-compute-input-retry-20261106`,j=read(tag);assert(j.pass,tag);
  input[bits]={tag,raw:audit(path.join(root,tag+'.json')),boundary:j.boundary,runs:j.runs.map(r=>({
    result:r.result,travel:r.travel,turn:r.turn,workload:r.workload,gpu:r.gpuSummary,display:r.display,
    beforeCamera:r.before.camera,afterCamera:r.after.camera,clock:r.before.clock,rhiMs:r.rhiMs}))};
}
function native(tag){
  const launch=read(tag+'-launch'),complete=read(tag+'-complete');
  const lines=fs.readFileSync(path.join(root,tag+'.csv'),'utf8').trim().split(/\r?\n/),header=lines[0].split(',');
  const phase=launch.phases[0],rows=lines.slice(phase.start+1,phase.end+1).map(l=>l.split(','));assert.equal(rows.length,9000);
  const column=k=>{const i=header.indexOf(k);assert(i>=0,k);return rows.map(r=>Number(r[i]));};
  const log=fs.readFileSync(path.join(root,tag+'.log'),'utf8');assert(log.includes('shaderplatform="PCD3D_SM5"'));
  for(const k of ['t.MaxFPS','r.VSync','r.FinishCurrentFrame'])assert(log.includes(k+' = "0"'));
  assert(log.includes('r.Shadow.CSMCaching = "1"'));
  return {tag,stats:metrics(column('FrameTime')),arguments:launch.arguments,exeSha256:launch.exeSha256,
    workload:Object.fromEntries(['RHI/DrawCalls','RHIThreadTime','GPUTime'].map(k=>[k,mean(column(k))])),
    exitCode:complete.exitCode,cleanExit:complete.cleanExit,raw:['.csv','.log','-launch.json','-complete.json'].map(s=>audit(path.join(root,tag+s)))};
}
const restored=read('villa-addressing-final-default-20261106-build');assert(restored.pass);
for(let i=0;i<2;i++)assert.equal(restored.products[i].sha256,builds[0].products[i].sha256);
const result={date:new Date().toISOString(),pass:true,performanceAccepted:false,physicalPresentationValidated:false,nativeParityReached:false,
  lowDefinition:'1000 / mean of slowest ceil(N*0.01) raw RHI intervals; every long frame retained; no cross-window gaps.',
  verdict:'Repeatable throughput and fixed-route 1% low improvements. Static tails and free-input smoothness are not consistently improved. Opt-in candidate; no default promotion or native parity claim.',
  controls:{resolution:[1280,720],clock:'owner',rhiWake:'priority',fpsCap:0,vsync:0,gpuAhead:0,csm:1,computeReuse:1,newBindingExperiments:0},
  buildAudit:{objects:builds[0].objects.length,allObjectAndCompileInputsIdentical:true,differentFiles,
    reports:buildNames.map(n=>audit(path.join(root,n+'.json')))},
  packages,staticRuns,postCleanup,allStatic,routes,checks,input,correctness:{raw:audit(path.join(root,'parity-address32-compute-window-20261106.json')),windowMetrics:correctness.windowMetrics},
  initialAddressOnly:{control:normal(64,''),candidate:normal(32,'')},
  screening:{accessGroups:capture('parity-group-access-all-check-20261106').summary,
    dynamicGlobals:capture('parity-dynamic-globals-check-20261106').summary,memory32:capture('parity-address32-check-20261106').summary,
    memory32O2:{...capture('parity-address32-o2-check-20261106').summary,visuallyRejected:true,
      reason:'Large lighting/shadow differences and roughly halved draw count; false performance gain.',
      image:audit(path.join(root,'parity-address32-o2-visual-20261106.jpg'))},
    fixed2GiB:{...capture('parity-address32-fixed-check-20261106').summary,accepted:false},
    failedO2DebugBuild:audit(path.join(root,'villa-address32-o2-runtime-20261106-build.json'))},
  profiling:{raw:audit(path.join(root,'parity-hotpath-costs-20261106.json')),threads:read('parity-hotpath-costs-20261106').threads},
  desktop:native('parity-native-memory-sm5-repeat-20261106'),
  desktopEarlierWindow:{...native('parity-native-memory-sm5-20261106'),
    boundary:'Retained intact: seven >50 ms frames, maximum 669 ms. Cause not established. No parity claim from the depressed low statistic.'},
  defaultRestored:{byteIdentical:true,report:audit(path.join(root,'villa-addressing-final-default-20261106-build.json'))},
  storage:{failedInput:audit(path.join(root,'parity-address64-compute-input-20261106.json')),
    recovery:audit(path.join(root,'parity-addressing-profile-archive-20261106.json')),
    finalArchive:audit(path.join(root,'parity-addressing-final-profile-archive-20261106.json'))},
  visuals:{metrics:audit(path.join(root,'parity-memory-visual-20261106.json')),contact:audit(path.join(root,'parity-memory-visual-20261106.jpg')),
    staticFrames:audit(path.join(root,'parity-memory-frame-times-20261106.png'))},
  testPage:{source:audit(path.join(__dirname,'villa-parity-test.html')),validation:audit(path.join(root,'parity-memory-test-page-20261106.json'))},
  limitations:['Initial address-only ABBA includes substantial common drift; individual windows retained, no outlier removal.',
    'Submission FPS and completion callbacks do not establish physically displayed new frames or human smoothness.',
    'The C++ pointer ABI remains wasm64. This experiment lowers linear-memory and table addresses to 32 bits.',
    'Both tested binaries retain their existing 2 GiB maximum; this does not validate applications needing more than 4 GiB.',
    'Static low improves in the post-storage-cleanup pair but regresses in the preceding ABBA. More >33 ms and >50 ms static frames remain in the candidate.',
    'Free-input routes differ in distance and workload; candidate low is lower, completion callback peak 5 versus 4. These runs do not establish smoother gameplay.',
    'Native exit 777003 is the known failure after CSV completion and log close; it is not a clean lifecycle pass.',
    'MEMORY64=2 is supported by the pinned SDK but under upstream deprecation review; future SDK upgrades need renewed checks.']};
const output=path.join(__dirname,'evidence/villa-memory-addressing-20261106.json');
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({output,staticRuns:Object.fromEntries(Object.entries(staticRuns).map(([k,v])=>[k,v.aggregate])),
  routes:Object.fromEntries(Object.entries(routes).map(([k,v])=>[k,v.aggregate])),desktop:result.desktop.stats}));
