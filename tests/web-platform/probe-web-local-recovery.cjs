'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit,metadata}=require('./content-file-metadata.cjs');
const baseline=process.argv.includes('--baseline');
const stale=process.argv.includes('--stale');
const workerFile=path.join(__dirname,baseline?(stale?'results/nanite-assembly/failure-opfs-invalid-state/web-content-worker.js':
 'results/nanite-gpu-instances/failure-opfs-not-found/web-content-worker.js'):'web-content-worker.js');
const source=fs.readFileSync(workerFile,'utf8');
const fixture=path.join(__dirname,'results/local-recovery-fixture.bin'),bytes=Buffer.alloc(1024*1024+19);
for(let i=0;i<bytes.length;i++)bytes[i]=(i*37+(i>>>12))&255;
fs.writeFileSync(fixture,bytes);const info=metadata(fixture,'results/local-recovery-fixture.bin');
const report={pass:false,baseline,stale,source:audit(__filename),worker:audit(workerFile),fixture:audit(fixture),cases:[]};
(async()=>{let browser;try{
 browser=await chromium.launch({channel:'msedge',headless:true});
 for(const scenario of stale?['stale-lease','stale-directory','stale-write','stale-marker',...(!baseline?['stale-repeated']:[])]:
  baseline?['file-lease']:['file-lease','directory','repeated','non-missing']){
  const context=await browser.newContext(),page=await context.newPage();
  await page.route('**/local-recovery-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Storage handle recovery</title>'}));
  const injection=`
   const recoveryTarget=${JSON.stringify(info.sha256)},recoveryScenario=${JSON.stringify(scenario)};
   let recoveryReads=0,recoveryFailures=0;
   const recoveryStale=recoveryScenario.startsWith('stale-');
   if(recoveryStale){
    const originalGetFile=FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile=async function(...args){
     if(this.name===recoveryTarget+'.bin'&&['stale-lease','stale-repeated'].includes(recoveryScenario)&&++recoveryReads>=2&&
       (recoveryFailures===0||recoveryScenario==='stale-repeated')){
      ++recoveryFailures;throw new DOMException('Injected stale file snapshot','InvalidStateError');
     }
     return originalGetFile.apply(this,args);
    };
    const originalWritable=FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable=async function(...args){
     const stream=await originalWritable.apply(this,args),write=stream.write.bind(stream);
     const target=this.name===recoveryTarget+(recoveryScenario==='stale-marker'?'.json':'.bin');
     stream.write=async(...values)=>{
      if(target&&['stale-write','stale-marker'].includes(recoveryScenario)&&recoveryFailures===0){
       ++recoveryFailures;throw new DOMException('Injected stale writable handle','InvalidStateError');
      }
      return write(...values);
     };
     return stream;
    };
   }
   const recoveryGetFile=FileSystemDirectoryHandle.prototype.getFileHandle;
   FileSystemDirectoryHandle.prototype.getFileHandle=async function(name,options){
    if(this.name==='ue-web-local-v1'&&name===recoveryTarget+'.bin'){
     if(recoveryScenario==='stale-directory'&&options?.create&&recoveryFailures===0){
      ++recoveryFailures;throw new DOMException('Injected stale directory handle','InvalidStateError');
     }else if(recoveryScenario==='directory'&&options?.create&&recoveryFailures===0){
      ++recoveryFailures;
      await (await navigator.storage.getDirectory()).removeEntry('ue-web-local-v1',{recursive:true});
     }else if(!recoveryStale&&!options?.create&&++recoveryReads>=2&&
       (recoveryFailures===0||recoveryScenario==='repeated')){
      if(recoveryScenario==='non-missing'){
       ++recoveryFailures;throw new DOMException('Injected permission failure','NotAllowedError');
      }
      try{await this.removeEntry(name);++recoveryFailures;}catch(e){if(e.name!=='NotFoundError')throw e;}
     }
    }
    return recoveryGetFile.call(this,name,options);
   };
  `;
  await page.route('**/recovery-worker.js',route=>route.fulfill({contentType:'text/javascript',body:injection+source}));
  await page.goto('http://127.0.0.1:8765/local-recovery-test');
  await page.addScriptTag({url:'http://127.0.0.1:8765/web-content-io.js'});
  const result=await page.evaluate(async({info,scenario})=>{
   if(!['directory','stale-directory','stale-write','stale-marker'].includes(scenario)){
    const root=await (await navigator.storage.getDirectory()).getDirectoryHandle('ue-web-local-v1',{create:true});
    const write=async(name,value)=>{const stream=await (await root.getFileHandle(name,{create:true})).createWritable();await stream.write(value);await stream.close();};
    await write(info.sha256+'.bin',await (await fetch('/'+info.url)).arrayBuffer());
    await write(info.sha256+'.json',JSON.stringify({sha256:info.sha256,size:info.size,verification:'full',used:Date.now()}));
   }
   const io=new WebLocalContentIO('/recovery-worker.js',{verification:'full'});
   const requests=await Promise.allSettled([io.asset(info),io.asset(info)]);
   const errors=requests.map(r=>r.status==='rejected'?r.reason.message:null);
   let valid=false;
   if(requests[0].status==='fulfilled'){
    const data=new Uint8Array(await requests[0].value.arrayBuffer());
    valid=data.length===info.size&&data.every((v,i)=>v===((i*37+(i>>>12))&255));
   }
   const stats={...io.stats};io.worker.terminate();return {errors,valid,stats};
  },{info,scenario});
  report.cases.push({scenario,...result});
  if(baseline){assert(result.errors.every(Boolean));assert(!result.valid);}
  else if(scenario==='stale-repeated'){
   assert(result.errors.every(e=>e?.includes('InvalidStateError')));assert(!result.valid);
   assert.equal(result.stats.staleHandleRetries,1);assert.equal(result.stats.missingFileRetries,0);
  }else if(stale){
   assert.deepEqual(result.errors,[null,null]);assert(result.valid);assert.equal(result.stats.staleHandleRetries,1);
   assert.equal(result.stats.missingFileRetries,0);assert.equal(result.stats.downloads,scenario==='stale-lease'?0:1);
  }else if(scenario==='repeated'||scenario==='non-missing'){
   assert(result.errors.every(Boolean));assert(!result.valid);
   assert.equal(result.stats.missingFileRetries,scenario==='repeated'?1:0);
   assert(result.errors.every(e=>e.includes(scenario==='repeated'?'NotFoundError':'NotAllowedError')));
  }else{assert.deepEqual(result.errors,[null,null]);assert(result.valid);assert.equal(result.stats.missingFileRetries,1);assert.equal(result.stats.downloads,1);}
  console.log({scenario,valid:result.valid,retries:result.stats.missingFileRetries,staleRetries:result.stats.staleHandleRetries,errors:result.errors});
  await context.close();
 }
 report.pass=true;
}catch(error){report.failure=error.stack;console.error(error.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(__dirname,'results/local-'+(stale?'stale-':'')+'recovery'+(baseline?'-baseline':'')+'.json'),JSON.stringify(report,null,2)+'\n');}})();
