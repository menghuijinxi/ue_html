'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const input=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>read(f).shaderName==='FWebNaniteOcclusionCS').sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];assert(input);
const shader=path.join(path.dirname(input),'output.wgsl'),metadata=read(input).metadata;
for(const name of ['WebOcclusionPrevious','WebOcclusionCurrent'])
 assert.equal(metadata.spirvBindings.find(b=>b.name===name).sampledTextureLoadOnly,true);
const nativeFile=path.resolve(process.argv[2]||'tests/web-platform/results/nanite-uploader/20261109-213519/verified.json');
const native=read(nativeFile);assert(native.pass);const page=fs.readFileSync(native.products[0].file),count=page.readUInt32LE(0)&65535;
const keys=[],triangles=new Map();for(let i=0;i<count;++i)if(page.readUInt32LE(16+(4*count+i)*16+12)&4){
 keys.push((1<<8)|i);triangles.set((1<<8)|i,page.readUInt32LE(16+i*16+4)&255);}
assert(keys.length>0);
const cases=[
 {name:'previous-visible-main',previous:0,current:1,final:0,keep:true},
 {name:'previous-occluded-main',previous:1,current:0,final:0,keep:false},
 {name:'same-frame-recovery',previous:1,current:0,final:1,keep:true},
 {name:'still-occluded-final',previous:1,current:1,final:1,keep:false},
 {name:'preserve-main-in-final',previous:0,current:1,final:1,keep:true},
 {name:'background-holes-final',previous:0,current:0,final:1,keep:true},
 {name:'input-error',previous:0,current:0,final:1,error:32,keep:false},
 // Count overflow and the sentinel keys both report errors. Consumers reject
 // the entire result when any error bit is set, including its valid prefix.
 {name:'input-overflow',previous:0,current:0,final:1,overflow:true,expectedError:3},
 {name:'foreign-page',previous:0,current:0,final:1,replace:0,expectedError:2},
 {name:'invalid-cluster',previous:0,current:0,final:1,replace:(1<<8)|255,expectedError:2},
];
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try {
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await tab.evaluate(async ({code,metadata,page,keys,cases})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try {
   const bindings=metadata.spirvBindings,b=Object.fromEntries(bindings.map(v=>[v.name,v]));
   const layout=device.createBindGroupLayout({entries:bindings.map(v=>({binding:v.binding,visibility:4,
    ...(v.name==='$Globals'?{buffer:{type:'uniform',minBindingSize:v.paddedSize}}:
     v.descriptorType===7?{buffer:{type:v.readOnlyStorage?'read-only-storage':'storage'}}:
     {texture:{sampleType:v.sampledTextureLoadOnly?'unfilterable-float':'float'}})}))});
   const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code}),entryPoint:metadata.webEntry}});
   const makeBuffer=(data,usage)=>{const buffer=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
   const pages=new Uint8Array(page.length*2);pages.set(page,page.length);
   const cluster=makeBuffer(pages,GPUBufferUsage.STORAGE),textures=[];
   for(const value of [0,1]){
    const texture=device.createTexture({size:[128,128],mipLevelCount:8,format:'r32float',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
    for(let mip=0;mip<8;++mip){const w=128>>mip;device.queue.writeTexture({texture,mipLevel:mip},new Float32Array(w*w).fill(value),{bytesPerRow:w*4},[w,w]);}
    textures.push(texture);
   }
   const results=[];
   for(const test of cases){
    const capacity=keys.length+2,list=[...keys,0xffffffff,0xffffffff];if(test.replace!==undefined)list[0]=test.replace;
    const state=[test.overflow?capacity+1:keys.length,test.error||0,123,456];
    const resources={ClusterPageData:cluster,
     WebOcclusionInputKeys:makeBuffer(new Uint32Array(list),GPUBufferUsage.STORAGE),
     WebOcclusionInputState:makeBuffer(new Uint32Array(state),GPUBufferUsage.STORAGE),
     WebOcclusionOutputKeys:makeBuffer(new Uint32Array(capacity+4).fill(0xffffffff),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),
     WebOcclusionOutputState:makeBuffer(new Uint32Array([0,0,0,0,0x12345678,0x12345678,0x12345678,0x12345678]),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)};
    const data=new ArrayBuffer(b.$Globals.paddedSize),u=new Uint32Array(data),f=new Float32Array(data);
    const matrix=[.01,0,0,0,0,.01,0,0,0,0,.001,0,0,0,.4,1];
    const values={PageConstants:[0,0,0,0],MaxVisibleClusters:[capacity],WebOcclusionFirstRootPage:[1],WebOcclusionNumRootPages:[1],
     WebOcclusionPreviousLocalToClip:matrix,WebOcclusionCurrentLocalToClip:matrix,WebOcclusionPreviousRect:[0,0,128,128],WebOcclusionCurrentRect:[0,0,128,128],
     WebOcclusionPreviousExtent:[128,128],WebOcclusionCurrentExtent:[128,128],WebOcclusionPreviousMaxMip:[7],WebOcclusionCurrentMaxMip:[7],WebOcclusionFinal:[test.final]};
    for(const m of b.$Globals.members){if(!values[m.name])throw Error('Unhandled '+m.name);(m.name.endsWith('LocalToClip')?f:u).set(values[m.name],m.offset/4);}
    resources.$Globals=makeBuffer(new Uint8Array(data),GPUBufferUsage.UNIFORM);
    const group=device.createBindGroup({layout,entries:bindings.map(v=>({binding:v.binding,resource:
     v.name==='WebOcclusionPrevious'?textures[test.previous].createView():v.name==='WebOcclusionCurrent'?textures[test.current].createView():
     {buffer:resources[v.name],...(v.name==='WebOcclusionOutputKeys'?{size:capacity*4}:v.name==='WebOcclusionOutputState'?{size:16}:{})}}))});
    const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
    const reads=[];for(const name of ['WebOcclusionOutputKeys','WebOcclusionOutputState']){const size=resources[name].size,buffer=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyBufferToBuffer(resources[name],0,buffer,0,size);reads.push(buffer);}
    device.queue.submit([enc.finish()]);const output=[];for(const buffer of reads){await buffer.mapAsync(GPUMapMode.READ);output.push(Array.from(new Uint32Array(buffer.getMappedRange())));buffer.unmap();buffer.destroy();}
    results.push({name:test.name,keys:output[0],state:output[1]});for(const [name,buffer] of Object.entries(resources))if(name!=='ClusterPageData')buffer.destroy();
   }
   const error=await device.popErrorScope();if(error)throw Error(error.message);return {results,errors,features:[...device.features]};
  }finally{device.destroy();}
 },{code:fs.readFileSync(shader,'utf8'),metadata,page:[...page],keys,cases});
 assert.deepEqual(result.errors,[]);
 for(let i=0;i<cases.length;i++){
  const c=cases[i],r=result.results[i];assert.equal(r.name,c.name);assert.equal(r.state[1],c.error||c.expectedError||0);
  assert(r.state[0]<=keys.length+2);
  assert.deepEqual(r.keys.slice(-4),Array(4).fill(0xffffffff));assert.deepEqual(r.state.slice(4),Array(4).fill(0x12345678));
  if(!r.state[1]){const expected=c.keep?keys:[];assert.equal(r.state[0],expected.length);assert.equal(r.state[2],keys.length);
   assert.equal(r.state[3],expected.reduce((s,k)=>s+triangles.get(k),0));assert.deepEqual(r.keys.slice(0,r.state[0]).sort((a,b)=>a-b),expected);}
  if(c.error){assert.equal(r.state[0],0);assert.equal(r.state[2],0);assert.equal(r.state[3],0);}
  assert(r.keys.slice(r.state[0]).every(k=>k===0xffffffff));r.pass=true;
 }
 const report={pass:true,...result,source:audit(__filename),inputs:[input,shader,nativeFile,native.products[0].file].map(audit),
  sources:['WebNaniteOcclusion.usf','WebNaniteHZB.ush'].map(f=>audit(path.join(root,'reference-engine/Engine/Shaders/Private/Nanite',f)))};
 fs.writeFileSync(path.join(__dirname,'results/nanite-occlusion.json'),JSON.stringify(report,null,2));console.log({pass:true,cases:cases.length});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
