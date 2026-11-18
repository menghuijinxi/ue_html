'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const verify=require('./verify-nanite-scene-hzb.cjs');
const scalar=process.argv.includes('--scalar-visibility'),legacy=process.argv.includes('--legacy-occlusion');
const output=path.join(__dirname,'results/nanite-scene-hzb');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalar,legacy,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
function observe(scalar){
 const request=GPUAdapter.prototype.requestDevice;globalThis.__sceneHZBGPU={errors:[]};
 GPUAdapter.prototype.requestDevice=async function(d){
  if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);__sceneHZBGPU.features=[...device.features];
  device.addEventListener('uncapturederror',e=>__sceneHZBGPU.errors.push(e.error.message));return device;
 };
}
(async()=>{let browser,page;try {
 browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
 await browser.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
 page=await browser.newPage();page.on('console',m=>{const text=m.text();report.logs.push(text);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(text))report.errors.push(text);});
 page.on('pageerror',e=>report.errors.push(e.stack));
 await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteOcclusionModeTest',s),legacy?0:1),1);
 for(let step=1;step<=9;step++) {
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteHZBTest',s),step),1);
  let test;const start=Date.now();
  do {await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteHZBTest',0)),1);test=await owner.evaluate(()=>globalThis.__webNaniteHZBTest||null);}
  while((!test||test.step!==step)&&Date.now()-start<90000);assert(test&&test.step===step);
  report.tests.push(test);test.validation=verify(test);console.log({step,...test.validation});
 }
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteHZBTest',10)),1);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteOcclusionModeTest',-1)),1);
 report.gpu=await owner.evaluate(()=>__sceneHZBGPU);assert.deepEqual(report.gpu.errors,[]);
 assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
 report.frames=await page.evaluate(()=>__webEngineFrames);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.engineFailure=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,`verified${scalar?'-scalar':''}${legacy?'-legacy':''}.json`),JSON.stringify(report,null,2));}})();
