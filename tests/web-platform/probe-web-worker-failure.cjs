'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const report={pass:false,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],pageErrors:[],logs:[]};
(async()=>{let context,page;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  for(const kind of ['error','rejection']){
    page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push({name:e.name,message:e.message}));
    page.on('console',m=>{report.logs.push(m.text());if(report.logs.length>240)report.logs.shift();});
    await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    const worker=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(worker);
    await worker.evaluate(kind=>setTimeout(()=>{
      if(kind==='error')throw new Error('Injected engine worker failure');
      // Same DOMException as a lost device, but with no device-lost event.
      Promise.reject(new DOMException('A valid external Instance reference no longer exists.','OperationError'));
    },10),kind);
    await page.waitForFunction(()=>globalThis.__webEngineRecovery?.phase==='failed',null,{timeout:30000});
    const result=await page.evaluate(()=>({failure:__webEngineFailure,recovery:__webEngineRecovery,huds:document.querySelectorAll('#web-performance-hud').length}));
    assert.match(result.failure,kind==='error'?/Injected engine worker failure/:/A valid external Instance reference no longer exists/);
    assert.equal(result.recovery.attempts,0);assert.equal(result.recovery.generation,1);assert.equal(result.huds,0);
    for(let i=0;i<300&&page.workers().some(w=>w.url().includes('web-engine-worker.js'));i++)await page.waitForTimeout(100);
    assert(!page.workers().some(w=>w.url().includes('web-engine-worker.js')));
    report.tests.push({kind,...result});await page.close();console.log({kind,pass:true});
  }
  assert.deepEqual(report.pageErrors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,
    recovery:globalThis.__webEngineRecovery,startup:globalThis.__webStartupDiagnostics,runtime:globalThis.__webEngineRuntime,
    threads:globalThis.__webThreadStages,io:globalThis.__webLocalContentStats,pso:globalThis.__webPSOPrecache})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(__dirname,'results/nanite-device-recovery/ordinary-errors.json'),JSON.stringify(report,null,2));}})();
