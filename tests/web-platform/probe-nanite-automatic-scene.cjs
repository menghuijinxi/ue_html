'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),name=scalar?'scalar':'packed';
const output=path.join(__dirname,'results/nanite-automatic-scene');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalar,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-default-scene/package.json')),tests:[],errors:[],logs:[],startupLogs:[],events:[]};
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;globalThis.__automaticGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__automaticGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__automaticGPU.errors.push(e.error.message));return device;
  };
}
function verify(t){
  assert(t.automatic);assert.equal(t.enabled,t.step!==2);assert.equal(t.rejected,0);
  assert.equal(t.assets.length,8);for(const a of t.assets){assert(a.mesh.includes('SM_TestSphere'));assert(a.clusters>1);assert(a.fallbackTriangles>=16000);}
  const hidden=t.step===4,enabled=t.step!==2;
  assert.equal(t.entries,enabled&&!hidden?8:0);
  if(!hidden)assert.equal(t.batches.length,8);
  for(const b of t.batches){assert(b.created);assert(b.triangles>=16000);assert(b.shadow);assert.equal(b.material,!enabled);assert.equal(b.depth,!enabled);if(enabled)assert(!b.occluder);}
  if(!t.entries)return {covered:0};
  assert(t.materialComplete);assert.equal(t.materialDraws,8);assert.equal(t.cullStates.length,32);
  for(let i=0;i<8;i++)assert.equal(t.cullStates[i*4+1],0);
  assert.equal(t.pixels.length,t.width*t.height*28);
  let covered=0;const materials={};
  for(let i=0;i<t.width*t.height;i++){
    const p=i*28;if(!t.pixels[p]||t.pixels[p+1]!==t.pixels[p+2])continue;covered++;
    assert.equal(Math.round(float(t.pixels[p+15])*255)&15,1,'actual DefaultLit material must execute');
    const metal=float(t.pixels[p+12]),rough=float(t.pixels[p+14]);
    assert(Math.min(Math.abs(metal),Math.abs(metal-1))<.006);assert(Math.abs(float(t.pixels[p+13])-.5)<.006);
    const column=[.05,.25,.6,1].findIndex(r=>Math.abs(rough-r)<.006);assert(column>=0);
    const key=`${Math.round(metal)}/${column}`;materials[key]=(materials[key]||0)+1;
    for(let j=0;j<3;j++)assert(Math.abs(float(t.pixels[p+16+j])-.5)<.012,'real material base color');
  }
  assert(covered>80,'normal scene Nanite surfaces need actual GBuffer coverage');
  if([1,3,5,8].includes(t.step))assert.equal(Object.keys(materials).length,8,'all eight real materials must appear');
  return {covered,materials};
}
(async()=>{let context,page,owner;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
  await context.route('**/nanite-default-scene/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebVisualTestClock",')});});
  page=await context.newPage();page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
  page.on('console',m=>{const line=m.text();report.logs.push(line);if(report.logs.length>400)report.logs.shift();if(report.startupLogs.length<250)report.startupLogs.push(line);
    if(/Warning:|Error:|Failed to load|Couldn't find|P3_RENDER_SCENE|Command Line:|NaniteStreaming/.test(line))report.events.push(line);});
  await page.goto('http://127.0.0.1:8765/build/nanite-default-scene/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  for(let step=1;step<=8;step++){
    if(step===4||step===5)assert.equal(await page.evaluate(v=>__webEngineRPC('WebDefaultSamplesVisibility',v),step===5?1:0),1);
    if(step===6)assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-1000,-70,230,-8,65)),1);
    if(step===7)await page.setViewportSize({width:720,height:1280});
    if(step===8){await page.setViewportSize({width:1280,height:720});const c=report.samples.camera;assert.equal(await page.evaluate(c=>__webEngineRPC('WebRestoreCamera',c.x,c.y,c.z,c.pitch,c.yaw,0,c.fov,1),c),1);}
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
    const start=Date.now();let t;
    do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
      await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));
      t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
    }while((!t||t.step!==step)&&Date.now()-start<90000);
    assert(t&&t.step===step,`step ${step} readback`);report.tests.push(t);t.validation=verify(t);
    t.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
    assert(t.rhi.asyncPrecacheRequested>100);assert.equal(t.rhi.asyncPrecacheRequested,t.rhi.asyncPrecacheCompleted);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
    if(step===1){report.samples=await owner.evaluate(()=>globalThis.__webDefaultSamples);assert(report.samples.sceneUnchanged);assert.equal(report.samples.count,8);
      report.visualClock=await owner.evaluate(()=>globalThis.__webVisualTestClock);assert(report.visualClock.renderTimeFrozen);}
    const file=path.join(output,`${name}-${step}.png`);await page.locator('canvas').screenshot({path:file});t.image=audit(file);
    if(step<=3){
      const start=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames}));
      await page.waitForFunction(f=>__webEngineFrames>=f+120,start.frames,{timeout:90000});
      const end=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames,runtime:globalThis.__webEngineRuntime}));
      t.performance={frames:end.frames-start.frames,milliseconds:end.time-start.time,fps:(end.frames-start.frames)*1000/(end.time-start.time),runtime:end.runtime};
    }
    console.log({step,...t.validation});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
  const before=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>f+30,before,{timeout:30000});
  report.gpu=await owner.evaluate(()=>__automaticGPU);assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  report.frames=await page.evaluate(()=>__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,recovery:globalThis.__webEngineRecovery,stages:globalThis.__webThreadStages,pso:globalThis.__webOptimizationRHI})).catch(()=>null):null;
  report.worker=owner?await owner.evaluate(()=>({gpu:globalThis.__automaticGPU,pso:globalThis.__webOptimizationRHI,samples:globalThis.__webDefaultSamples,result:globalThis.__webNaniteAutomaticSceneTest,progress:globalThis.__webNaniteAutomaticProgress})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(output,`${name}.json`),JSON.stringify(report,null,2));}})();
