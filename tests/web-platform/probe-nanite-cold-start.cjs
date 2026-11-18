'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const dir=path.join(__dirname,'results/nanite-automatic-cold-start');fs.mkdirSync(dir,{recursive:true});
const report={pass:false,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-default-scene/package.json')),runs:[]};
function observe(scalar){const request=GPUAdapter.prototype.requestDevice;globalThis.__coldGPU={errors:[]};GPUAdapter.prototype.requestDevice=async function(d){
  if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);__coldGPU.features=[...device.features];device.addEventListener('uncapturederror',e=>__coldGPU.errors.push(e.error.message));return device;
};}
(async()=>{let context,page;try{
  for(let i=0;i<4;i++){
    const run={index:i,scalar:!!(i%2),logs:[],errors:[],pass:false};report.runs.push(run);
    const profile=fs.mkdtempSync(path.join(dir,'profile-'));assert.deepEqual(fs.readdirSync(profile),[]);run.profile=profile;
    context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
    await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${run.scalar});\n`+await r.text()});});
    page=await context.newPage();const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
    page.on('console',m=>{const line=m.text();if(run.logs.length<300||/Error|Failed|Nanite|P3_ENGINE_INIT|P3_STARTUP/.test(line))run.logs.push(line);});
    page.on('pageerror',e=>run.errors.push(e.stack));const start=Date.now();
    await page.goto('http://127.0.0.1:8765/build/nanite-default-scene/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
    run.readyMilliseconds=Date.now()-start;assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',1)),1);
    const wait=Date.now();let data;
    do{await page.waitForTimeout(100);await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));data=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
    }while(!data&&Date.now()-wait<90000);
    assert(data&&data.automatic&&data.enabled&&data.materialComplete&&data.materialDraws===8&&data.entries===8&&data.rejected===0);
    let covered=0;for(let p=0;p<data.pixels.length;p+=28)if(data.pixels[p]&&data.pixels[p+1]===data.pixels[p+2])covered++;assert(covered>500);
    run.scene={covered,entries:data.entries,draws:data.materialDraws,assets:data.assets,batches:data.batches,cullStates:data.cullStates};
    run.state=await owner.evaluate(()=>({gpu:__coldGPU,rhi:__webOptimizationRHI,frames:__webEngineFrames,startup:globalThis.__webStartupDiagnostics}));
    assert.deepEqual(run.errors,[]);assert.deepEqual(run.state.gpu.errors,[]);assert.equal(run.state.gpu.features.includes('atomic-vec2u-min-max'),!run.scalar);
    assert(run.state.rhi.asyncPrecacheRequested>100);assert.equal(run.state.rhi.asyncPrecacheRequested,run.state.rhi.asyncPrecacheCompleted);assert.equal(run.state.rhi.asyncPrecacheFailed,0);
    run.pass=true;await context.close();context=null;console.log({index:i,scalar:run.scalar,readyMilliseconds:run.readyMilliseconds,covered});
  }
  report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,recovery:globalThis.__webEngineRecovery,stages:globalThis.__webThreadStages,pso:globalThis.__webOptimizationRHI})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(report,null,2));}})();
