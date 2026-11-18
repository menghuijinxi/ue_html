'use strict';
// Execute the actual Cooked argument shader, then consume its arguments with a
// real indirect dispatch. CPU expectations cover prefix sums, error states,
// state offsets, untouched tails, zero work and the 65535-group batch limit.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const cookFile=option('cook'),tag=option('tag');assert(cookFile&&/^[a-z0-9-]+$/.test(tag));
const fixed=process.argv.includes('--fixed-draw');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const cook=read(cookFile);assert(cook.pass);assert.equal(audit(cook.shaderInventory.artifact.file).sha256,cook.shaderInventory.artifact.sha256);
const conversion=path.dirname(cook.shaderInventory.artifact.file);
const match=fs.readdirSync(conversion,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>path.join(conversion,e.name,'input.json'))
 .filter(f=>fs.existsSync(f)&&read(f).shaderName===(fixed?'FWebNaniteFixedBatchArgumentsCS':'FWebNaniteMicroArgumentsCS'));assert.equal(match.length,1);
const input=read(match[0]),wgsl=path.join(path.dirname(match[0]),'output.wgsl');
const code=fs.readFileSync(wgsl,'utf8'),bindings=input.metadata.spirvBindings;
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);
fs.copyFileSync(__filename,path.join(output,'source.cjs'));
fs.copyFileSync(wgsl,path.join(output,'arguments.wgsl'));fs.copyFileSync(match[0],path.join(output,'input.json'));
const cases=[];
function add(name,values){let sum=0;const prefix=values.map(v=>sum+=v.error||v.count>v.capacity?0:v.count);cases.push({name,values,prefix,total:sum});}
for(const size of [0,1,2,3,7,31,64,127,128]){
 add('zero-'+size,Array.from({length:size},()=>({capacity:17,count:0,error:0})));
 add('mixed-'+size,Array.from({length:size},(_,i)=>({capacity:17,count:i%5===0?18:i%7===0?0xffffffff:i%17,error:i%11===0?1:0})));
}
add('maximum-batch',[16384,16384,16384,16383].map(capacity=>({capacity,count:capacity,error:0})));
add('errors-only',Array.from({length:128},(_,i)=>({capacity:511,count:i%2?512:0xffffffff,error:i%3})));
let seed=0x584d4943;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0));
for(let n=0;n<16;n++)add('random-'+n,Array.from({length:128},()=>{const capacity=random()%511+1;return {capacity,count:random()%(capacity+2),error:random()%19===0?1:0};}));
const report={pass:false,fixed,source:audit(__filename),cook:audit(cookFile),shader:audit(wgsl),input:audit(match[0]),cases,errors:[]};
(async()=>{let browser;try{
 browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
 await page.route('**/micro-batch-probe',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>GPU argument probe</title>'}));
 await page.goto('http://127.0.0.1:8765/micro-batch-probe');
 report.gpu=await page.evaluate(async ({code,bindings,entry,cases,fixed})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  const prepare=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
  const consume=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:`
   @group(0) @binding(0) var<storage,read_write> Counts:array<atomic<u32>>;
   @compute @workgroup_size(1) fn main(@builtin(workgroup_id) Group:vec3<u32>){atomicAdd(&Counts[0],1);atomicMax(&Counts[1],Group.x+1);}
  `}),entryPoint:'main'}});
  const results=[];
  try {for(const test of cases){
   const owned=[],make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});device.queue.writeBuffer(b,0,data);owned.push(b);return b;};
   const globals=make(new Uint32Array([test.values.length,0,0,0]),GPUBufferUsage.UNIFORM);
   const data=new Uint32Array(Math.max(1,test.values.length)*28),states=new Uint32Array(128*7+8);states.fill(0xfedcba98);
   for(let i=0;i<test.values.length;i++){data[i*28+16]=test.values[i].capacity;data[i*28+18]=i*7+3;states[i*7+3]=test.values[i].count;states[i*7+4]=test.values[i].error;}
   const metadata=make(data,GPUBufferUsage.STORAGE),state=make(states,GPUBufferUsage.STORAGE);
   const initial=new Uint32Array(fixed?(test.total+4)*2:132);initial.fill(0x1234abcd);
   const argumentWords=fixed?[0,0,0,0,0x1234abcd]:[0,0,0,0x1234abcd];
   const prefix=make(initial,GPUBufferUsage.STORAGE),args=make(new Uint32Array(argumentWords),GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT),counter=make(new Uint32Array(2),GPUBufferUsage.STORAGE);
   const dispatchArgs=fixed?make(new Uint32Array([0,1,1]),GPUBufferUsage.INDIRECT):args;
   const resources=fixed?{$Globals:globals,WebFixedBatchData:metadata,WebRasterCullState:state,WebFixedBatchSlotsOutput:prefix,WebFixedBatchArguments:args}:
    {$Globals:globals,WebMicroBatchData:metadata,WebRasterCullState:state,WebMicroBatchPrefixOutput:prefix,WebMicroBatchArguments:args};
   const entries=bindings.map(b=>{if(b.group!==0||!resources[b.name])throw Error('Unexpected binding '+b.name);return {binding:b.binding,resource:{buffer:resources[b.name]}};});
   const encoder=device.createCommandEncoder(),prep=encoder.beginComputePass();prep.setPipeline(prepare);prep.setBindGroup(0,device.createBindGroup({layout:prepare.getBindGroupLayout(0),entries}));prep.dispatchWorkgroups(1);prep.end();
   // Draw arguments store instance count at byte 4. Consume that exact count as
   // a dispatch, avoiding millions of dummy vertices in the argument probe.
   if(fixed)encoder.copyBufferToBuffer(args,4,dispatchArgs,0,4);
   const dispatch=encoder.beginComputePass();dispatch.setPipeline(consume);dispatch.setBindGroup(0,device.createBindGroup({layout:consume.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:counter}}]}));dispatch.dispatchWorkgroupsIndirect(dispatchArgs,0);dispatch.end();
   const prefixBytes=initial.byteLength,argsBytes=argumentWords.length*4;
   const readback=device.createBuffer({size:prefixBytes+argsBytes+8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   encoder.copyBufferToBuffer(prefix,0,readback,0,prefixBytes);encoder.copyBufferToBuffer(args,0,readback,prefixBytes,argsBytes);encoder.copyBufferToBuffer(counter,0,readback,prefixBytes+argsBytes,8);
   device.queue.submit([encoder.finish()]);await readback.mapAsync(GPUMapMode.READ);const words=Array.from(new Uint32Array(readback.getMappedRange()));readback.unmap();readback.destroy();
   const offset=initial.length,end=offset+argumentWords.length;
   results.push({name:test.name,prefix:words.slice(0,offset),arguments:words.slice(offset,end),consumed:words.slice(end,end+2)});
   for(const b of owned)b.destroy();
  }
  const error=await device.popErrorScope();if(error)errors.push(error.message);return {results,errors,features:[...device.features]};
  }finally{device.destroy();}
 },{code,bindings,entry:input.metadata.webEntry,cases,fixed});
 assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.results.length,cases.length);
 for(let i=0;i<cases.length;i++){const expected=cases[i],actual=report.gpu.results[i];
  if(fixed){let index=0;for(let instance=0;instance<expected.values.length;instance++){
   const v=expected.values[instance],count=v.error||v.count>v.capacity?0:v.count;
   for(let slot=0;slot<count;slot++){assert.equal(actual.prefix[index++],instance,expected.name+' instance');assert.equal(actual.prefix[index++],slot,expected.name+' slot');}
  }assert.equal(index,expected.total*2);assert(actual.prefix.slice(index).every(v=>v===0x1234abcd),expected.name+' untouched tail');
   assert.deepEqual(actual.arguments,[384,expected.total,0,0,0x1234abcd]);
  }else{
   assert.deepEqual(actual.prefix.slice(0,expected.values.length),expected.prefix,expected.name);
   assert(actual.prefix.slice(expected.values.length).every(v=>v===0x1234abcd),expected.name+' untouched tail');
   assert.deepEqual(actual.arguments,[expected.total,1,1,0x1234abcd]);
  }
  assert.deepEqual(actual.consumed,[expected.total,expected.total]);
 }
 report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;console.error(e.stack);}finally{await browser?.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:report.pass,cases:cases.length,output});}})();
