'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),base=path.join(__dirname,'results/nanite-curves/material-index');
const output=path.join(__dirname,'results/nanite-curves/material-visualization');fs.mkdirSync(output,{recursive:true});
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const baseFile=path.join(base,'verified.json'),proof=JSON.parse(fs.readFileSync(baseFile,'utf8'));assert(proof.pass);
[proof.source,...proof.inputs,...proof.results.flatMap(r=>r.files)].forEach(verify);
const production=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/NaniteVisualize.usf');
const original=path.join(output,'original-NaniteVisualize.usf');
fs.writeFileSync(original,cp.execFileSync('git',['show','95057ac9d:Engine/Shaders/Private/Nanite/NaniteVisualize.usf'],{cwd:path.join(root,'reference-engine'),windowsHide:true}));
const cases=fs.readFileSync(path.join(base,'cases.bin')),tables=fs.readFileSync(path.join(base,'tables.bin')),count=cases.length/48,variants=[];
for(const [name,file] of [['old',original],['current',production]]){
 const source=fs.readFileSync(file,'utf8'),expressions=[
  /VisualizeMode == NANITE_VISUALIZE_MATERIAL_INDEX\)\s*\{\s*Result = IntToColor\(([^;]+)\);/.exec(source)?.[1],
  /FeedbackResults.MaterialIndex\s*=\s*([^;]+);/.exec(source)?.[1]];
 assert(expressions.every(Boolean));
 let code=fs.readFileSync(path.join(base,'current.hlsl'),'utf8');
 const start=code.indexOf(' Output[I*6]='),end=code.indexOf('\n}',start);assert(start>0&&end>start);
 code=code.slice(0,start)+expressions.map((e,i)=>` Output[I*2+${i}]=${e.replaceAll('Cluster','C').replaceAll('TriIndex','A.config.z')};`).join('\n')+code.slice(end);
 const hlsl=path.join(output,name+'.hlsl'),spv=path.join(output,name+'.spv'),wgsl=path.join(output,name+'.wgsl');fs.writeFileSync(hlsl,code);
 cp.execFileSync(path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
 cp.execFileSync(path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
 const text=fs.readFileSync(wgsl,'utf8');variants.push({name,code:text,entry:/@compute[\s\S]*?fn (\w+)\(/.exec(text)[1],files:[hlsl,spv,wgsl].map(audit)});
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/');const results=[];
 for(const v of variants){const gpu=await page.evaluate(async({code,entry,cases,tables,count})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const input=make(new Uint8Array(cases),GPUBufferUsage.STORAGE),table=make(new Uint8Array(tables),GPUBufferUsage.STORAGE),output=make(new Uint32Array(count*2),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
  const read=device.createBuffer({size:count*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
  const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,table,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,count*8);device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);const data=[...new Uint32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)errors.push(error.message);device.destroy();return{errors,data};
 },{code:v.code,entry:v.entry,cases:[...cases],tables:[...tables],count});assert.deepEqual(gpu.errors,[]);
 const failures=[0,0];for(let i=0;i<count;i++)for(let c=0;c<2;c++)failures[c]+=gpu.data[i*2+c]!==cases.readUInt32LE(i*48+44);
 assert.deepEqual(failures,v.name==='old'?[86501,86501]:[0,0]);
 const readback=path.join(output,v.name+'-readback.bin');fs.writeFileSync(readback,Buffer.from(new Uint32Array(gpu.data).buffer));results.push({name:v.name,failures,cases:count,readback:audit(readback),files:v.files});
 }
 const report={pass:true,source:audit(__filename),inputs:[production,original,baseFile,path.join(base,'cases.bin'),path.join(base,'tables.bin'),path.join(base,'current.hlsl')].map(audit),results};
 fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,results:results.map(({files,readback,...r})=>r)});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
