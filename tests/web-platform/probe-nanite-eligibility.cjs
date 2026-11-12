'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const [folder,tag,expectation]=process.argv.slice(2);assert([folder,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
const idleStatus=process.argv.includes('--idle-status');
assert(['before','fixed'].includes(expectation));
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);
fs.copyFileSync(__filename,path.join(output,'source.cjs'));
const report={pass:false,expectation,idleStatus,source:audit(__filename),package:audit(path.join(__dirname,'build',folder,'package.json')),tests:[],errors:[],
  boundary:'Real component flags, visibility and mesh replacement through the normal render-state lifecycle. GPU instrumentation is only for correctness/work attribution, not accepted FPS.'};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
function observe(){
  const state=globalThis.__naniteEligibilityGPU={active:false,resources:{},dispatches:0,draws:0,pipelines:{}};
  const shaders=new WeakMap(),pipelines=new WeakMap(),passes=new WeakMap(),groups=new WeakSet();
  const bind=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(d){const g=bind.call(this,d);
    if(d.entries.some(e=>/Nanite\.Web\./.test(e.resource?.buffer?.label||'')))groups.add(g);return g;};
  const module=GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule=function(d){const m=module.call(this,d);shaders.set(m,d.code);return m;};
  for(const name of ['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']){
    const original=GPUDevice.prototype[name];
    const remember=(p,d)=>{const code=[d.vertex,d.fragment,d.compute].filter(Boolean).map(s=>shaders.get(s.module)||'').join('\n');
      pipelines.set(p,/WebNanite|WebRaster|WebDepthVisibility|WebSceneEntry/.test(code));return p;};
    GPUDevice.prototype[name]=function(d){const p=original.call(this,d);return name.endsWith('Async')?p.then(p=>remember(p,d)):remember(p,d);};
  }
  for(const name of ['createBuffer','createTexture']){const original=GPUDevice.prototype[name];
    GPUDevice.prototype[name]=function(d){if(state.active&&/Nanite\.Web\./.test(d.label||''))state.resources[d.label]=(state.resources[d.label]||0)+1;return original.call(this,d);};}
  for(const proto of [GPURenderPassEncoder.prototype,GPUComputePassEncoder.prototype]){
    const stateFor=p=>{let s=passes.get(p);if(!s){s={groups:{}};passes.set(p,s);}return s;};
    const set=proto.setPipeline;proto.setPipeline=function(p){Object.assign(stateFor(this),{nanite:pipelines.get(p),label:p.label});return set.call(this,p);};
    const setGroup=proto.setBindGroup;proto.setBindGroup=function(index,g,...args){stateFor(this).groups[index]=groups.has(g);return setGroup.call(this,index,g,...args);};
    for(const name of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','dispatchWorkgroups','dispatchWorkgroupsIndirect']){
      const original=proto[name];if(!original)continue;
      proto[name]=function(...args){const p=passes.get(this);if(state.active&&p&&(p.nanite||Object.values(p.groups).some(Boolean))){state[name.startsWith('draw')?'draws':'dispatches']++;state.pipelines[p.label]=(state.pipelines[p.label]||0)+1;}return original.apply(this,args);};
    }
  }
}
(async()=>{let context,page,owner;try{
  context=await chromium.launchPersistentContext(`C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}`,
    {channel:'msedge',headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})();\n`+await r.text()});});
  await context.route('**/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,
    body:(await r.text()).replace('arguments: [','arguments: ["-WebVisualTestClock",')});});
  page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.message));
  page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
  await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
  await page.waitForFunction(()=>globalThis.__webEngineFailure||(globalThis.__webEngineFrames>180&&globalThis.__webPSOPrecacheReady),null,{timeout:300000});
  assert(!await page.evaluate(()=>globalThis.__webEngineFailure));owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
  const status=async()=>{const prev=await owner.evaluate(()=>globalThis.__webNaniteIdleStatus?.sequence||0);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteIdleStatusTest')),1);
    let s;const deadline=Date.now()+10000;do{await page.waitForTimeout(50);s=await owner.evaluate(()=>globalThis.__webNaniteIdleStatus);}while(!(s?.sequence>prev)&&Date.now()<deadline);
    assert(s?.sequence>prev);return s;};
  // Step 2/3 of the ordinary scene observer are reserved for global r.Nanite.
  // Do them first, then independently exercise authored component policies.
  const modes=[0,0,0,1,0,2,0,3,0,4,0,5,0];
  for(const [i,mode] of modes.entries()){
    const changed=await page.evaluate(m=>__webEngineRPC('WebNaniteEligibilityTest',m),mode);assert(changed>2000);
    const step=i+1;assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
    let t;const deadline=Date.now()+180000;
    do{await page.waitForTimeout(200);assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
      await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
    }while(t?.step!==step&&Date.now()<deadline);
    assert.equal(t?.step,step);
    const readbackFile=path.join(output,`step-${step}.json`);fs.writeFileSync(readbackFile,JSON.stringify(t));
    const idleBefore=idleStatus?await status():null;
    const historyBefore=idleStatus?await page.evaluate(()=>__webOcclusionHistory):null;
    await owner.evaluate(()=>Object.assign(__naniteEligibilityGPU,{active:true,resources:{},dispatches:0,draws:0,pipelines:{}}));
    const frame=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>f+90,frame,{timeout:120000});
    const gpu=await owner.evaluate(()=>{__naniteEligibilityGPU.active=false;return __naniteEligibilityGPU;});
    let covered=0;if(t.pixels)for(let p=0;p<t.pixels.length;p+=28)if(t.pixels[p]&&t.pixels[p+1]===t.pixels[p+2])covered++;
    const record={step,mode,changed,readback:audit(readbackFile),enabled:t.enabled,assets:t.assets.length,registered:t.registered,entries:t.entries,covered,
      materialComplete:t.materialComplete,materialDraws:t.materialDraws,
      suppressed:t.batches.filter(b=>!b.material&&!b.depth&&!b.occluder).length,gpu};
    if(idleStatus){record.idleBefore=idleBefore;record.idleAfter=await status();
      record.historyBefore=historyBefore;record.historyAfter=await page.evaluate(()=>__webOcclusionHistory);}
    report.tests.push(record);save();
    if(step===2){assert(!t.enabled&&t.registered===0&&t.entries===0);}
    else if(mode===5){assert(t.enabled&&t.assets.length===0&&t.registered===0&&t.entries===0);}
    else if(mode===4){assert(t.enabled&&t.registered===0&&t.entries===0);}
    else if(mode&&expectation==='fixed'){assert(t.enabled&&t.registered===0&&t.entries===0&&record.suppressed===0);}
    else {assert(t.enabled&&t.registered===2062&&t.entries>0&&record.suppressed===2062);}
    if(t.entries===0&&t.assets.length>0&&mode!==4){assert(t.batches.length>2000);
      assert(t.batches.every(b=>b.created&&b.triangles>0&&b.material),'Disabled Nanite must retain ordinary material draws');}
    if(expectation==='fixed'&&t.entries===0){assert.deepEqual(gpu.resources,{});assert.equal(gpu.dispatches,0);assert.equal(gpu.draws,0);}
    if(idleStatus){assert.equal(record.idleAfter.proxies,t.registered>0);assert.equal(record.idleAfter.initializations,1);
      if(t.registered===0){assert.equal(record.idleAfter.updates,idleBefore.updates);assert.equal(record.historyAfter.naniteActiveScenes,0);
        assert.equal(record.historyAfter.boundsChangeSerial,historyBefore.boundsChangeSerial);}
      else {assert(record.idleAfter.updates>idleBefore.updates);assert.equal(record.historyAfter.naniteActiveScenes,1);}}
    if(t.entries>0){assert(t.materialComplete&&t.materialDraws>0&&covered>100);
      assert(gpu.dispatches>0&&gpu.draws>0,'Positive control must observe real Nanite execution');}
    console.log(JSON.stringify({step,mode,registered:t.registered,entries:t.entries,naniteDispatches:gpu.dispatches,naniteDraws:gpu.draws,resources:Object.keys(gpu.resources)}));
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
  assert(await page.evaluate(()=>__webEngineRPC('WebNaniteEligibilityTest',-1))>2000);
  assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
}finally{await context?.close();save();console.log({pass:report.pass,output,failure:report.failure});}})();
