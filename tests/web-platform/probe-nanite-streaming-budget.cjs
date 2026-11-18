'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalarVisibility=process.argv.includes('--scalar-visibility');
const spline=process.argv.includes('--spline');
const output=path.join(__dirname,spline?'results/nanite-spline-budget':'results/nanite-streaming-budget');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalarVisibility,spline,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),budgets:[],errors:[]};
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
const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
function compare(reference,test,budget){
  assert.equal(test.width,reference.width);assert.equal(test.height,reference.height);
  let covered=0,referenceCovered=0,core=0,missingCore=0,differentCoverage=0,maxDepthError=0;
  for(let y=0;y<test.height;y++)for(let x=0;x<test.width;x++){
    const i=(y*test.width+x)*12,a=!!reference.pixels[i],b=!!test.pixels[i];
    if(b)covered++;if(a)referenceCovered++;if(a!==b)differentCoverage++;
    const interior=a&&x>0&&y>0&&x+1<test.width&&y+1<test.height&&
      [-test.width,test.width,-1,1].every(d=>reference.pixels[i+d*12]);
    if(interior){core++;if(!b)missingCore++;}
    if(a&&b){maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(reference.pixels[i+1])-asFloat(test.pixels[i+1])));
      assert.equal(test.pixels[i+3],reference.pixels[i+3]);assert.equal(test.pixels[i+11],reference.pixels[i+11]);}
  }
  // The budget may be smaller than one fine-detail dependency group. Native
  // parent clusters must remain closed; only the silhouette may simplify.
  // Spline plus WPO changes the projected silhouette (585 resident samples).
  // Require a substantial interior relative to its own resident reference.
  if(spline){assert(referenceCovered>500);assert(core>referenceCovered*.75);}else assert(core>800);
  assert.equal(missingCore,0,'undersized page pools must retain closed parent geometry');
  assert(differentCoverage<=50);assert(maxDepthError<.002,'coarse sphere must remain close to resident geometry');
  if(budget>=11){assert.equal(differentCoverage,0);assert.equal(maxDepthError,0);assert.equal(test.residentClusters,test.totalClusters);}
  return {covered,referenceCovered,core,missingCore,differentCoverage,maxDepthError};
}
(async()=>{let context,page;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalarVisibility});\n`+await r.text()});});
  let budget=1;
  await context.route('**/nanite-browser/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('"-WebNaniteRootPages=2"',`"-WebNaniteRootPages=128","-WebNaniteStreamingPages=${budget}"`+(spline?',"-WebNaniteScene"':''))});});
  for(budget of [1,2,4,8,12]){
    page=await context.newPage();page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
    const current={budget,tests:[],logs:[]};report.budgets.push(current);
    page.on('console',m=>{const t=m.text();if(/GPU validation:|Fatal error:|Assertion failed|Command Line:|Nanite IO request/.test(t))current.logs.push(t);});
    await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    if(spline)assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteStreamingTest',-2)),1);
    for(let step=1;step<=9;step++){
      assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteStreamingTest',s),step),1);
      const start=Date.now();let test;
      do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
        await page.evaluate(()=>__webEngineRPC('WebNaniteStreamingTest',0));
        test=await owner.evaluate(()=>globalThis.__webNaniteStreamingTest||null);
      }while((!test||test.step!==step)&&Date.now()-start<90000);
      assert(test&&test.step===step);assert.equal(test.rejected,0);assert.equal(test.cullState[1],0);
      assert.equal(test.poolPages,budget);assert.equal(test.owners.length,budget);assert(test.cullState[0]>0);
      assert.equal(test.spline,spline);if(spline){assert(test.wpo&&test.evaluateWPO);assert.equal(test.splineParams.length,28);}
      assert(test.residentClusters<=test.totalClusters);
      current.tests.push(test);
      if([3,4,5,6,8,9].includes(step))test.comparison=compare(current.tests[1],test,budget);
    }
    assert.notEqual(current.tests[4].runtimeID,current.tests[5].runtimeID);
    if(budget<11)assert(current.tests[2].residentClusters<current.tests[2].totalClusters,'small pool must actually constrain residency');
    current.gpu=await owner.evaluate(()=>__budgetGPU);assert.deepEqual(current.gpu.errors,[]);
    assert.equal(current.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
    current.frames=await page.evaluate(()=>__webEngineFrames);await page.close();
    console.log({budget,frames:current.frames,comparisons:current.tests.filter(t=>t.comparison).map(t=>({step:t.step,...t.comparison}))});
  }
  assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(output,scalarVisibility?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
