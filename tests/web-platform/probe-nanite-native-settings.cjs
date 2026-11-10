'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const file=path.join(__dirname,'results/nanite-full-scene-native/browser-settings.json');
const report={pass:false,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-full-scene/package.json')),errors:[]};
(async()=>{let context;try{
 context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/build/nanite-full-scene/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebLightingQualityTest',-1,0)),1);
 await page.waitForTimeout(300);
 report.settings=await owner.evaluate(()=>({lighting:globalThis.__webDistanceFieldsLighting,defaults:globalThis.__webProjectSettings}));
 assert(report.settings.lighting);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}finally{await context?.close();fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(report);}})();
