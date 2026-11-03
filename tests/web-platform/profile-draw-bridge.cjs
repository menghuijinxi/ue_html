'use strict';
const fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
(async()=>{
 const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/draw-bridge-profile'),{channel:'msedge',headless:false});
 try{
  await context.route('**/draw-api-benchmark.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replaceAll('worker.terminate();','')});});
  await context.route('**/draw-api-wasm-worker.js',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('importScripts(', 'globalThis.__startProfile=()=>importScripts(')});});
  const page=context.pages()[0];await page.goto('http://127.0.0.1:8765/draw-api-benchmark.html');
  const ready=page.waitForEvent('worker'),result=page.evaluate(()=>runDrawBenchmark('wasm'));result.catch(()=>{});const worker=await ready;
  while(!await worker.evaluate(()=>!!globalThis.__startProfile))await new Promise(resolve=>setTimeout(resolve,20));
  const cdp=await context.browser().newBrowserCDPSession(),targets=await cdp.send('Target.getTargets');
  const t=targets.targetInfos.find(t=>t.type==='worker'&&t.url.includes('draw-api-wasm-worker'));
  const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:t.targetId,flatten:false});
  let id=0;const pending=new Map();
  cdp.on('Target.receivedMessageFromTarget',e=>{const m=JSON.parse(e.message),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const command=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:key,method,params})}).catch(reject);});
  await command('Profiler.enable');await command('Profiler.setSamplingInterval',{interval:100});await command('Profiler.start');
  await worker.evaluate(()=>__startProfile());await result;const {profile}=await command('Profiler.stop');
  fs.writeFileSync(path.join(__dirname,'results/draw-bridge-stream.cpuprofile'),JSON.stringify(profile));
  const nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map();for(const n of profile.nodes)for(const c of n.children||[])parents.set(c,n.id);
  const self=new Map(),inclusive=new Map();for(let i=0;i<profile.samples.length;i++){let n=profile.samples[i],us=profile.timeDeltas[i];self.set(n,(self.get(n)||0)+us);while(n!==undefined){inclusive.set(n,(inclusive.get(n)||0)+us);n=parents.get(n);}}
  for(const [label,map]of [['self',self],['inclusive',inclusive]])console.log(label,[...map].map(([id,us])=>({name:nodes.get(id).callFrame.functionName,ms:us/1000})).sort((a,b)=>b.ms-a.ms).slice(0,30));
 }finally{await context.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
