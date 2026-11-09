'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const verify=require('./verify-nanite-scene-hzb.cjs');
const output=path.join(__dirname,'results/nanite-scene-hzb');fs.mkdirSync(output,{recursive:true});
const report={pass:false,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
(async()=>{let browser,page;try {
 browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
 page=await browser.newPage();page.on('console',m=>{const text=m.text();report.logs.push(text);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(text))report.errors.push(text);});
 page.on('pageerror',e=>report.errors.push(e.stack));
 await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 for(let step=1;step<=9;step++) {
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteHZBTest',s),step),1);
  let test;const start=Date.now();
  do {await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteHZBTest',0)),1);test=await owner.evaluate(()=>globalThis.__webNaniteHZBTest||null);}
  while((!test||test.step!==step)&&Date.now()-start<90000);assert(test&&test.step===step);
  report.tests.push(test);test.validation=verify(test);console.log({step,...test.validation});
 }
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteHZBTest',10)),1);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.engineFailure=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2));}})();
