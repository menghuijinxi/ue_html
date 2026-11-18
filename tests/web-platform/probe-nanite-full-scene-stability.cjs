'use strict';
// Diagnose stationary image changes independently of the native acceptance run.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {chromium}=require('playwright'),{PNG}=require('pngjs'),{audit}=require('./content-file-metadata.cjs');
const freeze=process.argv.includes('--freeze'),noAA=process.argv.includes('--no-aa'),noAO=process.argv.includes('--no-ao');
const noAOJitter=process.argv.includes('--no-ao-jitter');
const name=noAOJitter?'no-ao-jitter':noAO?'no-ao':freeze?'frozen-sequences':noAA?'no-aa':'normal';
const dir=path.join(__dirname,'results/nanite-full-scene-stability',name);fs.mkdirSync(dir,{recursive:true});
const report={pass:false,source:audit(__filename),freeze,noAA,noAO,noAOJitter,errors:[],samples:[],configs:[]};
function diff(a,b){const v=[];for(let i=0;i<a.width*a.height;i++){let d=0;for(let c=0;c<3;c++)d+=Math.abs(a.data[i*4+c]-b.data[i*4+c]);v.push(d/3);}v.sort((a,b)=>a-b);return {mean:v.reduce((a,b)=>a+b,0)/v.length,p95:v[Math.floor(v.length*.95)],max:v.at(-1)};}
(async()=>{let context;try{
 context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
 await context.route('**/nanite-full-scene/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebVisualTestClock",')});});
 if(freeze||noAOJitter)await context.route('**/config-files.json*',async route=>{
  const r=await route.fetch(),files=await r.json();
  const file=files.find(f=>f.path.endsWith('/UEWebEngine/Config/DefaultEngine.ini'));assert(file);
  const text=Buffer.from(file.data,'base64').toString('utf8')+'\n[SystemSettings]\n'+
   (freeze?'r.Test.FreezeTemporalSequences=1\n':'')+(noAOJitter?'r.AOUseJitter=0\n':'');
  const data=Buffer.from(text);file.data=data.toString('base64');file.sha256=crypto.createHash('sha256').update(data).digest('hex');report.configs.push({path:file.path,sha256:file.sha256,text});
  await route.fulfill({response:r,body:JSON.stringify(files)});
 });
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack));page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/build/nanite-full-scene/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBoundsTest',1,0,1)),1);
 if(noAA)assert.equal(await page.evaluate(()=>__webEngineRPC('WebLightingQualityTest',0,0)),1);
 if(noAO)assert.equal(await page.evaluate(()=>__webEngineRPC('WebLightingQualityTest',7,0)),1);
 await page.addStyleTag({content:'body > :not(canvas) { visibility: hidden !important; } canvas, canvas * { visibility: visible !important; }'});
 let previous,first;
 for(const step of noAA||noAO||noAOJitter?[1]:[1,2,3]){
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
  const start=Date.now();let test;
  do {await page.waitForTimeout(250);await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));test=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);}while((!test||test.step!==step)&&Date.now()-start<120000);
  assert(test?.step===step);
  for(let sample=0;sample<6;sample++){
   const frame=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+120,frame,{timeout:120000});
   const file=path.join(dir,`${step}-${sample}.png`),bytes=await page.locator('canvas').screenshot({path:file}),img=PNG.sync.read(bytes);
   const data={step,sample,image:audit(file),frame:await page.evaluate(()=>__webEngineFrames),state:await owner.evaluate(()=>({clock:globalThis.__webVisualTestClock,streaming:globalThis.__webTextureStreaming})),
    previous:previous?diff(previous,img):null,first:first?diff(first,img):null};
   report.samples.push(data);console.log(data);previous=img;first??=img;
   fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));assert.deepEqual(report.errors,[]);
  }
 }
 report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}finally{await context?.close();fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2)+'\n');}})();
