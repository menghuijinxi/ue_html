'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion'),input=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>read(f).shaderName==='FWebNaniteAssemblyTransformsCS').sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];
const metadata=read(input).metadata,code=fs.readFileSync(path.join(path.dirname(input),'output.wgsl'),'utf8');
const fixture=read(path.join(__dirname,'results/nanite-assembly/fixture/fixtures.json')).fixtures.find(v=>v.asset.includes('SkinSmall.'));
const transforms=fs.readFileSync(path.join(__dirname,'results/nanite-assembly/fixture/NaniteAssemblySkinSmall-transforms.bin'));
const attachments=fs.readFileSync(path.join(__dirname,'results/nanite-assembly/fixture/NaniteAssemblySkinSmall-attachments.bin'));
const tests=[
 {name:'static-original-transforms',skin:false},
 {name:'ordinary-static-proxy-without-resource-metadata',skin:false,missingResource:true},
 {name:'resource-offset-overrides-stale-primitive',skin:true,missingResource:true},
 {name:'single-and-blended-attachments',skin:true},
 {name:'previous-transform-slot',skin:true,slot:1},
 {name:'view-deformation-disabled',skin:true,disabled:true},
 {name:'reference-pose',skin:true,refpose:true,skinIndex:2},
 {name:'second-view-enabled',skin:true,view:1},
 {name:'second-view-disabled',skin:true,view:1,disabled:true},
 {name:'second-instance-tile',skin:true,instance:35},
 {name:'instanced-skinning-payload',skin:true,instance:35,skinIndex:2},
 {name:'partial-dispatch-range',skin:false,count:2},
 {name:'empty-dispatch-range',skin:true,count:0}
];
function bone(angle,scale,t){const c=Math.cos(angle),s=Math.sin(angle);return [c*scale[0],-s*scale[1],0,t[0],s*scale[0],c*scale[1],0,t[1],0,0,scale[2],t[2]].map(Math.fround);}
const bones=[bone(.21,[1.1,.8,1.2],[12,-22,30]),bone(-.37,[.7,1.2,.95],[-8,40,-11]),bone(-.12,[.9,1.3,.75],[-10,15,7]),bone(.15,[1.05,.9,1.25],[5,-20,19])];
function matrix(data,offset=0){const m=Array(16).fill(0);m[15]=1;for(let r=0;r<3;r++)for(let c=0;c<4;c++)m[c*4+r]=data[offset+r*4+c];return m;}
function multiply(a,b){return Array.from({length:16},(_,i)=>{let s=0;for(let k=0;k<4;k++)s+=a[Math.floor(i/4)*4+k]*b[k*4+i%4];return s;});}
function orthogonal(a){a=a.slice();const dot=(x,y)=>[0,1,2].reduce((s,i)=>s+a[x*4+i]*a[y*4+i],0);for(const [dst,src] of [[1,0],[2,0],[2,1]]){const f=dot(dst,src)/dot(src,src);for(let j=0;j<3;j++)a[dst*4+j]-=f*a[src*4+j];}return a;}
function expected(test){
 const values=[];
 for(let i=0;i<(test.count??4);i++){
  const t=matrix(Array.from({length:12},(_,j)=>transforms.readFloatLE((i*12+j)*4)));
  for(let phase=0;phase<3;phase++){
   let out=t;
   if(phase!==2&&test.skin&&!test.disabled){
    let skin=Array(16).fill(0);
    for(const w of fixture.instances[i].weights){
     const weight=fixture.instances[i].weights.length===1?1:Math.round(w.weight*255)/255;
     const b=test.refpose?matrix([1,0,0,0,0,1,0,0,0,0,1,0]):matrix(bones[((phase^(test.slot||0))*2)+w.bone]);
     skin=skin.map((v,j)=>v+b[j]*weight);
    }
    out=orthogonal(multiply(t,skin));
   }
   for(let r=0;r<3;r++)for(let c=0;c<4;c++)values.push(out[c*4+r]);
  }
 }
 return values;
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
  const gpu=await tab.evaluate(async({metadata,code,transforms,attachments,tests,bones})=>{
   const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:Math.min(16,adapter.limits.maxStorageBuffersPerShaderStage)}}),errors=[];
   device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
   try{
    const bindings=metadata.spirvBindings,isUniform=b=>b.name==='$Globals'||b.name==='Scene';
    const layout=device.createBindGroupLayout({entries:bindings.map(b=>({binding:b.binding,visibility:4,buffer:{type:isUniform(b)?'uniform':b.readOnlyStorage?'read-only-storage':'storage',...(isUniform(b)?{minBindingSize:b.paddedSize}:{})}}))});
    const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code}),entryPoint:metadata.webEntry}});
    const make=(data,uniform=false)=>{const b=device.createBuffer({size:data.byteLength,usage:(uniform?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;},results=[];
    for(const test of tests){
     const instance=test.instance??3,primitive=2,tilelog=5,tilestride=160,offset=7;
     const hierarchy=new Uint8Array(offset*4+transforms.length+attachments.length);hierarchy.set(transforms,offset*4);hierarchy.set(attachments,offset*4+transforms.length);
     const primitives=new Uint32Array(44*4*3),p=primitive*44*4;primitives[p]=test.skin?0x1000000:0;primitives[p+33*4+2]=offset;primitives[p+33*4+3]=4;primitives[p+29*4+3]=1;
     if(test.missingResource){primitives[p+33*4+2]=0xffffffff;primitives[p+33*4+3]=0;}
     const instances=new Uint32Array(tilestride*4*2);instances[(tilestride*(instance>>tilelog)+(instance&31))*4]=primitive|(test.skinIndex?0x10<<20:0);
     const payload=new Uint32Array(4);payload[1]=test.skinIndex||0;
     const headers=new Uint32Array(3*4);headers[primitive*4+1]=1;headers[primitive*4+3]=2|((test.slot||0)<<16)|(test.refpose?1<<23:0);
     const boneData=new Float32Array((1+(test.skinIndex||0)*2+4)*12);for(let i=0;i<4;i++)boneData.set(bones[i],(1+(test.skinIndex||0)*2+i)*12);
     // Installed UE 5.8.0's ref-pose provider stores identity transforms in
     // both shared slots; bIsRefPose suppresses the per-instance offset only.
     if(test.refpose)for(let i=0;i<4;i++)boneData.set([1,0,0,0,0,1,0,0,0,0,1,0],(1+i)*12);
     const mask=new Uint32Array(6);if(!test.disabled)mask[(test.view||0)*2+(instance>>5)]=(1<<(instance&31))>>>0;
     const raw=new Uint32Array(4*3*12+4).fill(0xdeadbeef);
     const resources={HierarchyBuffer:make(hierarchy),Scene_GPUScene_GPUScenePrimitiveSceneData:make(primitives),Scene_GPUScene_GPUSceneInstanceSceneData:make(instances),Scene_GPUScene_GPUSceneInstancePayloadData:make(payload),Scene_Skinning_Headers:make(headers),Scene_Skinning_BoneTransforms:make(boneData),Scene_ViewData_DeformingInstanceViewMask:make(mask),WebAssemblyTransformsOutput:make(raw)};
     const values={WebAssemblyInstanceId:instance,WebAssemblyViewId:test.view||0,WebAssemblyTransformCount:test.count??4,WebAssemblyTransformOffset:offset,Scene_GPUScene_GPUSceneInstanceDataTileSizeLog2:tilelog,Scene_GPUScene_GPUSceneInstanceDataTileSizeMask:31,Scene_GPUScene_GPUSceneInstanceDataTileStride:tilestride,Scene_ViewData_InstanceMaskWordStride:2};
     for(const b of bindings.filter(isUniform)){const data=new Uint32Array(b.paddedSize/4);for(const m of b.members){if(!(m.name in values))throw Error('Unhandled '+m.name);data[m.offset/4]=values[m.name];}resources[b.name]=make(data,true);}
     const group=device.createBindGroup({layout,entries:bindings.map(b=>({binding:b.binding,resource:{buffer:resources[b.name],...(b.name==='WebAssemblyTransformsOutput'?{size:4*3*48}:{})}}))});
     const read=device.createBuffer({size:raw.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();enc.copyBufferToBuffer(resources.WebAssemblyTransformsOutput,0,read,0,raw.byteLength);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange();results.push({name:test.name,words:[...new Uint32Array(bytes)],floats:[...new Float32Array(bytes)]});read.unmap();read.destroy();for(const b of Object.values(resources))b.destroy();
    }
    const error=await device.popErrorScope();if(error)throw Error(error.message);return {results,errors};
   }finally{device.destroy();}
  },{metadata,code,transforms:[...transforms],attachments:[...attachments],tests,bones});
  assert.deepEqual(gpu.errors,[]);let maxError=0;
  for(let i=0;i<tests.length;i++){
   const want=expected(tests[i]),got=gpu.results[i];assert.deepEqual(got.words.slice(want.length),Array(148-want.length).fill(0xdeadbeef),tests[i].name+' guard');
   for(let j=0;j<want.length;j++){const error=Math.abs(want[j]-got.floats[j]);maxError=Math.max(error,maxError);assert(error<=.0001+Math.abs(want[j])*.000002,`${tests[i].name} float${j}: ${got.floats[j]} expected${want[j]}`);}
  }
  fs.writeFileSync(path.join(__dirname,'results/nanite-assembly/transform-kernel-production.json'),JSON.stringify({pass:true,cases:tests.length,maxError,gpu,tests,bones,source:audit(__filename),inputs:[input,path.join(path.dirname(input),'output.wgsl'),path.join(__dirname,'results/nanite-hierarchy-shaders/verified.json'),path.join(__dirname,'results/nanite-assembly/verified.json')].map(audit)},null,2));console.log(JSON.stringify({pass:true,cases:tests.length,maxError,gpuErrors:gpu.errors.length}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
