'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const [folder,tag,expectation]=process.argv.slice(2);assert([folder,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
assert(['before','fixed'].includes(expectation));
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);fs.copyFileSync(__filename,path.join(output,'source.cjs'));
const report={pass:false,expectation,source:audit(__filename),package:audit(path.join(__dirname,'build',folder,'package.json')),errors:[],
  boundary:'Original unconverted Villa Cook with an explicit WebNaniteScene opt-in. Native fixed-runtime status verifies allocation/update state. GPU labels may be omitted by the RHI, so absence of labeled calls alone is not proof. Not FPS.'};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
function observe(){
  const s=globalThis.__naniteIdleGPU={allocations:[],active:false,dispatches:0,draws:0};const groups=new WeakSet(),passes=new WeakMap();
  for(const name of ['createBuffer','createTexture']){const original=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(d){
    if(/Nanite\./i.test(d.label||''))s.allocations.push({type:name,label:d.label,size:d.size});return original.call(this,d);};}
  const bind=GPUDevice.prototype.createBindGroup;GPUDevice.prototype.createBindGroup=function(d){const g=bind.call(this,d);
    if(d.entries.some(e=>/Nanite\./i.test(e.resource?.buffer?.label||'')))groups.add(g);return g;};
  for(const proto of [GPURenderPassEncoder.prototype,GPUComputePassEncoder.prototype]){
    const original=proto.setBindGroup;proto.setBindGroup=function(i,g,...args){let state=passes.get(this);if(!state){state={};passes.set(this,state);}state[i]=groups.has(g);return original.call(this,i,g,...args);};
    for(const n of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','dispatchWorkgroups','dispatchWorkgroupsIndirect']){
      const original=proto[n];if(!original)continue;proto[n]=function(...args){if(s.active&&Object.values(passes.get(this)||{}).some(Boolean))s[n.startsWith('draw')?'draws':'dispatches']++;return original.apply(this,args);};}
  }
}
(async()=>{let context,page;try{
  context=await chromium.launchPersistentContext(`C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}`,
    {channel:'msedge',headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})();\n`+await r.text()});});
  page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{const text=m.text();if(text.startsWith('P3_RENDER_SCENE '))report.scene=JSON.parse(text.slice('P3_RENDER_SCENE '.length));
    if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text))report.errors.push(text);});
  await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
  await page.waitForFunction(()=>globalThis.__webEngineFailure||(globalThis.__webEngineFrames>180&&globalThis.__webPSOPrecacheReady),null,{timeout:300000});
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure));const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  const rpc=(fn,...args)=>page.evaluate(a=>__webEngineRPC(a[0],...a.slice(1)),[fn,...args]);
  const wait=async n=>{const f=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>f[0]+f[1],[f,n],{timeout:120000});};
  const status=async()=>{const prev=await owner.evaluate(()=>globalThis.__webNaniteIdleStatus?.sequence||0);assert.equal(await rpc('WebNaniteIdleStatusTest'),1);
    let s;const deadline=Date.now()+10000;do{await page.waitForTimeout(50);s=await owner.evaluate(()=>globalThis.__webNaniteIdleStatus);}while(!(s?.sequence>prev)&&Date.now()<deadline);
    assert(s?.sequence>prev);return s;};
  assert.equal(await rpc('WebNaniteAutomaticSceneTest',1),1);let t;const deadline=Date.now()+120000;
  do{await page.waitForTimeout(200);await rpc('WebNaniteAutomaticSceneTest',0);t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);}while(t?.step!==1&&Date.now()<deadline);
  assert.equal(t?.step,1);assert(t.enabled&&!t.registered&&!t.entries&&!t.assets.length);assert(report.scene.meshes>2000);
  report.readback={assets:t.assets.length,registered:t.registered,entries:t.entries,batches:t.batches.length};
  report.start={history:await page.evaluate(()=>__webOcclusionHistory),gpu:await owner.evaluate(()=>__naniteIdleGPU)};
  if(expectation==='fixed')report.start.status=await status();
  await owner.evaluate(()=>Object.assign(__naniteIdleGPU,{active:true,dispatches:0,draws:0}));
  // Villa's authored dynamic actors keep updating even with the camera still.
  await wait(240);report.end={history:await page.evaluate(()=>__webOcclusionHistory),gpu:await owner.evaluate(()=>{__naniteIdleGPU.active=false;return __naniteIdleGPU;})};
  if(expectation==='fixed'){
    report.end.status=await status();const a=report.start.status,b=report.end.status;
    assert(!a.allocated&&!a.resources&&!a.initializations&&!a.updates&&!a.stagingBytes&&!a.proxies&&a.enabled);
    assert.deepEqual({...b,sequence:a.sequence},a);assert.equal(report.end.history.naniteActiveScenes,0);
    assert.equal(report.end.history.boundsChangeSerial,report.start.history.boundsChangeSerial);
    assert.equal(report.end.history.naniteActivityTransitions,0);
    assert(!report.end.gpu.allocations.some(x=>/StreamingManager|StreamingRequests/.test(x.label)));
    assert(!report.end.gpu.dispatches&&!report.end.gpu.draws);
  }else assert(report.end.history.boundsRejected>report.start.history.boundsRejected);
  assert.equal(await rpc('WebNaniteAutomaticSceneTest',-1),1);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}finally{await context?.close();save();console.log(report);}})();
