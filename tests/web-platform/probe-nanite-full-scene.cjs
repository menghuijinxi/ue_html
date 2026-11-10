'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),name=scalar?'scalar':'packed';
const frustumComparison=process.argv.includes('--frustum-comparison');
const binsComparison=process.argv.includes('--material-bins-comparison');
const hierarchyComparison=process.argv.includes('--hierarchy-comparison');
assert([frustumComparison,binsComparison,hierarchyComparison].filter(Boolean).length<=1);
const comparison=frustumComparison||binsComparison||hierarchyComparison;
const output=path.join(__dirname,hierarchyComparison?'results/nanite-local-hierarchy':binsComparison?'results/nanite-material-bins':frustumComparison?'results/nanite-full-scene-frustum':'results/nanite-full-scene');fs.mkdirSync(output,{recursive:true});
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
  // The rigid opaque-only implementation registered 1,254 Villa components.
  // Newly eligible masked/PDO components must actually leave the fallback path.
  assert(t.registered>1254&&t.entries>0&&suppressed>1254);assert(t.materialComplete);
  assert.equal(t.entries+t.skipped,t.registered,'Every registered ordinary instance is processed or conservatively rejected');
  assert(t.materialDraws>0);if(!t.materialBins)assert(t.materialDraws>=t.entries);
  assert.equal(t.cullStates.length,t.entries*4);
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
  const views=comparison?[[-175,-80,160,-5,50],null,null,[-175,-80,160,-5,50],null,[-175,-80,160,-5,230],null,[-1000,-70,230,-8,65],null]:
    [[-175,-80,160,-5,50],null,null,[-175,-80,160,-5,230],[-1000,-70,230,-8,65],[-175,-80,160,-5,50]];
  for(let step=1;step<=views.length;step++){
    const camera=views[step-1];if(camera)assert.equal(await page.evaluate(c=>__webEngineRPC('WebProjectViewTest',...c),camera),1);
    if(comparison)assert.equal(await page.evaluate(a=>__webEngineRPC('WebNaniteMaterialBoundsTest',...a),[1,step<6?0:step<8?3:7,frustumComparison&&[4,6,8].includes(step)?0:1]),1);
    if(binsComparison)assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteMaterialBinsTest',s),[4,6,8].includes(step)?0:1),1);
    if(hierarchyComparison)assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteHierarchyModeTest',s),[4,6,8].includes(step)?0:1),1);
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
    const start=Date.now();let t;
    do{await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
      await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
    }while((!t||t.step!==step)&&Date.now()-start<120000);
    assert(t&&t.step===step,`step ${step} readback`);report.tests.push(t);save();t.validation=verify(t);
    if(comparison&&[5,7,9].includes(step)){
      const previous=report.tests.at(-2);assert.deepEqual(t.view,previous.view);
      if(frustumComparison){assert(!previous.instanceFrustum&&t.instanceFrustum);assert(t.entries<previous.entries*.25,'Offscreen GPU work must be removed');}
      else if(hierarchyComparison){assert(!previous.localHierarchy&&t.localHierarchy);assert.equal(previous.localHierarchyEntries,0);
        assert.equal(t.localHierarchyEntries,t.entries);assert(t.maxHierarchyNodes>0&&t.maxHierarchyNodes<=256);
        assert.equal(t.entries,previous.entries);assert.deepEqual(t.entryInstanceIDs,previous.entryInstanceIDs);assert.equal(t.materialDraws,previous.materialDraws);}
      else {assert(!previous.materialBins&&t.materialBins);assert.equal(t.entries,previous.entries);assert.deepEqual(t.entryInstanceIDs,previous.entryInstanceIDs);
        assert(t.materialDraws<previous.materialDraws*.75,'Equivalent native shader bindings must share shading work');}
      const before=new Map(previous.entryInstanceIDs.map((id,i)=>[id,previous.cullStates.slice(i*4,i*4+4)]));
      const after=new Map(t.entryInstanceIDs.map((id,i)=>[id,t.cullStates.slice(i*4,i*4+4)]));
      for(const [id,state] of before){if(!after.has(id))assert.equal(state[0],0,'CPU culling removed a GPU-visible cluster');else assert.deepEqual(after.get(id),state,'Retained hierarchy result changed');}
      for(const id of after.keys())assert(before.has(id));
      let compared=0,maxDepthDifference=0,maxSpecularDifference=0;
      for(let i=0;i<t.width*t.height;i++){
        const p=i*28;assert.equal(!!t.pixels[p],!!previous.pixels[p],'Nanite coverage changed');
        if(!t.pixels[p])continue;
        assert.equal(t.pixels[p+1]===t.pixels[p+2],previous.pixels[p+1]===previous.pixels[p+2],'Ordinary mesh depth ownership changed');
        for(let j=1;j<3;j++){const difference=Math.abs(float(t.pixels[p+j])-float(previous.pixels[p+j]));maxDepthDifference=Math.max(maxDepthDifference,difference);assert(difference<1e-6,'Visibility depth changed');}
        if(t.pixels[p+1]!==t.pixels[p+2])continue;
        for(let j=8;j<28;j++){
          const difference=Math.abs(float(t.pixels[p+j])-float(previous.pixels[p+j]));
          if(j===13){maxSpecularDifference=Math.max(maxSpecularDifference,difference);assert(difference<=1/255+1e-7);}
          else assert.equal(t.pixels[p+j],previous.pixels[p+j],`Frustum pixel ${i}, channel ${j}`);
        }
        compared++;
      }
      t[hierarchyComparison?'hierarchyComparison':frustumComparison?'frustumComparison':'binsComparison']={compared,
        before:hierarchyComparison?previous.hierarchyDispatchLevels:frustumComparison?previous.entries:previous.materialDraws,
        after:hierarchyComparison?t.localHierarchyEntries:frustumComparison?t.entries:t.materialDraws,maxDepthDifference,maxSpecularDifference};
    }
    const pipelineStart=Date.now();
    do{
      t.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
      if(t.rhi&&t.rhi.asyncPrecacheRequested===t.rhi.asyncPrecacheCompleted)break;
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    }while(Date.now()-pipelineStart<90000);
    assert(t.rhi.asyncPrecacheRequested>100);assert.equal(t.rhi.asyncPrecacheRequested,t.rhi.asyncPrecacheCompleted);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
    const file=path.join(output,`${name}-${step}.png`);await page.locator('canvas').screenshot({path:file});t.image=audit(file);
    const before=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames}));
    await page.waitForFunction(f=>__webEngineFrames>=f+120,before.frames,{timeout:120000});
    const end=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames,runtime:globalThis.__webEngineRuntime}));
    t.performance={frames:end.frames-before.frames,milliseconds:end.time-before.time,fps:(end.frames-before.frames)*1000/(end.time-before.time),runtime:end.runtime};
    save();console.log({step,...t.validation,fps:t.performance.fps});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
  if(comparison)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBoundsTest',-1,0,1)),1);
  if(binsComparison)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBinsTest',-1)),1);
  if(hierarchyComparison)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteHierarchyModeTest',-1)),1);
  const before=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>f+30,before,{timeout:30000});
  report.gpu=await owner.evaluate(()=>__fullSceneGPU);assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  report.frames=await page.evaluate(()=>__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,recovery:globalThis.__webEngineRecovery,stages:globalThis.__webThreadStages,pso:globalThis.__webOptimizationRHI})).catch(()=>null):null;
  owner=owner||page?.workers().find(w=>w.url().includes('web-engine-worker.js'));
  report.worker=owner?await owner.evaluate(()=>({gpu:globalThis.__fullSceneGPU,pso:globalThis.__webOptimizationRHI,result:globalThis.__webNaniteAutomaticSceneTest,progress:globalThis.__webNaniteAutomaticProgress})).catch(()=>null):null;
}finally{clearInterval(pulse);await context?.close();save();}})();
