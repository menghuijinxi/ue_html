'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const tag=option('tag'),rounds=Number(option('rounds')||3),only=option('only');assert(tag&&/^[a-z0-9-]+$/.test(tag)&&rounds>=1&&rounds<=3);
const output=path.join(__dirname,'results',tag),build=path.join(__dirname,'build/rhi-isolation');assert(!fs.existsSync(output+'.json'));
const names=['rhi-isolation-common.h','rhi-isolation-webgpu.cpp','rhi-isolation-d3d12.cpp','draw-api-common.h','draw-api-webgpu.cpp','draw-api-d3d12.cpp','rhi-isolation-worker.js','rhi-isolation-js-worker.js','rhi-isolation.html','build-rhi-isolation.ps1','benchmark-rhi-isolation.cjs'];
const report={date:new Date().toISOString(),pass:false,tag,rounds,runs:[],sources:names.map(n=>audit(path.join(__dirname,n))),products:fs.readdirSync(build).map(n=>audit(path.join(build,n))),cpu:os.cpus()[0].model,logicalCores:os.cpus().length,
 boundary:'No UE linked. Preparation model follows key/version/route work but excludes UE JSON, containers, barriers and lifetime; synthetic lock is an upper-bound stress case, not evidence of UE lock ownership. Four-list DX12 recording is supported; WebGPU uses one device owner with parallel CPU preparation. CPU times and GPU queue waits kept separate; no present/vsync. No performance claim from debug runs.'};
function native(kind,file){return new Promise((resolve,reject)=>{const fd=fs.openSync(file+'.log','w'),child=spawn(path.join(build,kind==='dx12'?'rhi_isolation_d3d12.exe':'rhi_isolation_dawn.exe'),[file],{windowsHide:true,stdio:['ignore',fd,fd]});const timer=setTimeout(()=>child.kill(),300000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timer);fs.closeSync(fd);if(code!==0)reject(Error(kind+' exit '+code));else resolve(JSON.parse(fs.readFileSync(file)));});});}
(async()=>{try{
 for(let round=0;round<rounds;round++)for(const kind of round%2?['js','simd','scalar','dawn','dx12']:['dx12','dawn','scalar','simd','js']){
  if(only&&only!==kind)continue;console.log('Isolation start',round,kind);const started=new Date().toISOString(),file=output+`-r${round}-${kind}.json`;let result;
  if(['dx12','dawn'].includes(kind))result=await native(kind,file);
  else{
   const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',`${tag}-${round}-${kind}`),{channel:'msedge',headless:false,viewport:{width:640,height:480}});
   try{const page=context.pages()[0];const logs=[];page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>logs.push(e.stack));await page.goto('http://127.0.0.1:8765/rhi-isolation.html');await page.bringToFront();
    const cdp=await context.newCDPSession(page);report.browser=await cdp.send('Browser.getVersion');
    result=await page.evaluate(v=>Promise.race([runIsolation(v),new Promise((_,reject)=>setTimeout(()=>reject(Error('Isolation timeout')),300000))]),kind);result.logs=logs;
   }finally{await context.close();}
  }
  if(kind==='js')assert(result.pass&&result.cases.length===3&&result.cases.every(x=>x.pixelVerified));
  else{
   assert(result.pass&&result.cpu.length===18&&result.render.length===4&&result.render.every(x=>x.pixelVerified)&&result.stateTracking.length===2&&result.stateTracking.every(x=>x.pixelVerified));
   const checksums=new Set([...result.cpu,...result.render].map(x=>x.checksum));assert.equal(checksums.size,1);const previous=report.runs.find(x=>x.cpu);if(previous)assert.equal([...checksums][0],previous.cpu[0].checksum);
  }
  result.kind=kind;result.round=round;result.started=started;result.ended=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(result,null,2));report.runs.push(result);fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({kind,cpu:result.cpu?.filter(x=>x.workers===4).map(x=>({mode:x.mode,ms:x.wall.medianMs})),render:(result.render||result.cases).map(x=>({mode:x.mode,wall:x.wallMsPerFrame,encode:x.encode.medianMs}))}));
 }
 report.pass=true;
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);}finally{fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));}})();
