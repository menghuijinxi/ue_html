'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),defaultScene=process.argv.includes('--default-scene');
const folder=defaultScene?'nanite-core-default':'nanite-core-scene',mode=scalar?'scalar':'packed';
const pages=Number(process.argv.find(a=>a.startsWith('--streaming-pages='))?.split('=')[1]||12);
assert(Number.isInteger(pages)&&pages>=1&&pages<=512);
const dir=path.join(__dirname,'results/nanite-core-lifecycle'),name=(defaultScene?'default':'villa')+'-'+mode+'-'+pages;fs.mkdirSync(dir,{recursive:true});
const file=path.join(dir,name+'.json'),report={pass:false,defaultScene,scalar,pages,source:audit(__filename),
 package:audit(path.join(__dirname,'build',folder,'package.json')),runs:[],errors:[],events:[]};
const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
function observe(scalar){
 const request=GPUAdapter.prototype.requestDevice;globalThis.__coreGPU={errors:[],buffers:[]};
 GPUAdapter.prototype.requestDevice=async function(d){
  if(scalar)d={...d,requiredFeatures:[...(d.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);__coreGPU.features=[...device.features];
  device.addEventListener('uncapturederror',e=>__coreGPU.errors.push(e.error.message));
  const create=device.createBuffer.bind(device);device.createBuffer=d=>{if(d.size>=1024*1024)__coreGPU.buffers.push({label:d.label,size:d.size});return create(d);};return device;
 };
}
function compare(a,b){assert.equal(a.pixels.length,b.pixels.length);assert.deepEqual(a.view,b.view);let covered=0,maxSpecularDifference=0;
 for(let p=0;p<a.pixels.length;p+=28){
  assert.equal(a.pixels[p+2],b.pixels[p+2],`Restored final depth ${p/28}`);
  const own=!!a.pixels[p]&&a.pixels[p+1]===a.pixels[p+2];assert.equal(own,!!b.pixels[p]&&b.pixels[p+1]===b.pixels[p+2]);if(own)covered++;
  for(let j=8;j<28;j++){const diff=Math.abs(float(a.pixels[p+j])-float(b.pixels[p+j]));assert(Number.isFinite(diff));
   if(j===13){maxSpecularDifference=Math.max(maxSpecularDifference,diff);assert(diff<=1/255+1e-7);}
   else assert.equal(a.pixels[p+j],b.pixels[p+j],`Restored material ${p/28} channel ${j}`);}
 }assert(covered>100);return {covered,maxSpecularDifference};}
(async()=>{let context,page;try{
 const pkg=JSON.parse(fs.readFileSync(report.package.file));assert(pkg.pass);pkg.products.forEach(p=>assert.equal(audit(p.file).sha256,p.sha256,p.file));
 // Put fresh persistent browser caches on the archive volume, not in the build tree.
 const profiles='C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser';fs.mkdirSync(profiles,{recursive:true});
 report.profile=fs.mkdtempSync(path.join(profiles,name+'-'));assert.deepEqual(fs.readdirSync(report.profile),[]);
 context=await chromium.launchPersistentContext(report.profile,{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
 await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
 await context.route('**/'+folder+'/index.html',async route=>{const r=await route.fetch();let body=await r.text();assert(!body.includes('-WebNaniteStreamingPages='));
  body=body.replace('arguments: [',`arguments: ["-WebMaterialTestClock","-WebNaniteStreamingPages=${pages}",`);await route.fulfill({response:r,body});});
 await context.route('**/config-files.json*',async route=>{const r=await route.fetch(),files=await r.json();
  const f=files.find(f=>defaultScene?f.path==='/Engine/Platforms/Web/Config/WebEngine.ini':f.path.endsWith('/UEWebEngine/Config/DefaultEngine.ini'));assert(f);
  const data=Buffer.from(Buffer.from(f.data,'base64').toString()+'\n[SystemSettings]\nr.Test.FreezeTemporalSequences=1\n');
  f.data=data.toString('base64');f.sha256=crypto.createHash('sha256').update(data).digest('hex');await route.fulfill({response:r,body:JSON.stringify(files)});});
 page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
 page.on('pageerror',e=>{report.errors.push(e.stack);save();});page.on('crash',()=>report.errors.push('Page crashed'));
 page.on('console',m=>{const s=m.text();if(/Command Line:|Retrying IO request|GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(s)){report.events.push(s);save();}});
 const owner=()=>page.workers().find(w=>w.url().includes('web-engine-worker.js'));
 const rpc=(fn,...args)=>page.evaluate(a=>__webEngineRPC(a[0],...a.slice(1)),[fn,...args]);
 const waitFrames=async n=>{const f=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(a=>globalThis.__webEngineFailure||__webEngineFrames>=a[0]+a[1],[f,n],{timeout:120000});assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);};
 const ready=async generation=>{await page.waitForFunction(g=>globalThis.__webEngineFailure||(globalThis.__webEngineRecovery?.generation===g&&__webEngineRecovery.phase==='running'),generation,{timeout:300000});assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);};
 const run=async generation=>{
  const w=owner();assert(w);const clock=await w.evaluate(()=>globalThis.__webVisualTestClock);assert(clock.materialTimeFrozen&&!clock.renderTimeFrozen);
  let cameras=[[-175,-80,160,-5,50],[-175,-80,160,-5,230],[-1000,-70,230,-8,65],[-175,-80,160,-5,50]];
  if(defaultScene){
   const samples=await w.evaluate(()=>__webDefaultSamples);assert(samples.sceneUnchanged&&samples.samples.length===8);
   const c=samples.camera,s=samples.samples[0],yaw=c.yaw*Math.PI/180,original=[c.x,c.y,c.z,c.pitch,c.yaw];
   // A distant sphere can legitimately use only root geometry. Approach a real
   // sample to require fine pages, then return to the original camera.
   cameras=[original,[s.x-Math.cos(yaw)*s.radius*1.5,s.y-Math.sin(yaw)*s.radius*1.5,s.z,0,c.yaw],original];
  }
  assert.equal(await rpc('WebNaniteMaterialBoundsTest',1,0,1),1);let step=0;const tests=[];
  const capture=async()=>{assert.equal(await rpc('WebNaniteAutomaticSceneTest',++step),1);let t;const start=Date.now();
   do{await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    assert.equal(await rpc('WebNaniteAutomaticSceneTest',0),1);t=await w.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest);}
   while(t?.step!==step&&Date.now()-start<120000);assert.equal(t?.step,step);assert.equal(t.rejected,0);
   if(step===2)assert.equal(t.entries,0);else {assert(t.entries>0&&t.materialComplete);assert(t.primitiveVisibility);
    assert(t.registered>=(defaultScene?8:2062));assert(t.cullStates.every((v,i)=>i%4!==1||v===0));let covered=0;
    for(let p=0;p<t.pixels.length;p+=28){if(t.pixels[p]&&t.pixels[p+1]===t.pixels[p+2])covered++;for(let j=8;j<28;j++)assert(Number.isFinite(float(t.pixels[p+j])));}
    assert(covered>100);t.covered=covered;}
   tests.push(t);return t;};
  for(const [index,camera] of cameras.entries()){
   if(camera)assert.equal(await rpc('WebProjectViewTest',...camera),1);await waitFrames(600);
   if(index===0){await capture();await capture();await capture();}else await capture();
  }
  const gpu=await w.evaluate(()=>__coreGPU);assert.deepEqual(gpu.errors,[]);assert.equal(gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  report.observed={generation,tests,gpu,cameras};save();
  // The RHI does not pass UE buffer names to WebGPU. Read the actual pool
  // bound to Nanite culling and its GPU page-owner table through the observer.
  const active=tests.filter(t=>t.entries>0);
  for(const t of active){assert.equal(t.poolPages,pages);assert.equal(t.poolOwners.length,pages);
   const roots=(t.poolBytes-pages*131072)/32768;assert(Number.isInteger(roots)&&roots>=1&&roots<=1024);
   // FRDGBufferPool::GetAlignedBufferDesc rounds pooled allocations to 64 KiB;
   // the graph SRV preserves its smaller logical size.
   t.allocatedPoolBytes=Math.ceil(t.poolBytes/65536)*65536;
   assert(gpu.buffers.some(b=>b.size===t.allocatedPoolBytes),'Reported pool must have a corresponding aligned GPU allocation');
   assert(t.poolOwners.every(o=>o===0xffffffff||(o>=pages&&o<pages+1024)));}
  assert(active.some(t=>t.poolOwners.some(o=>o!==0xffffffff)),'Camera sweep must install actual streamed pages');
  const poolBytes=Math.max(...active.map(t=>t.poolBytes));
  const io=await w.evaluate(()=>globalThis.__webContentIO?.stats),rhi=await w.evaluate(()=>__webOptimizationRHI);
  assert.equal(rhi.asyncPrecacheRequested,rhi.asyncPrecacheCompleted);assert.equal(rhi.asyncPrecacheFailed||0,0);
  assert.equal(await rpc('WebNaniteAutomaticSceneTest',-1),1);
  const data={generation,clock,cameras,tests,gpu,io,rhi,poolBytes,frames:await page.evaluate(()=>__webEngineFrames)};report.runs.push(data);save();return data;
 };
 const start=Date.now();await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html');await ready(1);report.coldStartMs=Date.now()-start;
 const before=await run(1),old=owner();let closed=false;old.on('close',()=>closed=true);
 const oldWorkers=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId);
 await cdp.send('Browser.crashGpuProcess');await ready(2);assert(closed);assert.notEqual(owner(),old);
 const workers=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId);assert(oldWorkers.every(id=>!workers.includes(id)));
 const after=await run(2);report.comparison=compare(before.tests[2],after.tests[2]);
 report.recovery=await page.evaluate(()=>__webEngineRecovery);assert.equal(report.recovery.attempts,1);
 assert.equal(report.recovery.events.filter(e=>e.kind==='device-lost'&&e.reason==='unknown').length,1);
 const input=await page.evaluate(()=>__webInputBridge.sent);await page.locator('#canvas').focus();await page.keyboard.press('w');await waitFrames(8);
 assert(await page.evaluate(()=>__webInputBridge.sent)>=input+2);
 await page.setViewportSize({width:1264,height:720});await page.waitForFunction(()=>globalThis.__webEngineSurface?.width===1264,null,{timeout:30000});
 assert.equal(await page.evaluate(()=>document.querySelectorAll('#canvas').length),1);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);
 report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,recovery:globalThis.__webEngineRecovery,frames:globalThis.__webEngineFrames})).catch(()=>null):null;
}finally{await context?.close();save();console.log({pass:report.pass,file});}})();
