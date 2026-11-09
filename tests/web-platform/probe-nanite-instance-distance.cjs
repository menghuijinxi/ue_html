'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),mode=scalar?'scalar':'packed';
const directory=path.join(__dirname,'results/nanite-instance-distance');fs.mkdirSync(directory,{recursive:true});
const report={pass:false,scalar,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-default-scene/package.json')),tests:[],errors:[],logs:[]};
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;globalThis.__distanceGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__distanceGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__distanceGPU.errors.push(e.error.message));return device;
  };
}
function verify(t){
  assert.equal(t.rejected,0);assert(t.inputs.instances.length);const selected=[];
  for(const instance of t.inputs.instances){
    const m=instance.localToWorld,p=[...instance.localCenter,1];
    const center=[0,1,2].map(c=>p.reduce((sum,v,r)=>sum+v*m[r*4+c],0));
    const distance=Math.hypot(...center.map((v,k)=>v-t.camera[k]));
    if(!t.inputs.cull||instance.end<=0||(distance>=instance.min*t.inputs.scale&&distance<=instance.end*t.inputs.scale))selected.push(instance);
  }
  assert.equal(selected.length,[6,2,0,6,2,0,12,2,6,12,6,3,1,3,7,6,3][t.step-1],'independent fixture distance expectation');
  assert.equal(t.entries.length,selected.length,'all and only in-range instances must reach Nanite traversal');
  const unmatched=[...selected];
  for(const e of t.entries){
    assert(e.material.includes('M_Default_0_3'),'actual cooked material must survive the ISM/HISM path');
    const i=unmatched.findIndex(x=>x.component===e.component&&x.localToWorld.every((v,k)=>Math.abs(v-e.localToWorld[k])<.0003));
    assert(i>=0,'instance identity and world transform, including HISM reordering');unmatched.splice(i,1);
  }
  assert.equal(unmatched.length,0);assert.equal(new Set(t.entries.map(e=>e.instanceId)).size,t.entries.length);
  assert.equal((t.states||[]).length,t.entries.length*4);
  for(let i=0;i<t.entries.length;i++)assert.equal(t.states[i*4+1],0);
  for(const batch of t.batches){if(!batch.created)continue;assert(!batch.material&&!batch.depth,'normal fallback must not supply Nanite test coverage');}
  assert.equal(t.pixels.length,256*192*2);let coverage=0;
  for(let i=0;i<t.pixels.length;i+=2){if(t.pixels[i])coverage++;else assert.equal(t.pixels[i+1],0);}
  if(selected.length)assert(coverage>0,'selected real Nanite geometry must reach the GPU raster');else assert.equal(coverage,0);
  return {selected:selected.length,coverage,components:[0,1].map(c=>selected.filter(i=>i.component===c).length)};
}
(async()=>{let context,page,worker;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
  page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{report.logs.push(m.text());if(report.logs.length>800)report.logs.shift();});
  await page.goto('http://127.0.0.1:8765/build/nanite-default-scene/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  worker=page.workers().find(w=>w.url().includes('web-engine-worker'));assert(worker);
  for(let step=1;step<=17;step++){
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteInstanceDistanceTest',s),step),1);
    let t;const start=Date.now();
    do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
      await page.evaluate(()=>__webEngineRPC('WebNaniteInstanceDistanceTest',0));t=await worker.evaluate(()=>globalThis.__webNaniteInstanceDistanceTest||null);
    }while((!t||t.step!==step)&&Date.now()-start<90000);
    assert(t&&t.step===step,'distance readback step '+step);report.tests.push(t);t.validation=verify(t);console.log({step,...t.validation});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteInstanceDistanceTest',18)),1);
  const before=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+120,before,{timeout:30000});
  report.gpu=await worker.evaluate(()=>__distanceGPU);report.rhi=await worker.evaluate(()=>__webOptimizationRHI);report.frames=await page.evaluate(()=>__webEngineFrames);
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.gpu.errors,[]);assert.deepEqual(report.errors,[]);
  assert.equal(report.rhi.asyncPrecacheRequested,report.rhi.asyncPrecacheCompleted);assert.equal(report.rhi.asyncPrecacheFailed||0,0);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,recovery:globalThis.__webEngineRecovery})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(directory,mode+'.json'),JSON.stringify(report,null,2));}})();
