'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-curves/niagara-finite');
const source=path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUNiagaraFinite.h');
const failed=path.join(__dirname,'results/nanite-curves/failure-niagara-isnan/conversion');
const dxc=path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),tint=path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe');
fs.mkdirSync(output,{recursive:true});
const helper=/R"WEBGPU\(([\s\S]*?)\)WEBGPU"/.exec(fs.readFileSync(source,'utf8'))[1];
function compile(name,code,entry,allowFurtherFailure=false){
 const hlsl=path.join(output,name+'.hlsl'),spv=path.join(output,name+'.spv'),wgsl=path.join(output,name+'.wgsl');fs.writeFileSync(hlsl,code);
 cp.execFileSync(dxc,['-T','cs_6_6','-E',entry,'-spirv','-fspv-target-env=vulkan1.1','-fvk-use-dx-layout','-Fo',spv,hlsl],{windowsHide:true,stdio:'pipe'});
 const result=cp.spawnSync(tint,['--format','wgsl','-o',wgsl,spv],{windowsHide:true,encoding:'utf8'});
 fs.writeFileSync(path.join(output,name+'-tint.log'),(result.stdout||'')+(result.stderr||''));
 if(allowFurtherFailure&&result.status!==0){
  assert.match(result.stderr+result.stdout,/OpMemoryBarrier/);
  return {pass:false,files:[hlsl,spv,path.join(output,name+'-tint.log')].map(audit),error:result.stderr+result.stdout};
 }
 assert.equal(result.status,0,(result.stdout||'')+(result.stderr||''));
 return {files:[hlsl,spv,wgsl].map(audit),code:fs.readFileSync(wgsl,'utf8')};
}
const old=cp.spawnSync(tint,['--format','wgsl','-o',path.join(output,'old.wgsl'),path.join(failed,'input.spv')],{windowsHide:true,encoding:'utf8'});
fs.writeFileSync(path.join(output,'old-tint.log'),(old.stdout||'')+(old.stderr||''));assert.notEqual(old.status,0);assert.match(old.stderr+old.stdout,/IsNan is not supported/);
const production=fs.readFileSync(path.join(failed,'preprocessed.hlsl'),'utf8');assert(/\bisfinite\s*\(/.test(production));
// This mirrors the compiler's token replacement; the subsequent full Cook
// independently exercises the compiled C++ lowering on every Niagara shader.
const actual=compile('production-niagara',helper+production.replace(/\bisfinite(?=\s*\()/g,'WebGPUNiagaraIsFinite'),'SimulateMainComputeCS',true);
const contract=compile('classification',helper+`
[[vk::binding(0,0)]] StructuredBuffer<uint4> Input;
[[vk::binding(1,0)]] RWStructuredBuffer<uint4> Output;
[numthreads(64,1,1)] void MainCS(uint I:SV_DispatchThreadID){
 uint Count,Stride;Input.GetDimensions(Count,Stride);if(I>=Count)return;
 float4 V=asfloat(Input[I]);bool A=WebGPUNiagaraIsFinite(V.x);
 bool2 B=WebGPUNiagaraIsFinite(V.yz);bool3 C=WebGPUNiagaraIsFinite(V.xyz);bool4 D=WebGPUNiagaraIsFinite(V);
 Output[I]=uint4(uint(A),uint(B.x)|(uint(B.y)<<1),uint(C.x)|(uint(C.y)<<1)|(uint(C.z)<<2),uint(D.x)|(uint(D.y)<<1)|(uint(D.z)<<2)|(uint(D.w)<<3));
}`,'MainCS');
if(process.argv.includes('--compile-only')){console.log({compiled:true,originalFailure:true});process.exit(0);}
const words=[];
for(const sign of [0,0x80000000])for(let exponent=0;exponent<256;exponent++)for(const mantissa of [0,1,0x3fffff,0x7fffff])words.push((sign|(exponent<<23)|mantissa)>>>0);
let state=0x239467ef;for(let i=0;i<65536;i++){state^=state<<13;state^=state>>>17;state^=state<<5;words.push(state>>>0);}
(async()=>{const {chromium}=require('playwright'),browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/');
 const gpu=await page.evaluate(async({code,words})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try{
   const input=device.createBuffer({size:words.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(input,0,new Uint32Array(words));
   const output=device.createBuffer({size:words.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size:words.length*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
   const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'MainCS'}});
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
   const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(words.length/256));pass.end();encoder.copyBufferToBuffer(output,0,read,0,words.length*4);device.queue.submit([encoder.finish()]);
   await read.mapAsync(GPUMapMode.READ);const values=[...new Uint32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)errors.push(error.message);return {values,errors};
  }finally{device.destroy();}
 },{code:contract.code,words});
 assert.deepEqual(gpu.errors,[]);
 const floats=new Float32Array(new Uint32Array(words).buffer),expected=[];
 for(let i=0;i<words.length;i+=4){const b=[0,1,2,3].map(j=>Number(Number.isFinite(floats[i+j])));expected.push(b[0],b[1]|b[2]<<1,b[0]|b[1]<<1|b[2]<<2,b[0]|b[1]<<1|b[2]<<2|b[3]<<3);}
 assert.deepEqual(gpu.values,expected);
 const data=path.join(output,'gpu.json');fs.writeFileSync(data,JSON.stringify({words,expected,...gpu})+'\n');
 const report={pass:true,source:audit(__filename),helper:audit(source),input:audit(path.join(failed,'input.spv')),oldFailure:audit(path.join(output,'old-tint.log')),productionInput:audit(path.join(failed,'preprocessed.hlsl')),
  actual:{pass:actual.pass!==false,files:actual.files,error:actual.error},contract:contract.files,gpu:audit(data),floatValues:words.length,vectorWidths:[1,2,3,4],
  boundary:'Classification contract only. Scalar and vector classifiers checked against JavaScript Number.isFinite on raw float32 memory. The actual hair simulation shader advances past IsNan but still fails on OpMemoryBarrier; its full compilation and simulation are NOT verified.'};
 fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,floatValues:words.length,vectorWidths:4});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
