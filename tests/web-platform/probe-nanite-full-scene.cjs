'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),name=scalar?'scalar':'packed';
const output=path.join(__dirname,'results/nanite-full-scene');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalar,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-full-scene/package.json')),
  tests:[],errors:[],events:[],startupLogs:[],logs:[],boundary:'Full-scene diagnostic. Unsupported material categories still use fallback; this is not full compatibility acceptance.'};
const conversionFile=path.join(__dirname,'results/nanite-full-scene-conversion-verified.json');
const conversion=JSON.parse(fs.readFileSync(conversionFile,'utf8'));assert(conversion.pass);report.conversion=audit(conversionFile);
const assets=JSON.parse(fs.readFileSync(conversion.report.file,'utf8')).meshes;
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const save=()=>fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(report,null,2));
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;globalThis.__fullSceneGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__fullSceneGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__fullSceneGPU.errors.push(e.error.message));return device;
  };
}
function verify(t){
  assert(t.automatic);assert.equal(t.enabled,t.step!==2);assert.equal(t.rejected,0);
  const expected=assets.filter(a=>a.nanite&&a.clusters>0);
  assert.equal(t.assets.length,expected.reduce((s,a)=>s+a.components,0));
  const counts=new Map();for(const a of t.assets){
    const original=expected.find(x=>x.path===a.mesh);assert(original,a.mesh);
    assert.equal(a.clusters,original.clusters);assert.equal(a.rootPages,original.rootPages);
    assert.equal(a.fallbackTriangles,original.fallbackTriangles);counts.set(a.mesh,(counts.get(a.mesh)||0)+1);
  }
  for(const a of expected)assert.equal(counts.get(a.path),a.components,a.path);
  assert(t.batches.length>2000);assert(t.batches.every(b=>b.created&&b.triangles>0));
  const suppressed=t.batches.filter(b=>!b.material&&!b.depth&&!b.occluder).length;
  if(t.step===2){assert.equal(t.entries,0);assert.equal(suppressed,0);return {covered:0,suppressed};}
  assert(t.registered>500&&t.entries>500&&suppressed>500);assert(t.materialComplete);
  assert(t.materialDraws>=t.entries);assert.equal(t.cullStates.length,t.entries*4);
  let visible=0;for(let i=0;i<t.entries;i++){assert.equal(t.cullStates[i*4+1],0);visible+=t.cullStates[i*4];}
  assert(visible>0);assert.equal(t.pixels.length,t.width*t.height*28);
  let covered=0;const shadingModels={};
  for(let i=0;i<t.width*t.height;i++){
    const p=i*28;if(!t.pixels[p]||t.pixels[p+1]!==t.pixels[p+2])continue;covered++;
    const model=Math.round(float(t.pixels[p+15])*255)&15;shadingModels[model]=(shadingModels[model]||0)+1;
    for(let j=3;j<28;j++)assert(Number.isFinite(float(t.pixels[p+j])),'Nonfinite material output');
  }
  assert(covered>100,'Actual Nanite materials must cover the full scene view');
  return {covered,suppressed,ordinaryFallback:t.batches.length-suppressed,visible,shadingModels};
}
(async()=>{let context,page,owner,pulse;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
  await context.route('**/nanite-full-scene/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebVisualTestClock",')});});
  page=await context.newPage();page.on('pageerror',e=>{report.errors.push({name:e.name,message:e.message});save();});
  pulse=setInterval(async()=>{
    report.pulse=await page.evaluate(()=>({time:performance.now(),frames:globalThis.__webEngineFrames,
      stages:globalThis.__webThreadStages,rhi:globalThis.__webOptimizationRHI,memory:globalThis.__webThreadsMemory,
      runtime:globalThis.__webEngineRuntime,recovery:globalThis.__webEngineRecovery})).catch(()=>null);save();
  },10000);
  page.on('console',m=>{const line=m.text();report.logs.push(line);if(report.logs.length>400)report.logs.shift();if(report.startupLogs.length<300)report.startupLogs.push(line);
    if(/Warning:|Error:|Failed to load|Couldn't find|P3_RENDER_SCENE|Command Line:|NaniteStreaming/.test(line))report.events.push(line);});
  const started=Date.now();await page.goto('http://127.0.0.1:8765/build/nanite-full-scene/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
  report.startupMs=Date.now()-started;assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  await page.addStyleTag({content:'body > :not(canvas) { visibility: hidden !important; } canvas, canvas * { visibility: visible !important; }'});
  const views=[[-175,-80,160,-5,50],null,null,[-175,-80,160,-5,230],[-1000,-70,230,-8,65],[-175,-80,160,-5,50]];
  for(let step=1;step<=views.length;step++){
    const camera=views[step-1];if(camera)assert.equal(await page.evaluate(c=>__webEngineRPC('WebProjectViewTest',...c),camera),1);
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
    const start=Date.now();let t;
    do{await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
      await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
    }while((!t||t.step!==step)&&Date.now()-start<120000);
    assert(t&&t.step===step,`step ${step} readback`);report.tests.push(t);save();t.validation=verify(t);
    t.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
    assert(t.rhi.asyncPrecacheRequested>100);assert.equal(t.rhi.asyncPrecacheRequested,t.rhi.asyncPrecacheCompleted);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
    const file=path.join(output,`${name}-${step}.png`);await page.locator('canvas').screenshot({path:file});t.image=audit(file);
    const before=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames}));
    await page.waitForFunction(f=>__webEngineFrames>=f+120,before.frames,{timeout:120000});
    const end=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames,runtime:globalThis.__webEngineRuntime}));
    t.performance={frames:end.frames-before.frames,milliseconds:end.time-before.time,fps:(end.frames-before.frames)*1000/(end.time-before.time),runtime:end.runtime};
    save();console.log({step,...t.validation,fps:t.performance.fps});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
  const before=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>f+30,before,{timeout:30000});
  report.gpu=await owner.evaluate(()=>__fullSceneGPU);assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  report.frames=await page.evaluate(()=>__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,recovery:globalThis.__webEngineRecovery,stages:globalThis.__webThreadStages,pso:globalThis.__webOptimizationRHI})).catch(()=>null):null;
  owner=owner||page?.workers().find(w=>w.url().includes('web-engine-worker.js'));
  report.worker=owner?await owner.evaluate(()=>({gpu:globalThis.__fullSceneGPU,pso:globalThis.__webOptimizationRHI,result:globalThis.__webNaniteAutomaticSceneTest,progress:globalThis.__webNaniteAutomaticProgress})).catch(()=>null):null;
}finally{clearInterval(pulse);await context?.close();save();}})();
