'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder')||'nanite-core-scene',tag=option('tag');
assert(/^[a-z0-9-]+$/.test(folder)&&/^[a-z0-9-]+$/.test(tag));
const file=path.join(__dirname,'results','gpu-'+tag+'.json');
assert(!fs.existsSync(file),'Use a new result tag');fs.copyFileSync(__filename,file.replace(/\.json$/,'-source.cjs'));
const spawn=process.argv.includes('--spawn'),width=Number(option('width')||1280),height=Number(option('height')||720);
const hierarchyBatch=option('nanite-hierarchy-batch');assert(hierarchyBatch===undefined||hierarchyBatch==='0'||hierarchyBatch==='1');
const occlusionBatch=option('nanite-occlusion-batch');assert(occlusionBatch===undefined||occlusionBatch==='0'||occlusionBatch==='1');
const packBatch=option('nanite-pack-batch');assert(packBatch===undefined||packBatch==='0'||packBatch==='1');
const microBatch=option('nanite-micro-batch');assert(microBatch===undefined||microBatch==='0'||microBatch==='1');
const primitiveVisibility=option('nanite-primitive-visibility');assert(primitiveVisibility===undefined||primitiveVisibility==='0'||primitiveVisibility==='1');
const report={pass:false,source:audit(__filename),spawn,width,height,errors:[],boundary:'Diagnostic GPU timestamp pass durations. Instrumented FPS is not a game-performance acceptance metric; copies, barriers and idle gaps are excluded from summed pass time.'};
function instrument(){
 const state=globalThis.__gpuTiming={errors:[],results:[],pending:0,frame:0,active:false,waiting:false,remaining:0};
 const encoders=new WeakMap(),commands=new WeakMap(),passes=new WeakMap(),shaders=new WeakMap(),pipelines=new WeakMap();let frameCallback;
 state.pipelines={};
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
  const module=device.createShaderModule.bind(device);device.createShaderModule=d=>{const result=module(d);shaders.set(result,d.code);return result;};
  for(const name of ['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']){
   const createPipeline=device[name].bind(device),remember=(p,d)=>{const code=[d.compute,d.vertex,d.fragment].filter(Boolean).map(s=>shaders.get(s.module)||'').join('\n');
    const markers=['WebHierarchyBatchData','WebCullLODMode','WebOcclusionBatchData','WebOcclusionPrevious','WebRasterClusterKeys','WebRasterMaterialMasks','WebMicroBatchPrefixOutput','WebMicroBatchData','WebNativeMaterial','WebMaterialTile','WebNaniteVisibility','WebNaniteScalarVisibility','WebDepthVisibility'];
    const record={compute:d.compute?.entryPoint,vertex:d.vertex?.entryPoint,fragment:d.fragment?.entryPoint,markers:markers.filter(s=>code.includes(s))};pipelines.set(p,record);return p;};
   device[name]=d=>name.endsWith('Async')?createPipeline(d).then(p=>remember(p,d)):remember(createPipeline(d),d);
  }
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
   const index=record.passes.length*2,entry={kind:name,label:desc.label||'',pipelines:{}};record.passes.push(entry);
   const pass=begin.call(this,{...desc,timestampWrites:{querySet:record.queries,beginningOfPassWriteIndex:index,endOfPassWriteIndex:index+1}});
   passes.set(pass,entry);return pass;
  };
 }
 for(const proto of [GPURenderPassEncoder.prototype,GPUComputePassEncoder.prototype]){
  const set=proto.setPipeline;proto.setPipeline=function(p){const entry=passes.get(this);if(entry){entry.current=p.label;state.pipelines[p.label]=pipelines.get(p);entry.pipelines[p.label]??={draws:0,dispatches:0};}return set.call(this,p);};
  for(const name of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','dispatchWorkgroups','dispatchWorkgroupsIndirect']){const original=proto[name];if(!original)continue;
   proto[name]=function(...args){const entry=passes.get(this);if(entry?.current)entry.pipelines[entry.current][name.startsWith('draw')?'draws':'dispatches']++;return original.apply(this,args);};}
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
 context=await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/gpu-${tag}`,{channel:'msedge',headless:!process.argv.includes('--visible'),viewport:{width,height},deviceScaleFactor:1});
 await context.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:`(${instrument.toString()})();\n`+await response.text()});});
 const page=context.pages()[0];page.on('pageerror',e=>report.errors.push(e.stack));
 page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html',{waitUntil:'commit'});
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>100,null,{timeout:900000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 if(hierarchyBatch!==undefined){assert.equal(await page.evaluate(v=>__webEngineRPC('WebNaniteHierarchyBatchTest',v),Number(hierarchyBatch)),1);report.hierarchyBatch=Number(hierarchyBatch);}
 if(occlusionBatch!==undefined){assert.equal(await page.evaluate(v=>__webEngineRPC('WebNaniteOcclusionBatchTest',v),Number(occlusionBatch)),1);report.occlusionBatch=Number(occlusionBatch);}
 if(packBatch!==undefined){assert.equal(await page.evaluate(v=>__webEngineRPC('WebNanitePackBatchTest',v),Number(packBatch)),1);report.packBatch=Number(packBatch);}
 if(microBatch!==undefined){assert.equal(await page.evaluate(v=>__webEngineRPC('WebNaniteMicroBatchTest',v),Number(microBatch)),1);report.microBatch=Number(microBatch);}
 if(primitiveVisibility!==undefined){assert.equal(await page.evaluate(v=>__webEngineRPC('WebNanitePrimitiveVisibilityTest',v),Number(primitiveVisibility)),1);report.primitiveVisibility=Number(primitiveVisibility);}
 report.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock||null);assert(!report.clock?.renderTimeFrozen&&!report.clock?.materialTimeFrozen);
 if(!spawn)assert.equal(await page.evaluate(()=>__webEngineRPC('WebProjectViewTest',-175,-80,160,-5,50)),1);
 if(primitiveVisibility!==undefined){
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',1)),1);
  const started=Date.now();let state;
  do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0)),1);
   state=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest);
  }while(state?.step!==1&&Date.now()-started<180000);
  assert.equal(state?.step,1);assert.equal(state.primitiveVisibility,primitiveVisibility==='1');
  if(occlusionBatch!==undefined)assert.equal(state.occlusionBatch,occlusionBatch==='1');
  if(packBatch!==undefined)assert.equal(state.packBatch,packBatch==='1');
  if(microBatch!==undefined)assert.equal(state.microBatch,microBatch==='1');
  report.nativeBeforeCapture={frame:state.frame,registered:state.registered,entries:state.entries,primitiveVisibility:state.primitiveVisibility,
   hierarchyBatch:state.hierarchyBatch,hierarchyDispatchBuffers:state.hierarchyDispatchBuffers,occlusionBatch:state.occlusionBatch,
   mainOcclusionDispatchBuffers:state.mainOcclusionDispatchBuffers,finalOcclusionDispatchBuffers:state.finalOcclusionDispatchBuffers,
   packBatch:state.packBatch,packBatchedEntries:state.packBatchedEntries,packDispatchBuffers:state.packDispatchBuffers,
   microBatch:state.microBatch,microBatchedEntries:state.microBatchedEntries,microDispatchBuffers:state.microDispatchBuffers,
   microDirectGroups:state.microDirectGroups,microDispatchArguments:state.microDispatchArguments};
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
  report.boundary+=' Explicit primitive-visibility override isolates submission work; it is not the normal shipping configuration or FPS acceptance. Native counts are sampled before the capture.';
 }
 await page.waitForFunction(()=>globalThis.__webPSOPrecacheReady,null,{timeout:180000});
 report.view=await owner.evaluate(()=>({camera:globalThis.__webDefaultCamera,view:globalThis.__webRenderView}));
 const frame=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+240,frame,{timeout:120000});
 await owner.evaluate(()=>__gpuTiming.arm(16));const start=Date.now();let capture;
 do {await page.waitForTimeout(200);capture=await owner.evaluate(()=>({active:__gpuTiming.active,waiting:__gpuTiming.waiting,pending:__gpuTiming.pending,errors:__gpuTiming.errors}));
  assert.deepEqual(capture.errors,[]);
 }while((capture.active||capture.waiting||capture.pending)&&Date.now()-start<90000);
 assert(!capture.active&&!capture.waiting&&!capture.pending);report.capture=await owner.evaluate(()=>({features:__gpuTiming.features,firstFrame:__gpuTiming.firstFrame,results:__gpuTiming.results,pipelines:__gpuTiming.pipelines}));
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
