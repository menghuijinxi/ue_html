'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const tag=process.argv[2];assert(tag&&/^[a-z0-9-]+$/.test(tag));const output=path.join(__dirname,'results',tag+'.json');assert(!fs.existsSync(output));
const build=path.join(__dirname,'build/allocator-contract');
const report={pass:false,source:audit(__filename),sources:['allocator-contract.cpp','rhi-isolation-common.h','draw-api-common.h','build-allocator-contract.ps1'].map(n=>audit(path.join(__dirname,n))),products:fs.readdirSync(build).map(n=>audit(path.join(build,n))),runs:[],boundary:'Stock SDK allocator contract and same synthetic CPU preparation only. No UE or GPU. Alternating allocator order; identical source/options except allocator selection. Unlike the UE candidate, stock mimalloc owns global C++ new/delete here. No real UE frame gain inferred.'};
(async()=>{let context;try{
 context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag),{channel:'msedge',headless:false,viewport:{width:640,height:480}});
 const page=context.pages()[0];await page.goto('http://127.0.0.1:8765/rhi-isolation.html');report.browser=context.browser().version();
 for(const allocator of ['dlmalloc','mimalloc','mimalloc','dlmalloc']){
  const started=new Date().toISOString();const result=await page.evaluate(allocator=>new Promise((resolve,reject)=>{
   const script=new URL('build/allocator-contract/'+allocator+'.js',location.href).href;
   const blob=new Blob(['var mainScript='+JSON.stringify(script)+';var Module={mainScriptUrlOrBlob:mainScript,locateFile:function(name){return new URL(name,mainScript).href;}};importScripts(mainScript);'],{type:'application/javascript'}),url=URL.createObjectURL(blob),worker=new Worker(url);
   const timer=setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);reject(Error('Allocator timeout'));},120000);
   const close=()=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);};worker.onerror=e=>{close();reject(Error(e.message));};
   worker.onmessage=({data})=>{if(data.error){close();reject(Error(data.error));}if(data.result){close();resolve(data.result);}};
  }),allocator);
  assert(result.pass&&result.contractPassed&&result.cpu.length===18);const sums=new Set(result.cpu.map(x=>x.checksum));assert.equal(sums.size,1);if(report.runs.length)assert.equal(result.cpu[0].checksum,report.runs[0].cpu[0].checksum);
  report.runs.push({allocator,started,ended:new Date().toISOString(),...result});console.log(JSON.stringify({allocator,cpu:result.cpu.filter(x=>x.workers===4).map(x=>({mode:x.mode,medianMs:x.wall.medianMs}))}));
 }report.pass=true;
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack);}finally{await context?.close();fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');}})();
