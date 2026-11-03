'use strict';
// Ablations use the exact same compiled WASM as the original draw benchmark.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const tag=option('tag'),rounds=Number(option('rounds')||2);
assert(tag&&/^[a-z0-9-]+$/.test(tag));
const variants=(option('variants')||'original,object-table,map-table,number-unchecked,number-map,js').split(',');
const baselineBuild=option('baseline-build'),validateCalls=process.argv.includes('--validate-calls');
assert(!baselineBuild||/^[a-z0-9-]+$/.test(baselineBuild));
const output=path.join(__dirname,'results',tag+'.json');assert(!fs.existsSync(output));
function install(variant){
 if(variant.startsWith('number')){
  // Diagnostic ablation only. This intentionally omits the original range check;
  // never use this as a production fix for arbitrary uint64 input.
  bigintToI53Checked=Number;
 }
 if(variant==='object-table'){
  WebGPU.Internals.jsObjects=Object.assign(Object.create(null),WebGPU.Internals.jsObjects);
 }
 if(variant==='map-table'||variant==='number-map'){
  const table=WebGPU.Internals.jsObjects,map=new Map(Object.entries(table).map(([k,v])=>[Number(k),v]));
  WebGPU.Internals.jsObjects=new Proxy(table,{
   set(t,k,v){map.set(Number(k),v);t[k]=v;return true;},
   deleteProperty(t,k){map.delete(Number(k));delete t[k];return true;}
  });
  WebGPU.getJsObject=ptr=>ptr?map.get(Number(ptr)):undefined;
 }
 globalThis.__drawBridgeVariant=variant;
}
function instrument(){
 const records=[],passes=new WeakMap(),originalBegin=GPUCommandEncoder.prototype.beginRenderPass;
 GPUCommandEncoder.prototype.beginRenderPass=function(...args){const pass=originalBegin.apply(this,args);const record={hash:2166136261,calls:0,objects:new WeakMap(),next:1};passes.set(pass,record);records.push(record);return pass;};
 for(const name of ['setPipeline','setBindGroup','setVertexBuffer','setIndexBuffer','drawIndexed','draw','drawIndirect','drawIndexedIndirect','setViewport','setScissorRect','executeBundles','end']){
  const original=GPURenderPassEncoder.prototype[name];
  GPURenderPassEncoder.prototype[name]=function(...args){
   const record=passes.get(this);if(record){
    const values=args.map(value=>{
     if(value&&typeof value==='object'){
      if(Array.isArray(value))return value.map(v=>{if(!record.objects.has(v))record.objects.set(v,record.next++);return record.objects.get(v);});
      if(!record.objects.has(value))record.objects.set(value,record.next++);return 'object'+record.objects.get(value);
     }return value;
    });
    const text=JSON.stringify([name,...values]);for(let i=0;i<text.length;i++)record.hash=Math.imul(record.hash^text.charCodeAt(i),16777619)>>>0;record.calls++;
   }return original.apply(this,args);
  };
 }
 const send=globalThis.postMessage.bind(globalThis);globalThis.postMessage=(message,...args)=>{
  if(message.result)message.result.apiRecords=records.map(({hash,calls})=>({hash,calls}));send(message,...args);
 };
}
function totals(run){for(const c of run.cases){const values=c.setup.samplesMs.map((v,i)=>v+c.drawLoop.samplesMs[i]+c.finish.samplesMs[i]+c.submit.samplesMs[i]).sort((a,b)=>a-b);c.totalFrontend={medianMs:values[values.length>>1],meanMs:values.reduce((a,b)=>a+b,0)/values.length};}}
const hash=file=>({file:path.relative(__dirname,file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report={date:new Date().toISOString(),tag,rounds,variants,pass:false,runs:[],
 validateCalls,
 sources:['draw-api-webgpu.cpp','draw-api-common.h','draw-api-worker.js','benchmark-draw-bridge.cjs','build/draw-api/draw-wasm.js','build/draw-api/draw-wasm.wasm','build/draw-api/build-config.json','../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUCommandStream.h','../../reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js'].map(f=>hash(path.join(__dirname,f))),
 baselineSources:baselineBuild?['draw-wasm.js','draw-wasm.wasm','build-config.json'].map(f=>hash(path.join(__dirname,'build/draw-api',baselineBuild,f))):null,
 boundary:'Same indexed workload. baseline uses the saved original build; other WASM variants use the current build. number-* drops range checks and is diagnostic only. No UE. No CPU profiler. validateCalls adds per-call instrumentation and its timings must not be used for performance claims.'};
(async()=>{try{
 for(let round=0;round<rounds;round++)for(const variant of round%2?[...variants].reverse():variants){
  const context=await chromium.launchPersistentContext(path.join(__dirname,'build/browser-profiles',`${tag}-${round}-${variant}`),
   {channel:'msedge',headless:false,viewport:{width:640,height:480}});
  try{
   await context.route('**/draw-api-*-worker.js',async route=>{
    const r=await route.fetch();let source=await r.text();
    if(variant==='baseline'){assert(baselineBuild);source=source.replaceAll('build/draw-api/','build/draw-api/'+baselineBuild+'/');}
    if(variant!=='js')source=source.replace("importScripts(",`Module.onRuntimeInitialized=()=>(${install.toString()})(${JSON.stringify(variant)});\nimportScripts(`);
    if(validateCalls)source='('+instrument.toString()+')();\n'+source;
    await route.fulfill({response:r,body:source});
   });
   if(variant==='js'&&validateCalls)await context.route('**/draw-api-worker.js',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:'('+instrument.toString()+')();\n'+await r.text()});});
   const page=context.pages()[0];await page.goto('http://127.0.0.1:8765/draw-api-benchmark.html');
   const run=await page.evaluate(kind=>runDrawBenchmark(kind),variant==='js'?'js':'wasm');
   assert(run.pass&&run.cases.length===12&&run.cases.every(c=>c.outputVerified));
   totals(run);
   if(validateCalls){
    const count=run.cases.length*(run.warmupFrames+run.measuredFrames+10);run.apiRecords=run.apiRecords.slice(-count);assert.equal(run.apiRecords.length,count);
    if(report.runs.length)assert.deepEqual(run.apiRecords,report.runs[0].apiRecords,'Native WebGPU method sequence or arguments changed');
   }
   run.round=round;run.variant=variant;report.runs.push(run);report.browser=context.browser().version();
   fs.writeFileSync(output,JSON.stringify(report,null,2));
   console.log(round,variant,run.cases.filter(c=>c.draws===3200).map(c=>({mode:c.mode,drawMs:c.drawLoop.medianMs,totalFrontendMs:c.totalFrontend.medianMs,wallMs:c.batch3WallMsPerFrame})));
  }finally{await context.close();}
 }
 report.pass=true;
}finally{fs.writeFileSync(output,JSON.stringify(report,null,2));}})().catch(e=>{console.error(e);process.exitCode=1;});
