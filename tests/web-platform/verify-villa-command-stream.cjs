'use strict';
// Separate correctness run: move the view, do not mix these frames into A/B FPS.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder'),tag=option('tag');assert([folder,tag].every(v=>v&&/^[a-z0-9-]+$/.test(v)));
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output+'.json'));
const runtime=fs.readdirSync(path.join(__dirname,'build',folder)).filter(n=>/^UEWebEngineThreads\w*\.wasm$/.test(n));assert.equal(runtime.length,1);
const report={date:new Date().toISOString(),folder,pass:false,errors:[],views:[],source:audit(__filename),
 packageFiles:['index.html',runtime[0].replace(/\.wasm$/,'.js'),runtime[0],'config-files.json','content-files.json'].map(n=>audit(path.join(__dirname,'build',folder,n))),
 boundary:'Correctness only. Default package, full threading, project quality settings. Camera is moved by the existing UE view diagnostic RPC; no FPS claim or CPU profiler.'};
let context;
async function captureOwner(){
 const cdp=await context.browser().newBrowserCDPSession(),{targetInfos}=await cdp.send('Target.getTargets');
 const target=targetInfos.find(t=>t.type==='worker'&&t.url.includes('web-engine-worker.js'));assert(target);
 const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
 let id=0;const pending=new Map();cdp.on('Target.receivedMessageFromTarget',e=>{const m=JSON.parse(e.message),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
 const command=(method,params={})=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:key,method,params})}).catch(reject);});
 await command('Profiler.enable');await command('Profiler.start');await new Promise(resolve=>setTimeout(resolve,6000));const {profile}=await command('Profiler.stop');
 const prefix=output+'-owner';fs.writeFileSync(prefix+'-0.cpuprofile',JSON.stringify(profile));fs.writeFileSync(prefix+'-targets.json',JSON.stringify([{target,sessionId}]));await cdp.detach();report.profile=prefix;
}
(async()=>{try{
 context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',tag),{channel:'msedge',headless:false,viewport:{width:2289,height:1287},deviceScaleFactor:1});
 const page=context.pages()[0],input=await context.newCDPSession(page);await input.send('Input.setIgnoreInputEvents',{ignore:true});await input.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 const log=fs.createWriteStream(output+'.log');
 page.on('console',m=>{const text=m.text();log.write(text+'\n');if(text.includes('WebGPU command stream: enabled'))report.streamConfirmed=true;
  if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|P3_ENGINE_PREINIT_FAILED|P3_ENGINE_INIT_FAILED|thread pool is exhausted|Failed to create thread/i.test(text))report.errors.push(text);});
 page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=150,null,{timeout:120000});
 assert(!await page.evaluate(()=>globalThis.__webEngineFailure));assert(report.streamConfirmed);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 const state=()=>owner.evaluate(()=>({frames:__webRHIFrames,camera:__webDefaultCamera,settings:__webProjectSettings,view:__webRenderView,handles:globalThis.__webGPUHandleDiagnostics,memory:__webTextureStreaming}));
 report.before=await state();const camera=report.before.camera;assert(camera);
 // Sweep both visibility and streaming demand; returning to spawn also tests
 // that the stream does not retain stale pipeline/binding state across passes.
 for(const [dx,dy,dz,yaw] of [[0,0,0,90],[150,0,0,180],[0,150,50,270],[-150,0,0,360],[0,-150,50,45],[0,0,0,0]]){
  const target=[camera.x+dx,camera.y+dy,camera.z+dz,camera.pitch,camera.yaw+yaw];
  assert.equal(await page.evaluate(args=>__webEngineRPC('WebProjectViewTest',...args),target),1);
  const start=(await state()).frames;await page.waitForTimeout(2500);const after=await state();assert(after.frames>start+20,'Rendering stopped after camera move');
  assert.deepEqual(after.settings,report.before.settings);report.views.push({target,...after});
 }
 report.after=await state();assert.equal(report.errors.length,0,report.errors.join('\n'));
 await page.locator('canvas').screenshot({path:output+'.png'});
 report.page=await page.evaluate(()=>({visibility:document.visibilityState,focused:document.hasFocus(),
  performance:globalThis.__webLivePerformance,userAgent:navigator.userAgent}));
 if(process.argv.includes('--profile-owner'))await captureOwner();
 assert.equal(report.errors.length,0);report.pass=true;log.end();
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error.stack);
 // Preserve heap size and progress when a candidate fails during startup.
 try{const owner=pageOwner();report.failureState=await Promise.race([owner.evaluate(()=>({
  frames:globalThis.__webRHIFrames,threads:globalThis.__webEngineThreads,
  heapBytes:typeof HEAPU8!=='undefined'?HEAPU8.length:null,memory:globalThis.__webTextureStreaming
 })),new Promise(resolve=>setTimeout(()=>resolve({unavailable:'Worker did not respond after failure'}),1500))]);}
 catch(capture){report.failureState={unavailable:capture.message};}
}
finally{await context?.close();fs.writeFileSync(output+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,views:report.views.length,errors:report.errors}));}})();

function pageOwner(){const owner=context?.pages()[0]?.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);return owner;}
