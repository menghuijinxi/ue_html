'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const local=process.argv.includes('--local');
const input=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>{const r=read(f);return r.shaderName==='FWebNaniteOcclusionCS'&&r.shader.includes(`/FWebNaniteOcclusionCS/${local?1:0}:`);})
 .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];assert(input);
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
 {name:'wpo-expanded-near-plane-main',previous:1,current:1,final:0,wpo:[0,0,800,0],keep:true},
 {name:'wpo-expanded-near-plane-final',previous:1,current:1,final:1,wpo:[0,0,800,0],keep:true},
 {name:'wpo-unbounded-main',previous:1,current:1,final:0,wpo:[0,0,0,1],keep:true},
 {name:'wpo-unbounded-final',previous:1,current:1,final:1,wpo:[0,0,0,1],keep:true},
 {name:'spline-static-occluded-main',previous:1,current:1,final:0,spline:0,keep:false},
 {name:'spline-static-occluded-final',previous:1,current:1,final:1,spline:0,keep:false},
 {name:'spline-deformed-near-plane-main',previous:1,current:1,final:0,spline:-800,keep:true},
 {name:'spline-deformed-near-plane-final',previous:1,current:1,final:1,spline:-800,keep:true},
 {name:'gpu-instance-static-occluded-main',previous:1,current:1,final:0,gpuZ:0,keep:false},
 {name:'gpu-instance-static-occluded-final',previous:1,current:1,final:1,gpuZ:0,keep:false},
 {name:'gpu-instance-moved-near-main',previous:1,current:1,final:0,gpuZ:-800,keep:true},
 {name:'gpu-instance-moved-near-final',previous:1,current:1,final:1,gpuZ:-800,keep:true},
 {name:'gpu-instance-wpo-expanded',previous:1,current:1,final:0,gpuZ:0,gpuWPO:[0,0,800,0],keep:true},
 {name:'gpu-instance-wpo-unbounded',previous:1,current:1,final:1,gpuZ:0,gpuWPO:[0,0,0,1],keep:true},
 {name:'input-error',previous:0,current:0,final:1,error:32,keep:false},
 // Count overflow and the sentinel keys both report errors. Consumers reject
 // the entire result when any error bit is set, including its valid prefix.
 {name:'input-overflow',previous:0,current:0,final:1,overflow:true,expectedError:3},
 {name:'foreign-page',previous:0,current:0,final:1,replace:0,expectedError:2},
 {name:'invalid-cluster',previous:0,current:0,final:1,replace:(1<<8)|255,expectedError:2},
];
for(const capacity of [1,63,64,65,257,16384])for(const keep of [true,false])
 cases.push({name:`capacity-${capacity}-${keep?'visible':'occluded'}`,previous:keep?0:1,current:1,final:0,keep,capacity});
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try {
 const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await tab.evaluate(async ({code,metadata,page,keys,cases,local})=>{
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
    const capacity=test.capacity||keys.length+2;
    const candidates=test.capacity?Array.from({length:capacity},(_,i)=>keys[i%keys.length]):keys;
    const list=Array.from({length:capacity},(_,i)=>candidates[i]??0xffffffff);if(test.replace!==undefined)list[0]=test.replace;
    const state=[test.overflow?capacity+1:candidates.length,test.error||0,123,456];
    const instance=new Float32Array(84);
    instance.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,test.gpuZ||0,1],32);
    instance.set(test.gpuWPO||[0,0,0,0],76);
    const resources={ClusterPageData:cluster,
     WebInstanceData:makeBuffer(instance,GPUBufferUsage.STORAGE),
     WebStreamingPageOwners:makeBuffer(new Uint32Array([0xffffffff]),GPUBufferUsage.STORAGE),
     WebOcclusionInputKeys:makeBuffer(new Uint32Array(list),GPUBufferUsage.STORAGE),
     WebOcclusionInputState:makeBuffer(new Uint32Array(state),GPUBufferUsage.STORAGE),
     WebOcclusionOutputKeys:makeBuffer(new Uint32Array(capacity+4).fill(0xffffffff).fill(local?0x12345678:0xffffffff,0,capacity),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),
     WebOcclusionOutputState:makeBuffer(new Uint32Array([local?99:0,local?99:0,local?99:0,local?99:0,0x12345678,0x12345678,0x12345678,0x12345678]),GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC)};
    const data=new ArrayBuffer(b.$Globals.paddedSize),u=new Uint32Array(data),f=new Float32Array(data);
    const matrix=[.01,0,0,0,0,.01,0,0,0,0,.001,0,0,0,.4,1];
    // Native spline bounds enclose slices with spheres and are wider than the
    // rigid box. Keep those bounds inside the test frustum to exercise HZB,
    // rather than the conservative off-screen early-out.
    if(test.spline!==undefined)matrix[0]=matrix[5]=.002;
    // Straight X-directed spline, identity cross section, with a world-Z
    // translation. Bounds must use the deformation before HZB projection.
    const splineData=new ArrayBuffer(112),sf=new Float32Array(splineData),su=new Uint32Array(splineData);
    sf.set([-100,0,test.spline||0,200,100,0,test.spline||0,0,200,0,0,0]);
    su[17]=su[18]=su[22]=0x3c003c00;su[19]=0xffffffff;
    sf[20]=1/200;sf[21]=.5;
    su[24]=0x7fff7fff;su[25]=0x3c00ffff;su[26]=0x7fff7fff;su[27]=0xffff7fff;
    const values={WebInstanceDataOffset:[test.gpuZ!==undefined?0:0xffffffff],PageConstants:[0,0,0,0],MaxVisibleClusters:[capacity],WebOcclusionFirstRootPage:[1],WebOcclusionNumRootPages:[1],
     WebOcclusionPreviousLocalToClip:matrix,WebOcclusionCurrentLocalToClip:matrix,WebOcclusionPreviousRect:[0,0,128,128],WebOcclusionCurrentRect:[0,0,128,128],
     WebOcclusionPreviousExtent:[128,128],WebOcclusionCurrentExtent:[128,128],WebOcclusionPreviousMaxMip:[7],WebOcclusionCurrentMaxMip:[7],WebOcclusionFinal:[test.final],
     WebOcclusionWPOBounds:test.wpo||[0,0,0,0],WebSplineEnabled:[test.spline!==undefined?1:0],WebSplineParams:[...su]};
    for(const m of b.$Globals.members){if(!values[m.name])throw Error('Unhandled '+m.name);(m.name.endsWith('LocalToClip')||m.name==='WebOcclusionWPOBounds'?f:u).set(values[m.name],m.offset/4);}
    resources.$Globals=makeBuffer(new Uint8Array(data),GPUBufferUsage.UNIFORM);
    const group=device.createBindGroup({layout,entries:bindings.map(v=>({binding:v.binding,resource:
     v.name==='WebOcclusionPrevious'?textures[test.previous].createView():v.name==='WebOcclusionCurrent'?textures[test.current].createView():
     {buffer:resources[v.name],...(v.name==='WebOcclusionOutputKeys'?{size:capacity*4}:v.name==='WebOcclusionOutputState'?{size:16}:{})}}))});
    const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(local?1:Math.ceil(capacity/64));pass.end();
    const reads=[];for(const name of ['WebOcclusionOutputKeys','WebOcclusionOutputState']){const size=resources[name].size,buffer=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyBufferToBuffer(resources[name],0,buffer,0,size);reads.push(buffer);}
    device.queue.submit([enc.finish()]);const output=[];for(const buffer of reads){await buffer.mapAsync(GPUMapMode.READ);output.push(Array.from(new Uint32Array(buffer.getMappedRange())));buffer.unmap();buffer.destroy();}
    results.push({name:test.name,keys:output[0],state:output[1]});for(const [name,buffer] of Object.entries(resources))if(name!=='ClusterPageData')buffer.destroy();
   }
   const error=await device.popErrorScope();if(error)throw Error(error.message);return {results,errors,features:[...device.features]};
  }finally{device.destroy();}
 },{code:fs.readFileSync(shader,'utf8'),metadata,page:[...page],keys,cases,local});
 assert.deepEqual(result.errors,[]);
 for(let i=0;i<cases.length;i++){
  const c=cases[i],r=result.results[i];assert.equal(r.name,c.name);assert.equal(r.state[1],c.error||c.expectedError||0);
  const capacity=c.capacity||keys.length+2,candidates=c.capacity?Array.from({length:capacity},(_,i)=>keys[i%keys.length]):keys;
  assert(r.state[0]<=capacity);
  assert.deepEqual(r.keys.slice(-4),Array(4).fill(0xffffffff));assert.deepEqual(r.state.slice(4),Array(4).fill(0x12345678));
  if(!r.state[1]){const expected=c.keep?candidates:[];assert.equal(r.state[0],expected.length,c.name);assert.equal(r.state[2],candidates.length);
   assert.equal(r.state[3],expected.reduce((s,k)=>s+triangles.get(k),0));assert.deepEqual(r.keys.slice(0,r.state[0]).sort((a,b)=>a-b),[...expected].sort((a,b)=>a-b));}
  if(c.error){assert.equal(r.state[0],0);assert.equal(r.state[2],0);assert.equal(r.state[3],0);}
  assert(r.keys.slice(r.state[0]).every(k=>k===0xffffffff));r.pass=true;
 }
 const report={pass:true,local,...result,source:audit(__filename),inputs:[input,shader,nativeFile,native.products[0].file].map(audit),
  sources:['WebNaniteOcclusion.usf','WebNaniteHZB.ush','WebNaniteSpline.ush','WebNaniteInstanceData.ush'].map(f=>audit(path.join(root,'reference-engine/Engine/Shaders/Private/Nanite',f)))};
 fs.writeFileSync(path.join(__dirname,local?'results/nanite-local-occlusion-kernel.json':'results/nanite-occlusion.json'),JSON.stringify(report,null,2));console.log({pass:true,local,cases:cases.length});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
