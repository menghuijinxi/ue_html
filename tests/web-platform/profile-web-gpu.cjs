'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder')||'nanite-core-scene',tag=option('tag');
assert(/^[a-z0-9-]+$/.test(folder)&&/^[a-z0-9-]+$/.test(tag));
const file=path.join(__dirname,'results','gpu-'+tag+'.json');
const report={pass:false,source:audit(__filename),errors:[],boundary:'Diagnostic GPU timestamp pass durations. Instrumented FPS is not a game-performance acceptance metric; copies, barriers and idle gaps are excluded from summed pass time.'};
function instrument(){
 const state=globalThis.__gpuTiming={errors:[],results:[],pending:0,frame:0,active:false,waiting:false,remaining:0};
 const encoders=new WeakMap(),commands=new WeakMap();let frameCallback;
 Object.defineProperty(globalThis,'__webGPUFrameSubmitted',{configurable:true,get:()=>frameCallback,set:fn=>{
  frameCallback=(...args)=>{const result=fn(...args);state.frame++;
   if(state.active&&!--state.remaining)state.active=false;
   if(state.waiting){state.waiting=false;state.active=true;state.firstFrame=state.frame;}
   return result;};
 }});
 state.arm=count=>{if(state.active||state.waiting||state.pending)throw Error('GPU capture already running');
  state.results=[];state.remaining=count;state.waiting=true;};
 const request=GPUAdapter.prototype.requestDevice;
 GPUAdapter.prototype.requestDevice=async function(desc){
  if(!this.features.has('timestamp-query'))throw Error('Actual adapter lacks timestamp-query');
  const device=await request.call(this,{...desc,requiredFeatures:[...new Set([...(desc.requiredFeatures||[]),'timestamp-query'])]});
  state.features=[...device.features];device.addEventListener('uncapturederror',e=>state.errors.push(e.error.message));
  device.lost.then(e=>state.errors.push(e.message));
  const create=device.createCommandEncoder.bind(device);
  device.createCommandEncoder=desc=>{const encoder=create(desc);
   if(state.active)encoders.set(encoder,{device,frame:state.frame,passes:[]});return encoder;};
  const submit=device.queue.submit.bind(device.queue);
  device.queue.submit=buffers=>{const list=Array.from(buffers),result=submit(list);
   for(const buffer of list){const record=commands.get(buffer);if(!record)continue;commands.delete(buffer);state.pending++;
    record.readback.mapAsync(GPUMapMode.READ).then(()=>{
     const words=new BigUint64Array(record.readback.getMappedRange());
     state.results.push({frame:record.frame,passes:record.passes.map((p,i)=>({...p,nanoseconds:Number(words[2*i+1]-words[2*i]),
      startNanoseconds:words[2*i].toString(),endNanoseconds:words[2*i+1].toString()}))});
     record.readback.unmap();
    }).catch(e=>state.errors.push(e.stack||String(e))).finally(()=>{
     record.readback.destroy();record.resolve.destroy();record.queries.destroy();state.pending--;
    });
   }return result;};
  return device;
 };
 for(const name of ['beginRenderPass','beginComputePass']){
  const begin=GPUCommandEncoder.prototype[name];
  GPUCommandEncoder.prototype[name]=function(desc={}){
   const record=encoders.get(this);if(!record)return begin.call(this,desc);
   if(desc.timestampWrites)throw Error('Existing pass timestamps must not be overwritten');
   if(record.passes.length>=2048)throw Error('GPU capture query budget exceeded');
   record.queries??=record.device.createQuerySet({type:'timestamp',count:4096});
   const index=record.passes.length*2;record.passes.push({kind:name,label:desc.label||''});
   return begin.call(this,{...desc,timestampWrites:{querySet:record.queries,beginningOfPassWriteIndex:index,endOfPassWriteIndex:index+1}});
  };
 }
 const finish=GPUCommandEncoder.prototype.finish;
 GPUCommandEncoder.prototype.finish=function(desc){
  const record=encoders.get(this);
  if(record?.passes.length){
   const size=record.passes.length*16;
   record.resolve=record.device.createBuffer({size,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
   record.readback=record.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   this.resolveQuerySet(record.queries,0,record.passes.length*2,record.resolve,0);
   this.copyBufferToBuffer(record.resolve,0,record.readback,0,size);
  }
  const result=finish.call(this,desc);if(record?.passes.length)commands.set(result,record);encoders.delete(this);return result;
 };
}
(async()=>{let context;try{
 const packageFile=path.join(__dirname,'build',folder,'package.json'),pkg=JSON.parse(fs.readFileSync(packageFile));
 assert(pkg.pass);for(const item of pkg.products)assert.equal(audit(item.file).sha256,item.sha256,item.file);report.package=audit(packageFile);
 context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles/cpu-villa'),{channel:'msedge',headless:true,viewport:{width:1280,height:720}});
 await context.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:`(${instrument.toString()})();\n`+await response.text()});});
 const page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html',{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>100,null,{timeout:900000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 report.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock||null);assert(!report.clock?.renderTimeFrozen&&!report.clock?.materialTimeFrozen);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
 const frame=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+240,frame,{timeout:120000});
 await owner.evaluate(()=>__gpuTiming.arm(16));const start=Date.now();let capture;
 do {await page.waitForTimeout(200);capture=await owner.evaluate(()=>({active:__gpuTiming.active,waiting:__gpuTiming.waiting,pending:__gpuTiming.pending,errors:__gpuTiming.errors}));
  assert.deepEqual(capture.errors,[]);
 }while((capture.active||capture.waiting||capture.pending)&&Date.now()-start<90000);
 assert(!capture.active&&!capture.waiting&&!capture.pending);report.capture=await owner.evaluate(()=>({features:__gpuTiming.features,firstFrame:__gpuTiming.firstFrame,results:__gpuTiming.results}));
 const frames=new Map();
 for(const command of report.capture.results){let frame=frames.get(command.frame);if(!frame){frame={frame:command.frame,renderMs:0,computeMs:0,renderPasses:0,computePasses:0};frames.set(command.frame,frame);}
  for(const p of command.passes){assert(p.nanoseconds>=0&&Number.isFinite(p.nanoseconds));const type=p.kind==='beginRenderPass'?'render':'compute';frame[type+'Ms']+=p.nanoseconds/1e6;frame[type+'Passes']++;
   if(frame.startNanoseconds===undefined||BigInt(p.startNanoseconds)<BigInt(frame.startNanoseconds))frame.startNanoseconds=p.startNanoseconds;
   if(frame.endNanoseconds===undefined||BigInt(p.endNanoseconds)>BigInt(frame.endNanoseconds))frame.endNanoseconds=p.endNanoseconds;
  }}
 report.frames=[...frames.values()].sort((a,b)=>a.frame-b.frame);assert.equal(report.frames.length,16);
 for(const f of report.frames)f.spanMs=Number(BigInt(f.endNanoseconds)-BigInt(f.startNanoseconds))/1e6;
 report.meanSpanMs=report.frames.reduce((sum,f)=>sum+f.spanMs,0)/report.frames.length;
 report.meanPassMs=report.frames.reduce((sum,f)=>sum+f.renderMs+f.computeMs,0)/report.frames.length;
 assert(report.meanPassMs>0);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);}finally{await context?.close();fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log({pass:report.pass,meanPassMs:report.meanPassMs,file});}})();
