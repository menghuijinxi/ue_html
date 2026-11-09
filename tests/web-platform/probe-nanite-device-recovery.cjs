'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalarVisibility=process.argv.includes('--scalar-visibility');
const repeatCrashes=process.argv.includes('--repeat-crashes');
const output=path.join(__dirname,'results/nanite-device-recovery');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalarVisibility,repeatCrashes,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),runs:[],errors:[],logs:[]};
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__recoveryGPU={devices:0,losses:[],errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d),s=globalThis.__recoveryGPU;
    ++s.devices;s.features=[...device.features];
    device.lost.then(info=>s.losses.push({reason:info.reason,message:info.message}));
    device.addEventListener('uncapturederror',e=>s.errors.push(e.error.message));
    return device;
  };
}
function installRestore(){
  const start=startWebEngineWorker;
  globalThis.__recoveryRestores=[];
  globalThis.startWebEngineWorker=options=>start({...options,recovery:{
    capture:()=>({fixture:!!globalThis.__recoveryFixture,camera:globalThis.__webRecoveryCamera}),
    async restore(checkpoint,{rpc,generation}){
      const waitFrames=async n=>{const f=globalThis.__webEngineFrames;while(globalThis.__webEngineFrames<f+n){
        if(globalThis.__webEngineFailure)throw Error(globalThis.__webEngineFailure);
        await new Promise(r=>setTimeout(r,50));
      }};
      await waitFrames(8);
      globalThis.__recoveryRestores.push({generation,expected:checkpoint?.camera,actual:globalThis.__webRecoveryCamera});
      if(checkpoint?.fixture){
        for(const step of [1,2,3]){
          if(await rpc('WebNaniteStreamingTest',step)!==1)throw Error('Restore fixture step '+step+' failed');
          await waitFrames(180);await rpc('WebNaniteStreamingTest',0);await waitFrames(3);
        }
      }
    }
  }});
}
const compare=(a,b)=>{
  assert.equal(a.pixels.length,b.pixels.length);let covered=0;
  for(let i=0;i<a.pixels.length;i+=12){assert.equal(!!a.pixels[i],!!b.pixels[i]);if(a.pixels[i]){
    ++covered;for(const c of [1,3,10,11])assert.equal(a.pixels[i+c],b.pixels[i+c],`pixel ${i/12} channel ${c}`);
  }}assert(covered>900);return {covered,depthDifferences:0,maskDifferences:0};
};
(async()=>{let context,page,cdp;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{
    channel:'msedge',headless:true,viewport:{width:960,height:640},
    args:repeatCrashes?['--disable-domain-blocking-for-3d-apis']:[]});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalarVisibility});\n`+await r.text()});});
  await context.route('**/web-engine-host.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:await r.text()+`\n(${installRestore.toString()})();`});});
  await context.route('**/nanite-browser/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12"')});});
  page=await context.newPage();cdp=await context.newCDPSession(page);
  page.on('console',m=>{const t=m.text();report.logs.push(t);if(report.logs.length>800)report.logs.shift();});
  page.on('pageerror',e=>{const error={name:e.name,message:e.message,stack:e.stack};report.errors.push(error);console.error('Recovery page error',error);});page.on('crash',()=>report.errors.push('Page crashed'));
  await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
  const ready=async generation=>{
    await page.waitForFunction(g=>globalThis.__webEngineFailure||(globalThis.__webEngineRecovery?.generation===g&&globalThis.__webEngineRecovery.phase==='running'),generation,{timeout:240000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  };
  const owner=()=>page.workers().find(w=>w.url().includes('web-engine-worker.js'));
  const waitFrames=async n=>{const f=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>f,f+n,{timeout:60000});assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);};
  const rpc=(step)=>page.evaluate(s=>__webEngineRPC('WebNaniteStreamingTest',s),step);
  await ready(1);
  for(const step of [1,2,3]){assert.equal(await rpc(step),1);await waitFrames(180);await rpc(0);await waitFrames(3);}
  await page.evaluate(()=>globalThis.__recoveryFixture=true);
  const before=await owner().evaluate(()=>__webNaniteStreamingTest);assert.equal(before.step,3);assert.equal(before.residentClusters,before.totalClusters);
  report.runs.push({generation:1,test:before,gpu:await owner().evaluate(()=>__recoveryGPU)});
  for(let generation=2;generation<=(repeatCrashes?3:2);generation++){
    const old=owner();let closed=false;old.on('close',()=>closed=true);
    const oldTargets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId);
    // Crash only this isolated test browser's GPU process. This exercises actual
    // device.lost("unknown"), without replacing the promise or faking notification.
    await cdp.send('Browser.crashGpuProcess');
    await ready(generation);await waitFrames(15);
    assert(closed,'old engine worker must terminate');assert.notEqual(owner(),old);
    const newTargets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId);
    assert(oldTargets.every(id=>!newTargets.includes(id)),'old nested workers must terminate');
    const test=await owner().evaluate(()=>__webNaniteStreamingTest),gpu=await owner().evaluate(()=>__recoveryGPU);
    assert.equal(test.step,3);assert.equal(test.residentClusters,test.totalClusters);assert.equal(test.cullState[1],0);
    assert.deepEqual(gpu.errors,[]);assert.equal(gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
    const restore=await page.evaluate(()=>__recoveryRestores.at(-1));
    assert.equal(restore.generation,generation);assert.equal(restore.actual.version,1);
    restore.actual.args.forEach((v,i)=>assert(Math.abs(v-restore.expected.args[i])<1e-3,`camera argument ${i}`));
    const ui=await page.evaluate(()=>({canvas:document.querySelectorAll('#canvas').length,hud:document.querySelectorAll('#web-performance-hud').length,loading:document.querySelector('#loading').hidden,state:__webEngineRecovery}));
    assert.equal(ui.canvas,1);assert.equal(ui.hud,1);assert(ui.loading);assert.equal(ui.state.attempts,generation-1);
    assert.equal(ui.state.events.filter(e=>e.kind==='device-lost').length,generation-1);
    assert(ui.state.events.filter(e=>e.kind==='device-lost').every(e=>e.reason==='unknown'));
    const inputBefore=await page.evaluate(()=>__webInputBridge.sent);
    await page.locator('#canvas').focus();await page.keyboard.press('w');await waitFrames(8);
    const inputAfter=await page.evaluate(()=>({...__webInputBridge}));assert(inputAfter.sent>=inputBefore+2,'replacement canvas must forward keyboard input');
    await page.setViewportSize({width:944,height:640});
    await page.waitForFunction(()=>globalThis.__webEngineSurface?.width===944,null,{timeout:30000});
    const resized=await page.evaluate(()=>__webEngineSurface);
    await page.setViewportSize({width:960,height:640});
    await page.waitForFunction(()=>globalThis.__webEngineSurface?.width===960,null,{timeout:30000});
    report.runs.push({generation,test,gpu,restore,ui,input:{before:inputBefore,after:inputAfter},resized,comparison:compare(before,test),oldWorkerCount:oldTargets.length,newWorkerCount:newTargets.length});
    console.log({generation,frames:await page.evaluate(()=>__webEngineFrames),covered:report.runs.at(-1).comparison.covered});
  }
  await cdp.send('Browser.crashGpuProcess');
  await page.waitForFunction(()=>globalThis.__webEngineRecovery.phase==='failed',null,{timeout:30000});
  report.limit=await page.evaluate(()=>({state:__webEngineRecovery,failure:__webEngineFailure,huds:document.querySelectorAll('#web-performance-hud').length}));
  assert.equal(report.limit.state.generation,3);assert.equal(report.limit.state.attempts,2);
  assert.match(report.limit.failure,repeatCrashes?/自动恢复已停止/:/P3_ENGINE_PREINIT_FAILED browser WebGPU device/);assert.equal(report.limit.huds,0);
  for(let i=0;i<300&&page.workers().some(w=>w.url().includes('web-engine-worker.js'));i++)await page.waitForTimeout(100);
  assert(!page.workers().some(w=>w.url().includes('web-engine-worker.js')),'terminal engine worker must close');
  assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({recovery:globalThis.__webEngineRecovery,failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(output,'browser'+(scalarVisibility?'-scalar':'')+(repeatCrashes?'-repeated':'')+'.json'),JSON.stringify(report,null,2));console.log({pass:report.pass,failure:report.failure});}})();
