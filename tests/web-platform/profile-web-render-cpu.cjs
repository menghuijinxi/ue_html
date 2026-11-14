'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder')||'nanite-core-scene',tag=option('tag');
const nanite=option('nanite');assert(nanite===undefined||nanite==='0'||nanite==='1');
assert(/^[a-z0-9-]+$/.test(folder)&&/^[a-z0-9-]+$/.test(tag));
// --thread=rhi samples the RHI thread (the WebGPU owner) instead of the rendering thread; output prefix follows the thread.
// --tour samples during the interior tour instead of the fixed room view.
const tour=process.argv.includes('--tour');
const thread=option('thread')||'render';assert(['render','rhi'].includes(thread));
// The WebGPU owner worker replays the RHI command stream; it is the thread the frame period follows.
const threadPattern=thread==='rhi'?/UEWebGPUStream::Stream::flush|FRHIThread::Run/:/FRenderingThread::Run|RenderingThreadMain/;
// Startup console variables, name=value, comma separated.
const cvars=(option('cvars')||'').split(',').filter(Boolean).map(v=>v.split('='));
assert(cvars.every(v=>v.length===2&&/^[A-Za-z0-9_.]+$/.test(v[0])&&/^-?[0-9.]+$/.test(v[1])));
const file=path.join(__dirname,'results',thread+'-cpu-'+tag),report={pass:false,thread,tour,cvars,source:audit(__filename),errors:[]};
const summarize=p=>{
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map(),self=new Map(),total=new Map();
 for(const n of p.nodes)for(const child of n.children||[])parents.set(child,n.id);
 for(let i=0;i<p.samples.length;i++){
  const id=p.samples[i],us=p.timeDeltas[i];self.set(id,(self.get(id)||0)+us);
  for(let n=id;n!==undefined;n=parents.get(n))total.set(n,(total.get(n)||0)+us);
 }
 const rank=m=>[...m].map(([id,us])=>({name:nodes.get(id).callFrame.functionName,milliseconds:us/1000})).sort((a,b)=>b.milliseconds-a.milliseconds).slice(0,60);
 return {self:rank(self),total:rank(total)};
};
(async()=>{let context;try{
 const packageFile=path.join(__dirname,'build',folder,'package.json'),pkg=JSON.parse(fs.readFileSync(packageFile));
 assert(pkg.pass);for(const p of pkg.products)assert.equal(audit(p.file).sha256,p.sha256,p.file);report.package=audit(packageFile);
 context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/cpu-villa'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
 if(nanite!==undefined||cvars.length)await context.route('**/config-files.json*',async route=>{const response=await route.fetch(),files=await response.json();
  const f=files.find(x=>x.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(f);
  const data=Buffer.from(Buffer.from(f.data,'base64').toString()+'\n[SystemSettings]\n'+(nanite===undefined?'':'r.Nanite='+Number(nanite)+'\n')+cvars.map(v=>v.join('=')+'\n').join(''));
  f.data=data.toString('base64');f.sha256=require('node:crypto').createHash('sha256').update(data).digest('hex');if(nanite!==undefined)report.nanite=Number(nanite);
  await route.fulfill({response,body:JSON.stringify(files)});});
 const page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html',{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>100,null,{timeout:900000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 report.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock||null);assert(!report.clock?.renderTimeFrozen&&!report.clock?.materialTimeFrozen);
 if(!tour)assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
 const initial=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+240,initial,{timeout:120000});
 const cdp=await context.browser().newBrowserCDPSession(),pending=new Map();let id=0;
 cdp.on('Target.receivedMessageFromTarget',event=>{const m=JSON.parse(event.message),task=pending.get(m.id);if(task){pending.delete(m.id);m.error?task.reject(Error(JSON.stringify(m.error))):task.resolve(m.result);}});
 const command=(sessionId,method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});
  cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:key,method,params})}).catch(reject);});
 const targets=(await cdp.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker'),sessions=[];
 for(const target of targets){const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});sessions.push({target,sessionId});}
 await Promise.all(sessions.map(async s=>{await command(s.sessionId,'Profiler.enable');await command(s.sessionId,'Profiler.setSamplingInterval',{interval:1000});await command(s.sessionId,'Profiler.start');}));
 await page.waitForTimeout(2000);
 report.discovery=[];let render;
 for(const s of sessions){const {profile}=await command(s.sessionId,'Profiler.stop');const names=profile.nodes.map(n=>n.callFrame.functionName);
  const matches=names.filter(n=>threadPattern.test(n));
  report.discovery.push({target:s.target,matches,samples:profile.samples.length,top:summarize(profile).self.slice(0,3)});
  if(matches.length){assert(!render,'More than one matching thread');render=s;}
 }
 assert(render,'The sampled thread must actually execute the requested UE thread loop');report.target=render.target;
 for(const s of sessions)if(s!==render)await cdp.send('Target.detachFromTarget',{sessionId:s.sessionId});
 const state=()=>page.evaluate(()=>({frames:__webEngineFrames,time:performance.now(),stages:__webThreadStages}));
 // One warm-up lap first, so the sampled lap has no first-visit work.
 if(tour){for(let lap=0;lap<2;lap++){const serial=await page.evaluate(()=>__webEngineRPC('WebMotionBenchmarkControl',3,30));assert(serial>0);
   if(lap===0)await page.waitForFunction(s=>globalThis.__webMotionBenchmark?.serial===s&&globalThis.__webMotionBenchmark.completed&&!globalThis.__webMotionBenchmark.active,serial,{timeout:90000});}}
 const baseline=await state();await page.waitForTimeout(5000);const baselineAfter=await state();
 report.baselineFPS=(baselineAfter.frames-baseline.frames)*1000/(baselineAfter.time-baseline.time);
 await command(render.sessionId,'Profiler.setSamplingInterval',{interval:500});
 const before=await state();await command(render.sessionId,'Profiler.start');await page.waitForTimeout(12000);
 const {profile}=await command(render.sessionId,'Profiler.stop'),after=await state();
 fs.writeFileSync(file+'.cpuprofile',JSON.stringify(profile));report.raw=audit(file+'.cpuprofile');
 report.profile=summarize(profile);report.before=before;report.after=after;report.sampledFPS=(after.frames-before.frames)*1000/(after.time-before.time);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);}finally{await context?.close();fs.writeFileSync(file+'.json',JSON.stringify(report,null,2));console.log({pass:report.pass,baselineFPS:report.baselineFPS,file});}})();
