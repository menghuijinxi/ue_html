'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {audit}=require('../../content-file-metadata.cjs');
const diagnostic=process.argv.includes('--diagnose-native-inputs');
const groom=process.argv.includes('--groom'),fixtureRoot=path.join(__dirname,groom?'groom-gpu':'fixtures');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const stageNames=['independent','dependent','decode','primitive'];
const stages=Object.fromEntries(stageNames.map(name=>[name,{code:fs.readFileSync(path.join(__dirname,'shaders',name+'.wgsl'),'utf8').replace(/^\uFEFF/,''),metadata:read(path.join(__dirname,'shaders',name+'.json'))}]));
const floatView=new DataView(new ArrayBuffer(4));
const asFloat=u=>{floatView.setUint32(0,u,true);return floatView.getFloat32(0,true);};
const extract=(v,n,b)=>Math.floor(v/2**b)%2**n;
const normalize=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
function decode(page,c,v){
 const count=page.readUInt32LE(0)&65535,word=(row,col)=>page.readUInt32LE(16+(row*count+c)*16+col*4);
 const bits=(address,bit,n)=>{assert(address+Math.ceil((bit+n)/8)<=page.length);let out=0;for(let i=0;i<n;i++)out+=((page[address+((bit+i)>>3)]>>((bit+i)&7))&1)*2**i;return out;};
 const precision=extract(word(1,3),6,3)-20,posBits=[9,14,19].map(i=>extract(word(1,3),5,i)),start=[0,1,2].map(i=>word(1,i)|0);
 let bit=v*posBits.reduce((a,b)=>a+b,0);const p=posBits.map((n,i)=>{const a=(bits(word(0,0)>>>14,bit,n)+start[i])*2**-precision;bit+=n;return a;});
 const address=word(5,0)&0x3fffff,attrBits=word(5,0)>>>22,normalBits=word(1,3)>>>24&15;
 bit=v*attrBits;const oct=[0,1].map(()=>{const a=bits(address,bit,normalBits)*2/(2**normalBits-1)-1;bit+=normalBits;return a;});
 let normal=[...oct,1-Math.abs(oct[0])-Math.abs(oct[1])],t=Math.min(1,Math.max(0,-normal[2]));
 normal[0]+=normal[0]>=0?-t:t;normal[1]+=normal[1]>=0?-t:t;normal=normalize(normal);
 if(word(5,1)&(1<<22))bit+=(word(1,3)>>>28)+1;
 const encodedScale=extract(word(6,2),10,16),exponent=encodedScale>>>5,mantissa=encodedScale&31;
 const scale=exponent?2**(exponent-15)*(1+mantissa/32):2**-14*mantissa/32;
 const radiusBits=extract(word(6,2),4,26),hasRadius=!!(word(6,2)&0x40000000);
 const radius=Math.fround(bits(address,bit,hasRadius?radiusBits:0)*scale);bit+=hasRadius?radiusBits:0;
 for(const offset of [0,4,8,12])bit+=extract(word(0,3),4,offset);
 const uv=[],numUVs=extract(word(5,1),3,24),info=word(5,1)&0x3fffff;
 assert.equal(numUVs,2);
 for(let i=0;i<4;i++){
  const header=page.readUInt32LE(info+i*4),n=header&31,encoded=(header>>>5)+bits(address,bit,n);bit+=n;
  const mask=2**19-1,negative=encoded<=mask,a=asFloat((0x3f000000+((negative?~encoded:encoded)&mask)*512)>>>0);
  uv.push(Math.min(a*2-1,a)*(negative?-1:1));
 }
 const points=extract(word(6,2),8,8)||256;const curve=Math.floor(v/points),encoding=word(5,3);let material=0xffffffff;
 if(encoding<0xfe000000){const a=extract(encoding,7,18)+1,b=extract(encoding,7,25);material=extract(encoding,6,curve<a?0:curve<a+b?6:12);}
 else{const at=extract(encoding,19,0)*4,ranges=extract(encoding,6,19)+1;for(let i=0;i<ranges;i++){const r=page.readUInt32LE(at+i*4);if(curve>=(r&255)&&curve<(r&255)+extract(r,8,8)){material=extract(r,6,16);break;}}}
 assert(material<64);return {p,normal,radius,uv,material,scale,precision,flags:word(4,3)&15,curves:extract(word(6,2),8,0),points,vertices:word(0,0)&16383};
}
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true}),results=[];
 try{
  const tab=await browser.newPage();await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
  for(const name of fs.readdirSync(fixtureRoot)){
   const dir=path.join(fixtureRoot,name),inputFile=path.join(dir,'gpu-inputs.json');if(!fs.existsSync(inputFile))continue;
   const input=read(inputFile);for(const a of [...input.inputs,...input.products,input.source])assert.equal(audit(a.file).sha256,a.sha256);
   const binaries=Object.fromEntries(['pages','install','dependencies'].map(n=>[n,[...fs.readFileSync(path.join(dir,n+'.bin'))]]));
   const gpu=await tab.evaluate(async({stages,input,binaries})=>{
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter.features.has('subgroups')||adapter.info.subgroupMinSize<32)throw Error('Native transcode subgroup unavailable');
    const device=await adapter.requestDevice({requiredFeatures:['subgroups']}),errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
    try{
     const pipelines={};for(const [name,stage]of Object.entries(stages))pipelines[name]=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:stage.code}),entryPoint:stage.metadata.webEntry}});
     const owned=[],make=(bytes,usage=GPUBufferUsage.STORAGE)=>{const b=device.createBuffer({size:bytes.byteLength,usage:usage|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,bytes);owned.push(b);return b;};
     const output=make(new Uint8Array(input.gpuBytes)),clusters=make(new Uint8Array(input.fixture.clusters*48)),points=make(new Uint8Array(input.fixture.clusters*256*64));
     const primitives=make(new Uint8Array(input.fixture.clusters*259*16));
     const resources={SrcPageBuffer:make(new Uint8Array(binaries.pages)),ClusterInstallInfoBuffer:make(new Uint8Array(binaries.install)),PageDependenciesBuffer:make(new Uint8Array(binaries.dependencies)),DstPageBuffer:output,ClusterPageData:output,DecodedClusters:clusters,DecodedPoints:points,PrimitiveResults:primitives};
     resources.InstallInfo=resources.ClusterInstallInfoBuffer;
     const encoder=device.createCommandEncoder();
     function dispatch(name,start,count){
      const stage=stages[name],values={PageConstants:[0,input.streamPages,0,0],StartClusterIndex:[start],NumClusters:[count],ZeroUniform:[0],ClusterCount:[input.fixture.clusters]};
      const globals=stage.metadata.spirvBindings.find(b=>b.name==='$Globals'),bytes=new Uint32Array(globals.paddedSize/4);
      for(const m of globals.members){if(!values[m.name])throw Error('Unknown uniform '+m.name);bytes.set(values[m.name],m.offset/4);}
      const bindings={...resources,$Globals:make(bytes,GPUBufferUsage.UNIFORM)},pass=encoder.beginComputePass(),pipeline=pipelines[name];pass.setPipeline(pipeline);
      for(let group=0;group<=Math.max(...stage.metadata.spirvBindings.map(b=>b.group));group++){
       const entries=stage.metadata.spirvBindings.filter(b=>b.group===group).map(b=>{if(!bindings[b.name])throw Error('Unknown binding '+b.name);return {binding:b.binding,resource:{buffer:bindings[b.name]}};});
       pass.setBindGroup(group,device.createBindGroup({layout:pipeline.getBindGroupLayout(group),entries}));
      }
      pass.dispatchWorkgroups(count);pass.end();
     }
     dispatch('independent',0,input.fixture.clusters);
     for(const p of input.passes)dispatch('dependent',p.start,p.count);
     dispatch('decode',0,input.fixture.clusters);
     dispatch('primitive',0,input.fixture.clusters);
     const reads={};for(const [name,buffer]of Object.entries({page:output,clusters,points,primitives})){
      const r=device.createBuffer({size:buffer.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});encoder.copyBufferToBuffer(buffer,0,r,0,buffer.size);reads[name]=r;
     }
     device.queue.submit([encoder.finish()]);const result={errors};
     for(const [name,buffer]of Object.entries(reads)){
      await buffer.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(buffer.getMappedRange());let s='';for(let i=0;i<bytes.length;i+=32768)s+=String.fromCharCode(...bytes.subarray(i,i+32768));result[name]=btoa(s);buffer.unmap();buffer.destroy();
     }
     const error=await device.popErrorScope();if(error)throw Error(error.message);for(const b of owned)b.destroy();return result;
    }finally{device.destroy();}
   },{stages,input,binaries});
   assert.deepEqual(gpu.errors,[]);const output=Buffer.from(gpu.page,'base64'),clusters=Buffer.from(gpu.clusters,'base64'),points=Buffer.from(gpu.points,'base64'),primitives=Buffer.from(gpu.primitives,'base64');
   fs.writeFileSync(path.join(dir,'gpu-pages.bin'),output);fs.writeFileSync(path.join(dir,'gpu-clusters.bin'),clusters);fs.writeFileSync(path.join(dir,'gpu-points.bin'),points);
   fs.writeFileSync(path.join(dir,'gpu-primitives.bin'),primitives);
   const source=fs.readFileSync(path.join(dir,'source-points.bin')),materials=fs.readFileSync(path.join(dir,'source-materials.bin')),installs=fs.readFileSync(path.join(dir,'install.bin'));
   const key=(p,precision)=>p.map(x=>Math.round(x*2**precision)).join(',');
   const originals=new Map();for(let i=0;i<input.fixture.points;i++){
    const values=Array.from({length:11},(_,j)=>source.readFloatLE((i*11+j)*4)),k=key(values.slice(0,3),input.fixture.positionPrecision);
    assert(!originals.has(k),'Original fixture points collide after native quantization');originals.set(k,{values,index:i,material:materials.readInt32LE(Math.floor(i/input.fixture.pointsPerCurve)*4)});
   }
   const originalByIndex=[...originals.values()];
   const findOriginal=want=>{
    if(!groom)return originals.get(key(want.p,input.fixture.positionPrecision));
    // Root UV and strand U identify an authored point without depending on the
    // encoded position under test. Groom resamples its source with a cubic curve.
    const side=Math.ceil(Math.sqrt(input.fixture.curves)),x=Math.round(want.uv[2]*side),y=Math.round(want.uv[3]*side);
    const curve=y*side+x,point=Math.round(want.uv[0]*(input.fixture.pointsPerCurve-1));
    assert(x>=0&&x<side&&curve>=0&&curve<input.fixture.curves&&point>=0&&point<input.fixture.pointsPerCurve);
    const original=originalByIndex[curve*input.fixture.pointsPerCurve+point];assert(original);
    for(let j=0;j<3;j++)assert(Math.abs(want.p[j]-original.values[j])<=.5*2**-input.fixture.positionPrecision+1e-4,'Groom independent resampled position');
    return original;
   };
   const seen=new Set(),allSourcePoints=new Set(),materialMismatches=[],maxError={position:0,normal:0,radius:0,uv:0,sourceRadius:0,sourceNormal:0};let vertices=0,leafCurves=0,leafPoints=0,primitiveChecks=0,segments=0;
   for(let i=0;i<input.fixture.clusters;i++){
    const at=installs.readUInt32LE(i*16+8),page=output.subarray(at),cluster=installs.readUInt32LE(i*16)&255,meta=decode(page,cluster,0);
    assert.equal(clusters.readUInt32LE(i*48),meta.vertices);assert.equal(clusters.readUInt32LE(i*48+4),meta.curves);assert.equal(clusters.readUInt32LE(i*48+8),meta.points);
    assert.equal(clusters.readUInt32LE(i*48+16),1);assert.equal(meta.vertices,meta.curves*meta.points);
    const leaf=!!(meta.flags&4);if(leaf)leafCurves+=meta.curves;
    const ids=new Set();
    for(let v=0;v<259;v++){
     const valid=v+1<meta.vertices&&v%meta.points+1<meta.points;
     const got=Array.from({length:4},(_,j)=>primitives.readUInt32LE((i*259+v)*16+j*4));
     const material=valid?decode(page,cluster,v).material:0xffffffff;
     const id=valid?((i+1)*256+v):0;
     assert.deepEqual(got,[+valid,material,id,(meta.vertices-meta.curves)*2],`${name} ${i}:${v} primitive identity/material`);
     if(valid){assert(!ids.has(id),'Distinct segments alias the same visibility ID');ids.add(id);segments++;}
     primitiveChecks++;
    }
    for(let v=0;v<meta.vertices;v++){
     const want=decode(page,cluster,v),base=(i*256+v)*64,got=Array.from({length:16},(_,j)=>points.readFloatLE(base+j*4));
     for(const [name,a,b,limit]of [['position',want.p,got.slice(0,3),1e-6],['normal',want.normal,got.slice(4,7),1e-5],['radius',[want.radius],[got[3]],1e-6],['uv',want.uv,got.slice(8,12),4e-6]]){
      for(let j=0;j<a.length;j++){const e=Math.abs(a[j]-b[j]);maxError[name]=Math.max(maxError[name],e);assert(e<=limit,`${input.name} ${i}:${v} ${name}: ${a[j]} != ${b[j]}`);}
     }
     assert.equal(got[7],want.material);vertices++;
     const anyOriginal=findOriginal(want);
     assert(anyOriginal,`${name}: simplified curve changed an authored point`);
     allSourcePoints.add(anyOriginal.index);
     if(!leaf&&want.material!==anyOriginal.material)materialMismatches.push({cluster:i,point:v,original:anyOriginal.index,want:anyOriginal.material,got:want.material,leaf:false});
     if(!diagnostic)assert.equal(want.material,anyOriginal.material,'Original material at every curve LOD');
     if(leaf){
      const k=key(want.p,input.fixture.positionPrecision),original=findOriginal(want);assert(original,`${name}: missing original leaf point ${k}`);seen.add(original.index);leafPoints++;
      if(want.material!==original.material)materialMismatches.push({cluster:i,point:v,original:original.index,want:original.material,got:want.material});
      if(!diagnostic)assert.equal(want.material,original.material,'Original per-curve material');
      const radiusError=Math.abs(want.radius-original.values[6]);maxError.sourceRadius=Math.max(maxError.sourceRadius,radiusError);
      // Native radius quantization truncates an 8-bit value and stores the
      // cluster scale in a 5-bit-mantissa positive float. Keep both bounds.
      assert(radiusError<=original.values[6]/32+want.scale*1.04+1e-6,'Original radius exceeds native quantization bounds');
      const angle=1-want.normal.reduce((s,x,j)=>s+x*original.values[3+j],0);maxError.sourceNormal=Math.max(maxError.sourceNormal,angle);assert(angle<.0001);
      for(let j=0;j<4;j++)assert(Math.abs(want.uv[j]-original.values[7+j])<.00004,'Original UV quantization');
     }
    }
   }
   if(!diagnostic){assert.equal(seen.size,input.fixture.points);assert.equal(leafPoints,input.fixture.points);assert.equal(leafCurves,input.fixture.curves);}
   const pass=materialMismatches.length===0&&seen.size===input.fixture.points&&leafPoints===input.fixture.points&&leafCurves===input.fixture.curves;
   const result={pass,gpuDecodingMatchesCPU:true,name,vertices,leafPoints,leafCurves,allSourcePoints:allSourcePoints.size,materialMismatches,primitiveChecks,segments,maxError,gpuErrors:gpu.errors,input:audit(inputFile),outputs:['gpu-pages.bin','gpu-clusters.bin','gpu-points.bin','gpu-primitives.bin'].map(f=>audit(path.join(dir,f)))};
   results.push(result);console.log(JSON.stringify(result));
  }
  assert.equal(results.length,groom?4:29);const pass=results.every(r=>r.pass);
  fs.writeFileSync(path.join(__dirname,(groom?'groom-':'')+(diagnostic?'native-input-diagnostic.json':'decode.json')),JSON.stringify({pass,diagnostic,groom,date:new Date().toISOString(),source:audit(__filename),results,shaderSources:['WebCurveDecode.usf','WebCurvePrimitive.usf','WebCurveFeatures.ush','../../../../reference-engine/Engine/Shaders/Private/Nanite/WebNaniteCurves.ush'].map(n=>audit(path.join(__dirname,n))),shaders:stageNames.flatMap(n=>['json','wgsl','webshader'].map(e=>audit(path.join(__dirname,'shaders',n+'.'+e))))},null,2)+'\n');
  if(!pass)process.exitCode=1;
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
