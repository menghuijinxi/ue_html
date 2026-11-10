'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const local=process.argv.includes('--local'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const input=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>{const r=read(f);return r.shaderName==='FWebNaniteHierarchyCull_CS'&&r.shader.includes(`/FWebNaniteHierarchyCull_CS/${local?1:0}:`);})
 .sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs)[0];assert(input);
const shader=path.join(path.dirname(input),'output.wgsl'),metadata=read(input).metadata;
assert(metadata.spirvBindings.some(b=>b.name==='AssemblyTransforms'),'assembly transforms must survive compilation');
const nativeFile=path.resolve(process.argv.slice(2).find(v=>!v.startsWith('--'))||read(path.join(__dirname,'build/nanite-browser/package.json')).native.file),native=read(nativeFile);assert(native.pass);
const page=fs.readFileSync(native.products[0].file),n=page.readUInt32LE(0)&65535;
const full=[];for(let i=0;i<n;i++)if(page.readUInt32LE(16+(4*n+i)*16+12)&4)full.push(i);
const transforms=[
 [1,0,0,0,0,1,0,0,0,0,1,0],
 [1,0,0,150,0,1,0,0,0,0,1,0],
 [0,-.75,0,-130,1.2,0,0,90,0,0,.8,20],
 [1,0,0,0,0,-1,0,-150,0,0,1.4,-20]
];
const plane=[1,0,0,0],all=[0,0,0,1];
const cases=[
 {name:'repeated-part-visits',planes:Array(6).fill(all)},
 {name:'shared-queue-reuse-five-levels',planes:Array(6).fill(all),levels:5,chain:5},
 {name:'shared-queue-multiple-workgroups',planes:Array(6).fill(all),levels:5,chain:5,queue:40},
 {name:'translated-mirrored-frustum',planes:[plane,...Array(5).fill(all)]},
 {name:'translated-negative-frustum',planes:[[-1,0,0,-80],...Array(5).fill(all)]},
 {name:'all-outside',planes:[[1,0,0,-500],...Array(5).fill(all)]},
 {name:'node-queue-overflow',planes:Array(6).fill(all),queue:2,error:16},
 {name:'visible-list-overflow',planes:Array(6).fill(all),capacity:10,error:1},
 {name:'invalid-assembly',planes:Array(6).fill(all),invalid:true,error:8},
 {name:'depth-exhausted',planes:Array(6).fill(all),levels:1,error:4}
];
function cpu(test){
 const expected=[];
 for(let assembly=0;assembly<4;assembly++)for(const cluster of full){
  const at=(v,c)=>16+(v*n+cluster)*16+c*4;
  const center=[0,1,2].map(c=>page.readFloatLE(at(3,c))),extent=[0,1,2].map(c=>page.readFloatLE(at(4,c)));
  const m=transforms[assembly];
  const p=[0,1,2].map(c=>m[c*4]*center[0]+m[c*4+1]*center[1]+m[c*4+2]*center[2]+m[c*4+3]);
  const e=[0,1,2].map(c=>Math.abs(m[c*4])*extent[0]+Math.abs(m[c*4+1])*extent[1]+Math.abs(m[c*4+2])*extent[2]);
  if(test.planes.some(v=>v[3]+v[0]*p[0]+v[1]*p[1]+v[2]*p[2]+Math.abs(v[0])*e[0]+Math.abs(v[1])*e[1]+Math.abs(v[2])*e[2]<0))continue;
  expected.push([(1<<8)|cluster,assembly]);
 }
 return expected;
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
  const result=await tab.evaluate(async({code,metadata,page,n,cases,transforms,local})=>{
   const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:Math.min(16,adapter.limits.maxStorageBuffersPerShaderStage)}}),errors=[];
   device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
   try{
    const bindings=metadata.spirvBindings,b=Object.fromEntries(bindings.map(v=>[v.name,v]));
    const layout=device.createBindGroupLayout({entries:bindings.map(v=>({binding:v.binding,visibility:4,buffer:{type:v.name==='$Globals'?'uniform':v.readOnlyStorage?'read-only-storage':'storage',...(v.name==='$Globals'?{minBindingSize:v.paddedSize}:{})}}))});
    const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code}),entryPoint:metadata.webEntry}});
    const make=data=>{const v=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(v,0,data);return v;};
    const results=[];
    for(const test of cases){
     const cap=test.capacity||n*4,queue=test.queue||4,levels=test.levels||2,nodes=test.chain||2;
     const pages=new Uint8Array(page.length*2);pages.set(page,page.length);
     const tree=new ArrayBuffer(240*nodes),hu=new Uint32Array(tree),hf=new Float32Array(tree);
     function node(index,child,assembly,leaf,count){
      const p=index*60+child*4;
      hf.set([0,0,0,180],p);hf.set([0,0,0],p+16);hu[p+19]=0x7bff;
      hf.set([100,100,100],p+32);hu[p+35]=leaf?256:index+1;
      const misc=index*60+48+child*3;hu[misc]=leaf?0:0xffffffff;hu[misc+1]=(count<<16)|assembly;
     }
     for(let i=0;i<4;i++)node(0,i,test.invalid&&i===0?8:i,false,0);
     for(let j=1;j<nodes;j++)node(j,0,65535,j===nodes-1,j===nodes-1?n:0);
     const transformsData=new Float32Array(4*3*12);for(let i=0;i<4;i++)for(let j=0;j<3;j++)transformsData.set(transforms[i],(i*3+j)*12);
     const initial=new Uint32Array(1+queue*2);initial[0]=1;initial[1]=0;initial[2]=65535;
     const queueStride=1+queue*2,queueData=new Uint32Array(queueStride*2+4).fill(0x23456789);queueData.set(initial);
     const queues=[make(queueData)];
     const resources={ClusterPageData:make(pages),HierarchyBuffer:make(new Uint8Array(tree)),AssemblyTransforms:make(transformsData),
      WebStreamingPageOwners:make(new Uint32Array([0xffffffff])),WebInstanceData:make(new Float32Array(84)),
      WebStreamingRequests:make(new Uint32Array(6)),WebCullClusterKeys:make(new Uint32Array(cap+4).fill(0xffffffff)),
      WebCullClusterAssemblies:make(new Uint32Array(cap+4).fill(65535)),WebCullState:make(new Uint32Array(8).fill(0x12345678).fill(0,0,4))};
     for(let level=0;level<(local?1:levels);level++){
      const values={PageConstants:[0,0,0,0],RenderFlags:[0],WebRuntimeResourceID:[0],StreamingRequestsBufferVersion:[0],StreamingRequestsBufferSize:[2],
       HierarchyOffset:[0],NumHierarchyNodes:[nodes],WebCullQueueCapacity:[queue],WebCullInputNodeOffset:[level%2*queueStride],WebCullOutputNodeOffset:[(1-level%2)*queueStride],WebAssemblyCount:[4],FirstRootPage:[1],NumRootPages:[1],MaxVisibleClusters:[cap],
       LastLevel:[level+1===levels?1:0],WebLocalMaxLevels:[levels],WebLocalRootNode:[0],CullPlanes:test.planes.flat(),WebInstanceDataOffset:[0xffffffff],
       WebSplineEnabled:[0],WebSplineParams:Array(28).fill(0),WebCullLODMode:[0],WebCullLocalToView:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,500,1],WebCullLODParameters:[1,1,1,1]};
      const data=new ArrayBuffer(b.$Globals.paddedSize),u=new Uint32Array(data),f=new Float32Array(data);
      for(const m of b.$Globals.members){if(!values[m.name])throw Error('Unhandled '+m.name);(['CullPlanes','WebCullLocalToView','WebCullLODParameters'].includes(m.name)?f:u).set(values[m.name],m.offset/4);}
      const uniform=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(uniform,0,data);
      resources.$Globals=uniform;resources.WebCullNodes=queues[0];
      device.queue.writeBuffer(resources.WebCullNodes,(1-level%2)*queueStride*4,new Uint32Array([0]));
      const group=device.createBindGroup({layout,entries:bindings.map(v=>({binding:v.binding,resource:{buffer:resources[v.name],...(['WebCullClusterKeys','WebCullClusterAssemblies'].includes(v.name)?{size:cap*4}:v.name==='WebCullState'?{size:16}:{})}}))});
      const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(local?1:Math.ceil(queue*4/64));pass.end();device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();uniform.destroy();
     }
     const enc=device.createCommandEncoder(),reads=[];
     for(const buffer of [resources.WebCullState,resources.WebCullClusterKeys,resources.WebCullClusterAssemblies,queues[0]]){const size=buffer.size,v=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyBufferToBuffer(buffer,0,v,0,size);reads.push(v);}
     device.queue.submit([enc.finish()]);const output=[];for(const v of reads){await v.mapAsync(GPUMapMode.READ);output.push([...new Uint32Array(v.getMappedRange())]);v.unmap();v.destroy();}
     results.push({name:test.name,state:output[0],keys:output[1],assemblies:output[2],queueGuard:output[3].slice(-4)});
     for(const v of new Set([...Object.values(resources),...queues]))v.destroy();
    }
    const error=await device.popErrorScope();if(error)throw Error(error.message);return {results,errors};
   }finally{device.destroy();}
  },{code:fs.readFileSync(shader,'utf8'),metadata,page:[...page],n,cases,transforms,local});
  assert.deepEqual(result.errors,[]);
  for(let i=0;i<cases.length;i++){
   const t=cases[i],r=result.results[i],count=r.state[0];assert.equal(r.state[1],t.error||0,t.name);
   assert.deepEqual(r.state.slice(4),Array(4).fill(0x12345678));assert.deepEqual(r.keys.slice(-4),Array(4).fill(0xffffffff));assert.deepEqual(r.assemblies.slice(-4),Array(4).fill(65535));
   assert.deepEqual(r.queueGuard,Array(4).fill(0x23456789),'shared queue range guard');
   if(!t.error){const sort=(a,b)=>a[0]-b[0]||a[1]-b[1],expected=cpu(t),actual=r.keys.slice(0,count).map((k,j)=>[k,r.assemblies[j]]);assert.deepEqual(actual.sort(sort),expected.sort(sort),t.name);assert.equal(r.state[3],expected.reduce((s,[k])=>s+(page.readUInt32LE(16+(k&255)*16+4)&255),0));}
   r.pass=true;
  }
  const report={pass:true,local,...result,source:audit(__filename),inputs:[input,shader,nativeFile,native.products[0].file].map(audit),sources:[audit(path.join(__dirname,'results/nanite-hierarchy-shaders/verified.json'))]};
  fs.writeFileSync(path.join(__dirname,'results/nanite-assembly',local?'hierarchy-kernel-production-local.json':'hierarchy-kernel-production.json'),JSON.stringify(report,null,2));console.log({pass:true,local,cases:cases.length});
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
