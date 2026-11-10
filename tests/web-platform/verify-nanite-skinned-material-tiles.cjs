'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const assembly=process.argv.includes('--assembly');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const dir=path.join(__dirname,assembly?'results/nanite-assembly/shader-conversion':'results/nanite-hierarchy-shaders/conversion');
const shaderName=assembly?'FWebAssemblyGBufferTilesCS':'FWebNaniteGBufferTilesCS';
const inputs=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync)
 .filter(f=>read(f).shaderName===shaderName).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
assert(inputs.length);const input=inputs[0],metadata=read(input).metadata,code=fs.readFileSync(path.join(path.dirname(input),'output.wgsl'),'utf8');
const uploader=path.resolve(process.argv.find(v=>v.endsWith('verified.json'))||'results/nanite-uploader/20261110-230935/verified.json');
const native=read(uploader);assert(native.pass);const pageFile=native.products[0].file,page=fs.readFileSync(pageFile),count=page.readUInt32LE(0)&65535;
assert(count>=4);const skinFlagOffset=16+(5*count+1)*16+4;
const cases=[
 {name:'rigid-cluster',cluster:0,expected:[0,1,2,3]},
 {name:'skinned-cluster',cluster:1,expected:[0,1,2,3]},
 {name:'mixed-clusters',expected:[0,1,2,3]},
 {name:'wpo-clusters',wpo:true,expected:[0,1,2,3]},
 {name:'shared-part-records',parts:true,expected:[0,1,2,3]},
 {name:'wrong-owner',owner:24,expected:[]},
 {name:'wrong-view',view:1,expected:[]},
 {name:'wrong-material-slot',slot:1,expected:[]},
 {name:'failed-cull-state',error:2,expected:[]},
 {name:'overflowed-cull-state',count:5,expected:[]},
 {name:'short-visible-list',count:3,expected:[0,1,2]},
 {name:'nearer-ordinary-surface',depthMismatch:true,expected:[]},
 {name:'nonzero-tile-origin',origin:1,expected:[1,2,3]},
 {name:'clipped-last-tile',width:21,expected:[0,1,2]}
];
const result={pass:false,assembly,cases,source:audit(__filename),shader:audit(input),wgsl:audit(path.join(path.dirname(input),'output.wgsl')),uploader:audit(uploader),page:audit(pageFile)};
(async()=>{let browser;try{
 browser=await chromium.launch({channel:'msedge',headless:true});const tab=await browser.newPage();
 await tab.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 result.gpu=await tab.evaluate(async({metadata,code,page,skinFlagOffset,cases,assembly})=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));device.pushErrorScope('validation');
  try{
   const bindings=metadata.spirvBindings,textureNames=['WebGBufferVisibility','WebGBufferSceneDepth'];
   const layout=device.createBindGroupLayout({entries:bindings.map(b=>({binding:b.binding,visibility:4,
    ...(textureNames.includes(b.name)?{texture:{sampleType:b.name==='WebGBufferVisibility'?'uint':'unfilterable-float'}}:
      {buffer:{type:b.name==='$Globals'?'uniform':b.readOnlyStorage?'read-only-storage':'storage',...(b.name==='$Globals'?{minBindingSize:b.paddedSize}:{})}})}))});
   const pipeline=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:device.createShaderModule({code}),entryPoint:metadata.webEntry}});
   const make=(data,uniform=false)=>{const b=device.createBuffer({size:data.byteLength,usage:(uniform?GPUBufferUsage.UNIFORM:GPUBufferUsage.STORAGE)|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
   const output=[];
   for(const t of cases){
    const pages=new Uint8Array(page.length*2);pages.set(page,page.length);
    const flags=new DataView(pages.buffer),offset=page.length+skinFlagOffset;flags.setUint32(offset,flags.getUint32(offset,true)|(1<<23),true);
    const stride=assembly?3:2,records=new Uint32Array(4*stride);
    for(let i=0;i<4;i++){
     const packed=BigInt(2|(t.wpo?8:0))|(BigInt(t.view||0)<<5n)|(23n<<17n)|(BigInt(64+(t.cluster??i))<<41n);
     records.set([Number(packed&0xffffffffn),Number((packed>>32n)&0xffffffffn)],i*stride);
     if(assembly)records[i*stride+2]=t.parts?i*3:0xffffff;
    }
    const vis=new Uint32Array(32*8*2),depth=new Float32Array(32*8).fill(t.depthMismatch?.9:.8);
    const depthWord=new Uint32Array(new Float32Array([.8]).buffer)[0];
    for(let i=0;i<4;i++)vis.set([(i+1)<<8,depthWord],(4*32+i*8+4)*2);
    const textures={};
    for(const [name,format,data,bpp] of [['WebGBufferVisibility','rg32uint',vis,8],['WebGBufferSceneDepth','r32float',depth,4]]){
     const texture=device.createTexture({size:[32,8],format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
     device.queue.writeTexture({texture},data,{bytesPerRow:32*bpp},[32,8]);textures[name]=texture;
    }
    const resources={ClusterPageData:make(pages),VisibleClustersSWHW:make(records),WebStreamingPageOwners:make(new Uint32Array([0xffffffff])),
     WebGBufferMembers:make(new Uint32Array([0,4,t.slot||0,0,1,1,t.owner||23,0])),
     WebGBufferMemberStates:make(new Uint32Array([t.count??4,t.error||0,0,0])),
     WebGBufferTileOutput:make(new Uint32Array(12).fill(0xdeadbeef)),WebGBufferTileArgs:make(new Uint32Array([6,0,0,0,0xdeadbeef,0xdeadbeef]))};
    const values={PageConstants:[0,0,0,0],WebMaterialRect:[0,0,t.width||32,8],WebGBufferMemberCount:[1],WebGBufferTileOrigin:[t.origin||0,0]};
    const global=bindings.find(b=>b.name==='$Globals'),uniform=new Uint32Array(global.paddedSize/4);
    for(const m of global.members){if(!values[m.name])throw Error('Unhandled '+m.name);uniform.set(values[m.name],m.offset/4);}
    resources.$Globals=make(uniform,true);
    const group=device.createBindGroup({layout,entries:bindings.map(b=>({binding:b.binding,resource:textures[b.name]?textures[b.name].createView():
     {buffer:resources[b.name],...(b.name==='WebGBufferTileOutput'?{size:32}:b.name==='WebGBufferTileArgs'?{size:16}:{})}}))});
    const enc=device.createCommandEncoder(),p=enc.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,group);p.dispatchWorkgroups(4-(t.origin||0));p.end();
    const reads=[];for(const name of ['WebGBufferTileOutput','WebGBufferTileArgs']){const b=device.createBuffer({size:resources[name].size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});enc.copyBufferToBuffer(resources[name],0,b,0,b.size);reads.push(b);}
    device.queue.submit([enc.finish()]);const valuesOut=[];for(const b of reads){await b.mapAsync(GPUMapMode.READ);valuesOut.push([...new Uint32Array(b.getMappedRange())]);b.unmap();b.destroy();}
    output.push({name:t.name,tiles:valuesOut[0],args:valuesOut[1]});for(const b of Object.values(resources))b.destroy();for(const v of Object.values(textures))v.destroy();
   }
   const error=await device.popErrorScope();if(error)throw Error(error.message);return {output,errors};
  }finally{device.destroy();}
 },{metadata,code,page:[...page],skinFlagOffset,cases,assembly});
 assert.deepEqual(result.gpu.errors,[]);result.failures=[];
 for(let i=0;i<cases.length;i++){
  const t=cases[i],r=result.gpu.output[i];
  try{assert.deepEqual(r.args,[6,t.expected.length,0,0,0xdeadbeef,0xdeadbeef]);
   assert.deepEqual(r.tiles.slice(8),Array(4).fill(0xdeadbeef));
   const tiles=Array.from({length:r.args[1]},(_,i)=>r.tiles.slice(i*2,i*2+2)).sort((a,b)=>a[0]-b[0]);
   assert.deepEqual(tiles,t.expected.map(x=>[x,0]));
  }catch(e){result.failures.push({name:t.name,failure:e.message,actual:r});}
 }
 assert.deepEqual(result.failures,[]);result.pass=true;
}catch(e){result.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();const file=path.join(__dirname,assembly?'results/nanite-assembly/material-tiles.json':'results/nanite-skinning/material-tiles.json');fs.writeFileSync(file,JSON.stringify(result,null,2));console.log({pass:result.pass,cases:cases.length,failures:result.failures?.map(f=>f.name)});}})();
