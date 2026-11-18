'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'results/nanite-curves/material-index');fs.mkdirSync(output,{recursive:true});
const production=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/NaniteAttributeDecode.ush');
const original=path.join(output,'original-NaniteAttributeDecode.ush');
fs.writeFileSync(original,cp.execFileSync('git',['show','ea3eff92d:Engine/Shaders/Private/Nanite/NaniteAttributeDecode.ush'],{cwd:path.join(root,'reference-engine'),windowsHide:true}));
const webFile=path.join(root,'reference-engine/Engine/Shaders/Private/Nanite/WebNaniteCurves.ush');
function extract(s,name){const start=s.indexOf(name);assert(start>=0,name);let depth=0;for(let i=s.indexOf('{',start);i<s.length;i++){if(s[i]==='{')depth++;if(s[i]==='}'&&!--depth)return s.slice(start,i+1);}throw Error(name);}
const words=[],tables=[],expected=[];
for(const curve of [false,true])for(const points of curve?[2,3,4,8,16,32,64,128,255,256]:[1]){
 for(let count=1;count<=Math.min(64,Math.floor(256/points));count++)for(const layout of [0,1,2]){
  const materials=Array.from({length:count},(_,i)=>layout===0?37:layout===1?(i<Math.ceil(count/3)?5:i<Math.ceil(2*count/3)?23:61):(i*17+7)%64);
  const runs=[];materials.forEach((m,i)=>{if(runs.at(-1)?.material===m)runs.at(-1).length++;else runs.push({start:i,length:1,material:m});});
  for(const fast of [false,true]){if(fast&&runs.length>3)continue;const offset=tables.length;for(const r of runs)tables.push(r.start|(r.length<<8)|(r.material<<16));
   for(let v=0;v<count*points;v++){if(curve&&v%points===points-1)continue;
    const material=materials[Math.floor(v/points)];expected.push(material);
    words.push(points,count,v,curve?1:0,fast?runs[0].length:0,fast?(runs[1]?.length||0):0,runs[0].material,runs[1]?.material||0,runs[2]?.material||0,offset,runs.length,material);
   }
  }
 }
}
const cases=new Uint32Array(words),table=new Uint32Array(tables),count=expected.length;
fs.writeFileSync(path.join(output,'cases.bin'),Buffer.from(cases.buffer));fs.writeFileSync(path.join(output,'tables.bin'),Buffer.from(table.buffer));
const variants=[];
for(const [name,file] of [['old',original],['current',production]]){
 const source=fs.readFileSync(file,'utf8');
 const body=['void DecodeMaterialRange(','bool IsMaterialFastPath(','uint GetRelativeMaterialIndex(',...(name==='current'?['uint GetRelativeMaterialIndexFromVisIndex(']:[]),'float4 GetMaterialUVDensities(','uint GetMaterialShadingBin(','uint GetMaterialHitProxyId(','uint GetMaterialRasterBinAndFlags('].map(n=>extract(source,n).replace('TRasterBinMetaBufferType RasterBinMeta','ByteAddressBuffer RasterBinMeta')).join('\n')+'\n'+extract(fs.readFileSync(webFile,'utf8'),'uint WebNanitePrimitiveMaterial(');
 const code=`
#define BRANCH
#define LOOP
uint BitFieldExtractU32(uint V,uint N,uint B){return(V>>B)&((1u<<N)-1u);}
struct FCluster {uint NumPointsPerCurve,Material0Length,Material1Length,Material0Index,Material1Index,Material2Index,MaterialTableOffset,MaterialTableLength,PageBaseAddress;bool bCurve,bVoxel;};
struct FCase {uint4 config;uint4 fast;uint4 slow;};
[[vk::binding(0,0)]] StructuredBuffer<FCase> Cases;
[[vk::binding(1,0)]] ByteAddressBuffer ClusterPageData;
[[vk::binding(2,0)]] RWStructuredBuffer<uint> Output;
struct FNaniteView {uint unused;};
struct FNaniteMaterialFlags {uint unused;};
float4 LoadMaterialUVDensities(uint M,uint P){return float4(M,0,0,0);}
uint GetMaterialShadingBinFromIndex(uint M,uint P,uint Pass,bool V,bool C){return M;}
uint LoadMaterialHitProxyId(uint P,uint M,ByteAddressBuffer B){return M;}
uint GetMaterialRasterBinAndFlagsFromIndex(ByteAddressBuffer B,FNaniteView V,uint M,uint P,uint Pass,uint Slots,bool Fallback,out FNaniteMaterialFlags Flags){Flags=(FNaniteMaterialFlags)0;return M;}
${body}
[numthreads(64,1,1)] void MainCS(uint I:SV_DispatchThreadID){uint N,S;Cases.GetDimensions(N,S);if(I>=N)return;
 FCase A=Cases[I];FCluster C=(FCluster)0;C.NumPointsPerCurve=A.config.x;C.bCurve=A.config.w!=0;
 C.Material0Length=A.fast.x;C.Material1Length=A.fast.y;C.Material0Index=A.fast.z;C.Material1Index=A.fast.w;
 C.Material2Index=A.slow.x;C.MaterialTableOffset=A.slow.y;C.MaterialTableLength=A.slow.z;
 FNaniteMaterialFlags Flags;
 Output[I*6]=GetMaterialShadingBin(C,0,0,A.config.z);
 Output[I*6+1]=GetMaterialHitProxyId(C,0,A.config.z,ClusterPageData);
 Output[I*6+2]=uint(GetMaterialUVDensities(C,0,A.config.z).x);
 Output[I*6+3]=GetMaterialRasterBinAndFlags(ClusterPageData,(FNaniteView)0,C,0,0,A.config.z,0,false,Flags);
 Output[I*6+4]=WebNanitePrimitiveMaterial(C,A.config.z);
 Output[I*6+5]=GetRelativeMaterialIndex(C,A.config.z/A.config.x);
}`;
 const hlsl=path.join(output,name+'.hlsl'),spv=path.join(output,name+'.spv'),wgsl=path.join(output,name+'.wgsl');fs.writeFileSync(hlsl,code);
 cp.execFileSync(path.join(root,'.tools/dxc-v1.9.2609/bin/x64/dxc.exe'),['-T','cs_6_0','-E','MainCS','-spirv','-fspv-target-env=vulkan1.1','-Fo',spv,hlsl],{windowsHide:true});
 cp.execFileSync(path.join(root,'.tools/dawn-v20261009.190412/bin/tint.exe'),['--format','wgsl','-o',wgsl,spv],{windowsHide:true});
 const text=fs.readFileSync(wgsl,'utf8');variants.push({name,code:text,entry:/@compute[\s\S]*?fn (\w+)\(/.exec(text)[1],files:[hlsl,spv,wgsl].map(audit)});
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/');const results=[];
 for(const v of variants){const gpu=await page.evaluate(async({code,entry,cases,table,count})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const input=make(new Uint32Array(cases),GPUBufferUsage.STORAGE),tables=make(new Uint32Array(table),GPUBufferUsage.STORAGE),output=make(new Uint32Array(count*6),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC);
  const read=device.createBuffer({size:count*24,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:entry}});
  const bind=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[input,tables,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
  const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,count*24);device.queue.submit([encoder.finish()]);
  await read.mapAsync(GPUMapMode.READ);const data=[...new Uint32Array(read.getMappedRange())];read.unmap();const error=await device.popErrorScope();if(error)errors.push(error.message);device.destroy();return{errors,data};
 },{code:v.code,entry:v.entry,cases:[...cases],table:[...table],count});assert.deepEqual(gpu.errors,[]);
 const failures=[0,0,0,0,0,0];for(let i=0;i<count;i++)for(let c=0;c<6;c++)failures[c]+=gpu.data[i*6+c]!==expected[i];
 assert.equal(failures[4],0,'Web visibility material selection');assert.equal(failures[5],0,'Raster binning retains curve primitive indices');if(v.name==='old')assert(failures.slice(0,4).every(n=>n>0));else assert.deepEqual(failures,[0,0,0,0,0,0]);
 const readback=path.join(output,v.name+'-readback.bin');fs.writeFileSync(readback,Buffer.from(new Uint32Array(gpu.data).buffer));results.push({name:v.name,failures,cases:count,readback:audit(readback),files:v.files});
 }
 const report={pass:true,source:audit(__filename),inputs:[production,original,webFile,path.join(output,'cases.bin'),path.join(output,'tables.bin')].map(audit),results};fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,results:results.map(({files,readback,...r})=>r)});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
