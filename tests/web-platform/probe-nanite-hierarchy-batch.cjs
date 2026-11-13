'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder'),tag=option('tag'),villa=process.argv.includes('--villa'),scalar=process.argv.includes('--scalar-visibility');
const occlusion=process.argv.includes('--occlusion-batch'),pack=process.argv.includes('--pack-batch'),micro=process.argv.includes('--micro-batch');
assert([occlusion,pack,micro].filter(Boolean).length<=1);
const batchRPC=micro?'WebNaniteMicroBatchTest':pack?'WebNanitePackBatchTest':occlusion?'WebNaniteOcclusionBatchTest':'WebNaniteHierarchyBatchTest';
const materialPrecache=option('material-precache');assert(materialPrecache===undefined||['0','1'].includes(materialPrecache));
assert([folder,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);
const log=fs.createWriteStream(path.join(output,'engine.log'));
fs.copyFileSync(__filename,path.join(output,'source.cjs'));
const report={pass:false,villa,scalar,occlusion,pack,micro,materialPrecache,source:audit(__filename),package:audit(path.join(__dirname,'build',folder,'package.json')),tests:[],comparisons:[],errors:[],
 boundary:'Correctness only: frozen visual clock and fixed temporal index. Same runtime/Cook, native hierarchy batch switch 0/1/0. Compare sorted per-instance cluster keys, all hierarchy counters, depth and material channels. Not FPS evidence.'};
if(occlusion)report.boundary='Correctness only: frozen visual clock and fixed temporal index. Same runtime/Cook, hierarchy batching enabled, native occlusion batch switch 0/1/0. Compare both main/final per-instance key sets and counters, unchanged hierarchy selection, depth and material channels. Not FPS evidence.';
if(pack)report.boundary='Correctness only: frozen visual clock and temporal sequence. Same runtime/Cook, hierarchy/HZB/material precache enabled, native packing batch switch 0/1/0. Compare per-instance packed 12-byte records, both HZB key sets/counters, hierarchy, exact depth and material channels. Not FPS evidence.';
if(micro)report.boundary='Correctness only: frozen visual clock and temporal sequence. Same runtime/Cook, native micro batch switch 0/1/0. Compare per-instance records, hierarchy/HZB, exact depth and material channels. Read back actual indirect arguments and verify fewer raster dispatches and no increase in cluster workgroups. Not FPS evidence.';
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
function observe(scalar){
 const request=GPUAdapter.prototype.requestDevice;globalThis.__batchGPU={errors:[]};
 GPUAdapter.prototype.requestDevice=async function(d){
  if(scalar)d={...d,requiredFeatures:[...(d.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);__batchGPU.features=[...device.features];
  device.addEventListener('uncapturederror',e=>__batchGPU.errors.push(e.error.message));return device;
 };
}
function hierarchy(t){
 assert.equal(t.hierarchySnapshotFrame,t.frame);assert.equal(t.hierarchyStates.length,t.entries*4);
 const rows=new Map();let base=0;
 for(let i=0;i<t.entries;i++){
  const capacity=t.hierarchyCapacities[i],state=t.hierarchyStates.slice(i*4,i*4+4);
  assert.equal(state[1],0);assert(state[0]<=capacity);
  const keys=t.hierarchyKeys.slice(base,base+state[0]).sort((a,b)=>a-b);base+=capacity;
  assert.equal(new Set(keys).size,keys.length);
  assert(!rows.has(t.entryInstanceIDs[i]));rows.set(t.entryInstanceIDs[i],{state,keys});
 }
 assert.equal(base,t.hierarchyKeys.length);return [...rows].sort((a,b)=>a[0]-b[0]);
}
function occlusionRows(t,prefix){
 assert.equal(t[prefix+'Frame'],t.frame);assert.equal(t[prefix+'States'].length,t.entries*4);
 const rows=new Map();let base=0;
 for(let i=0;i<t.entries;i++){
  const capacity=t.hierarchyCapacities[i],state=t[prefix+'States'].slice(i*4,i*4+4);
  assert.equal(state[1],0);assert(state[0]<=capacity);
  const keys=t[prefix+'Keys'].slice(base,base+state[0]).sort((a,b)=>a-b);base+=capacity;
  assert.equal(new Set(keys).size,keys.length);rows.set(t.entryInstanceIDs[i],{state,keys});
 }
 assert.equal(base,t[prefix+'Keys'].length);return [...rows].sort((a,b)=>a[0]-b[0]);
}
function compare(before,after){
 assert.deepEqual(after.view,before.view);assert.equal(after.registered,before.registered);
 assert.deepEqual(hierarchy(after),hierarchy(before),'Hierarchy selection, LOD and error counters must match per instance');
 if(occlusion||pack||micro)for(const prefix of ['mainOcclusion','finalOcclusion'])assert.deepEqual(occlusionRows(after,prefix),occlusionRows(before,prefix),prefix+' per-instance keys and counters');
 if(pack||micro)assert.deepEqual(packedRows(after),packedRows(before),'Packed 12-byte records per instance');
 if(micro){
  const batched=after.microBatch?after:before,original=after.microBatch?before:after;
  assert.equal(original.microDispatchArguments.length,0);assert.equal(original.microBatchedEntries,0);
  if(batched.microBatchedEntries){assert(batched.microDispatchBuffers<original.microDispatchBuffers);
   const groups=batched.microDirectGroups+batched.microDispatchArguments.filter((_,i)=>i%3===0).reduce((a,b)=>a+b,0);
   assert(groups<=original.microDirectGroups,'Indirect work must not exceed original capacity workgroups');
  }
 }
 assert.equal(after.pixels.length,before.pixels.length);let covered=0,maxSpecularDifference=0;
 for(let p=0;p<after.pixels.length;p+=28){
  assert.equal(after.pixels[p+2],before.pixels[p+2],`Scene depth at ${p/28}`);
  const owns=!!after.pixels[p]&&after.pixels[p+1]===after.pixels[p+2];
  assert.equal(owns,!!before.pixels[p]&&before.pixels[p+1]===before.pixels[p+2]);
  if(!owns)continue;covered++;assert.equal(after.pixels[p+1],before.pixels[p+1]);
  for(let j=8;j<28;j++){
   if(j===13){const d=Math.abs(float(after.pixels[p+j])-float(before.pixels[p+j]));assert(d<=1/255+1e-7);maxSpecularDifference=Math.max(maxSpecularDifference,d);}
   else assert.equal(after.pixels[p+j],before.pixels[p+j],`Material channel ${j} pixel ${p/28}`);
  }
 }
 assert(covered>20);return {covered,entries:after.entries,maxSpecularDifference};
}
function packedRows(t){
 const rows=new Map();let base=0;
 for(let i=0;i<t.entries;i++){
  const capacity=t.hierarchyCapacities[i],records=[];
  for(let j=0;j<capacity;j++)records.push(t.packedVisibleClusters.slice((base+j)*3,(base+j+1)*3));
  records.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);rows.set(t.entryInstanceIDs[i],records);base+=capacity;
 }
 assert.equal(base*3,t.packedVisibleClusters.length);return [...rows].sort((a,b)=>a[0]-b[0]);
}
(async()=>{let context,page,owner;try{
 const pkg=JSON.parse(fs.readFileSync(report.package.file));assert(pkg.pass);for(const p of pkg.products)assert.equal(audit(p.file).sha256,p.sha256,p.file);
 context=await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}`,{channel:'msedge',headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1});
 await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
 await context.route('**/'+folder+'/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebVisualTestClock",')});});
 await context.route('**/config-files.json*',async route=>{
  const r=await route.fetch(),files=await r.json(),f=files.find(f=>f.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(f);
  const data=Buffer.from(Buffer.from(f.data,'base64').toString()+'\n[SystemSettings]\nr.Test.FreezeTemporalSequences=1\n'+
   (materialPrecache===undefined?'':'r.Nanite.WebMaterialPrecache='+materialPrecache+'\n'));
  f.data=data.toString('base64');f.sha256=crypto.createHash('sha256').update(data).digest('hex');report.temporalConfig={path:f.path,sha256:f.sha256};
  await route.fulfill({response:r,body:JSON.stringify(files)});
 });
 page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{log.write(m.text()+'\n');if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||(globalThis.__webEngineFrames>=180&&globalThis.__webPSOPrecacheReady),null,{timeout:600000});
 assert(!await page.evaluate(()=>globalThis.__webEngineFailure));owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 const rpc=(fn,...args)=>page.evaluate(a=>__webEngineRPC(a[0],...a.slice(1)),[fn,...args]);
 report.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock);assert(report.clock.renderTimeFrozen);
 report.camera=await owner.evaluate(()=>globalThis.__webDefaultCamera);
 assert.equal(await rpc('WebNaniteMaterialBoundsTest',1,1,1),1);
 let step=0;
 async function capture(label,batch){
  assert.equal(await rpc(batchRPC,batch),1);
  assert.equal(await rpc('WebNaniteAutomaticSceneTest',++step),1);let t;const start=Date.now();
  do{await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert(!await page.evaluate(()=>globalThis.__webEngineFailure));assert.equal(await rpc('WebNaniteAutomaticSceneTest',0),1);t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest);}
  while(t?.step!==step&&Date.now()-start<180000);
  assert.equal(t?.step,step);assert.equal(t[micro?'microBatch':pack?'packBatch':occlusion?'occlusionBatch':'hierarchyBatch'],!!batch);assert.equal(t.rejected,0);
  if(materialPrecache!==undefined)assert.equal(t.materialPrecache,materialPrecache==='1');
  const batched=t[micro?'microBatchedEntries':pack?'packBatchedEntries':occlusion?'finalOcclusionBatchedEntries':'hierarchyBatchedEntries'],buffers=t[micro?'microDispatchBuffers':pack?'packDispatchBuffers':occlusion?'finalOcclusionDispatchBuffers':'hierarchyDispatchBuffers'];
  if(t.entries){assert(t.materialComplete);hierarchy(t);if(batch&&t.entries>1)assert(batched>0);else assert.equal(batched,0);
   if(occlusion||pack||micro){assert(t.hierarchyBatch);for(const prefix of ['mainOcclusion','finalOcclusion'])occlusionRows(t,prefix);}
   if(pack||micro){assert(t.occlusionBatch&&t.materialPrecache);packedRows(t);}
   if(micro){assert(t.packBatch);assert.equal(t.microDispatchArguments.length%3,0);
    for(let i=0;i<t.microDispatchArguments.length;i+=3)assert(t.microDispatchArguments[i]<=65535&&t.microDispatchArguments[i+1]===1&&t.microDispatchArguments[i+2]===1);}}
  const file=path.join(output,`step-${step}.json`);fs.writeFileSync(file,JSON.stringify(t));
  report.tests.push({label,step,batch,entries:t.entries,registered:t.registered,batched,dispatchBuffers:buffers,readback:audit(file)});save();return t;
 }
 for(let i=0;i<3;i++)await capture('lifecycle',1);
 const cases=[{name:'spawn',camera:report.camera}];
 if(villa)cases.push({name:'room',view:[-175,-80,160,-5,50]},{name:'room-turn',view:[-175,-80,160,-5,125]});
 else cases.push({name:'moved',view:[-1000,-70,230,-8,65]});
 cases.push({name:'portrait',camera:report.camera,portrait:true});
 for(const c of cases){
  await page.setViewportSize(c.portrait?{width:720,height:1280}:{width:1280,height:720});
  if(c.view)assert.equal(await rpc('WebProjectViewTest',...c.view),1);
  else if(c.name!=='spawn'){const a=c.camera;assert.equal(await rpc('WebRestoreCamera',a.x,a.y,a.z,a.pitch,a.yaw,0,90,1),1);}
  const before=await capture(c.name,0),after=await capture(c.name,1),restored=await capture(c.name,0);
  report.comparisons.push({name:c.name,on:compare(before,after),restored:compare(after,restored)});save();
  console.log(report.comparisons.at(-1));
 }
 assert.equal(await rpc('WebNaniteAutomaticSceneTest',-1),1);assert.equal(await rpc(batchRPC,-1),1);
 report.gpu=await owner.evaluate(()=>__batchGPU);assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
 report.engineFailure=await page?.evaluate(()=>globalThis.__webEngineFailure||null).catch(()=>null);
}finally{await context?.close();log.end();save();console.log({pass:report.pass,output,failure:report.failure});}})();
