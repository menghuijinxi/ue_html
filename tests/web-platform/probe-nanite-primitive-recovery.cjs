'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),mode=scalar?'scalar':'packed';
const folder=process.argv.find(a=>a.startsWith('--folder='))?.slice(9)||'nanite-core-default';
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)||'nanite-primitive-recovery';
assert([folder,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
const dir=path.join(__dirname,'results',tag);fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,mode+'.json');
assert(!fs.existsSync(file),'Use a new result tag');fs.copyFileSync(__filename,path.join(dir,mode+'-source.cjs'));
const report={pass:false,scalar,source:audit(__filename),package:audit(path.join(__dirname,'build',folder,'package.json')),tests:[],errors:[],logs:[]};
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
function observe(scalar){
 const request=GPUAdapter.prototype.requestDevice;globalThis.__primitiveGPU={errors:[]};
 GPUAdapter.prototype.requestDevice=async function(d){
  if(scalar)d={...d,requiredFeatures:[...(d.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);__primitiveGPU.features=[...device.features];
  device.addEventListener('uncapturederror',e=>__primitiveGPU.errors.push(e.error.message));return device;
 };
}
(async()=>{let context,page;try{
 const pkg=JSON.parse(fs.readFileSync(report.package.file));assert(pkg.pass);
 for(const p of pkg.products)assert.equal(audit(p.file).sha256,p.sha256,p.file);
 context=await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}-${mode}`,{channel:'msedge',headless:true,viewport:{width:960,height:640}});
 await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
 await context.route('**/'+folder+'/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebMaterialTestClock",')});});
 await context.route('**/config-files.json*',async route=>{
  const r=await route.fetch(),files=await r.json(),f=files.find(f=>f.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(f);
  const data=Buffer.from(Buffer.from(f.data,'base64').toString()+'\n[SystemSettings]\nr.Test.FreezeTemporalSequences=1\n');
  f.data=data.toString('base64');f.sha256=crypto.createHash('sha256').update(data).digest('hex');report.temporalConfig={path:f.path,sha256:f.sha256};
  await route.fulfill({response:r,body:JSON.stringify(files)});
 });
 page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{const t=m.text();if(/Error:|Warning:|Failed|Nanite/.test(t)){report.logs.push(t);if(report.logs.length>300)report.logs.shift();}
  if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(t))report.errors.push(t);});
 await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 report.visualClock=await owner.evaluate(()=>globalThis.__webVisualTestClock);
 assert(report.visualClock.materialTimeFrozen&&!report.visualClock.renderTimeFrozen);
 const rpc=(fn,...args)=>page.evaluate(a=>__webEngineRPC(a[0],...a.slice(1)),[fn,...args]);
 const waitFrames=async count=>{const f=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(a=>globalThis.__webEngineFailure||__webEngineFrames>=a[0]+a[1],[f,count],{timeout:90000});assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);};
 assert.equal(await rpc('WebNaniteMaterialBoundsTest',1,0,1),1);
 let step=0;
 const capture=async()=>{
  assert.equal(await rpc('WebNaniteAutomaticSceneTest',++step),1);let t;const start=Date.now();
  do{await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await rpc('WebNaniteAutomaticSceneTest',0),1);t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest);}
  while(t?.step!==step&&Date.now()-start<90000);
  assert.equal(t?.step,step);assert.equal(t.rejected,0);return t;
 };
 // Exercise the observer's existing Nanite on/off/restore sequence first.
 for(let i=0;i<3;i++)await capture();
 for(let action=1;action<=8;action++){
  assert.equal(await rpc('WebNanitePrimitiveVisibilityTest',1),1);
  assert.equal(await rpc('WebNanitePrimitiveRecoveryTest',action),1);
  await waitFrames(80);
  const history=await owner.evaluate(n=>globalThis.__webNanitePrimitiveRecovery?.modes[n],action);
  assert.equal(history?.length,16);const blocked=[1,3,5].includes(action);
  report.currentAction={action,history};save();
  for(const row of history){
   assert.equal(typeof row.targetPresent,'boolean');assert.equal(typeof row.occluderBlocking,'boolean');
   if(row.targetPresent&&!row.occluderBlocking)assert(row.candidate,`Target missing after actual render-thread disocclusion: action ${action}, frame ${row.frame}, index ${row.index}`);
  }
  // Newly occluded targets may remain conservatively visible until the timed
  // query refresh. Only recovery has a frame deadline; steady-state readback
  // below still requires blocked targets to be culled and all pixels to match.
  if(!blocked)assert(history.slice(-8).every(r=>r.candidate),'Visibility must recover within eight frames');
  if([6,8].includes(action)){const cut=history.find(r=>r.cameraCut);assert(cut,'Actual camera cut must be observed');assert(cut.candidate,'Camera cut must not retain stale occlusion');}
  assert.equal(await rpc('WebNanitePrimitiveVisibilityTest',0),1);const before=await capture();
  assert.equal(await rpc('WebNanitePrimitiveVisibilityTest',1),1);const after=await capture();
  assert.equal(before.entries,2);assert.equal(after.entries,blocked?1:2);assert(after.materialComplete);
  assert.equal(before.pixels.length,after.pixels.length);assert(after.pixels.length>0);let covered=0,maxSpecularDifference=0;
  for(let p=0;p<after.pixels.length;p+=28){
   assert.equal(after.pixels[p+2],before.pixels[p+2],`Depth action ${action} pixel ${p/28}`);
   const owns=!!after.pixels[p]&&after.pixels[p+1]===after.pixels[p+2];
   assert.equal(owns,!!before.pixels[p]&&before.pixels[p+1]===before.pixels[p+2]);if(owns)covered++;
   for(let j=8;j<28;j++){
    const d=Math.abs(float(after.pixels[p+j])-float(before.pixels[p+j]));assert(Number.isFinite(d));
    if(j===13){maxSpecularDifference=Math.max(maxSpecularDifference,d);assert(d<=1/255+1e-7);}
    else assert.equal(after.pixels[p+j],before.pixels[p+j],`Material action ${action} pixel ${p/28} channel ${j}`);
   }
  }
  assert(covered>20);report.tests.push({action,blocked,history,before,after,covered,maxSpecularDifference});save();
  console.log({action,blocked,covered,entries:after.entries,recoveryFrame:history.findIndex(r=>r.candidate)});
 }
 assert.equal(await rpc('WebNanitePrimitiveRecoveryTest',-1),1);
 assert.equal(await rpc('WebNaniteAutomaticSceneTest',-1),1);
 assert.equal(await rpc('WebNaniteMaterialBoundsTest',-1,0,1),1);
 assert.equal(await rpc('WebNanitePrimitiveVisibilityTest',-1),1);
 await waitFrames(30);report.gpu=await owner.evaluate(()=>__primitiveGPU);assert.deepEqual(report.gpu.errors,[]);
 assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.errors,[]);
 report.frames=await page.evaluate(()=>__webEngineFrames);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);
 const owner=page?.workers().find(w=>w.url().includes('web-engine-worker.js'));
 report.state=owner?await owner.evaluate(()=>({history:globalThis.__webNanitePrimitiveRecovery,result:globalThis.__webNaniteAutomaticSceneTest})).catch(()=>null):null;
}finally{await context?.close();save();console.log({pass:report.pass,file});}})();
