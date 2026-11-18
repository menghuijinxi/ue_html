'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const compare=require('./verify-nanite-budget-coverage.cjs');
const scalarVisibility=process.argv.includes('--scalar-visibility');
const skinning=true;
const output=path.join(__dirname,'results/nanite-skinning-budget');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalarVisibility,skinning,source:audit(__filename),verifier:audit(require.resolve('./verify-nanite-budget-coverage.cjs')),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),budgets:[],errors:[]};
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__budgetGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__budgetGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__budgetGPU.errors.push(e.error.message));
    device.lost.then(info=>__budgetGPU.errors.push(info.message));return device;
  };
}
(async()=>{let context,page;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalarVisibility});\n`+await r.text()});});
  let budget=1;
  await context.route('**/nanite-browser/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('"-WebNaniteRootPages=2"',`"-WebNaniteRootPages=128","-WebNaniteStreamingPages=${budget}"`+(skinning?',"-WebNaniteScene"':''))});});
  for(budget of [1,2,4,8,24]){
    page=await context.newPage();page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
    const current={budget,tests:[],logs:[]};report.budgets.push(current);
    page.on('console',m=>{const t=m.text();if(/GPU validation:|Fatal error:|Assertion failed|Command Line:|Nanite IO request/.test(t))current.logs.push(t);});
    await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    for(let step=1;step<=9;step++){
      assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteSkinningStreamingTest',s),step),1);
      const start=Date.now();let test;
      do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
        await page.evaluate(()=>__webEngineRPC('WebNaniteSkinningStreamingTest',0));
        test=await owner.evaluate(()=>globalThis.__webNaniteSkinningStreamingTest||null);
      }while((!test||test.step!==step)&&Date.now()-start<90000);
      assert(test&&test.step===step);assert.equal(test.rejected,0);assert.equal(test.cullState[1],0);
      assert.equal(test.poolPages,budget);assert.equal(test.owners.length,budget);assert(test.cullState[0]>0);
      assert.equal(test.skinning,skinning);if(skinning){assert(test.wpo&&test.evaluateWPO);assert.equal(test.bones.length,2);}
      assert(test.residentClusters<=test.totalClusters);
      current.tests.push(test);
      if([3,4,5,6,8,9].includes(step))test.comparison=compare(current.tests[1],test,budget);
    }
    assert.notEqual(current.tests[4].runtimeID,current.tests[5].runtimeID);
    if(budget<current.tests[2].totalPages-current.tests[2].rootPages)assert(current.tests[2].residentClusters<current.tests[2].totalClusters,'small pool must actually constrain residency');
    current.gpu=await owner.evaluate(()=>__budgetGPU);assert.deepEqual(current.gpu.errors,[]);
    assert.equal(current.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
    current.frames=await page.evaluate(()=>__webEngineFrames);await page.close();
    console.log({budget,frames:current.frames,comparisons:current.tests.filter(t=>t.comparison).map(t=>({step:t.step,...t.comparison}))});
  }
  assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(output,scalarVisibility?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
