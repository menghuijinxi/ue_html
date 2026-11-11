'use strict';
// Exercise an actual Cooked masked-material fragment shader. The old shader
// must reproduce unwanted VSM writes; the new one must preserve both masks
// and actual VSM writes, including the static page layer.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const [oldInput,newConversion,tag]=process.argv.slice(2);
assert(oldInput&&newConversion&&/^[a-z0-9-]+$/.test(tag));
const read=f=>JSON.parse(fs.readFileSync(f));
const before=read(oldInput);assert.equal(before.shaderName,'TShadowDepthPSCombined');
const candidates=fs.readdirSync(newConversion).map(n=>path.join(newConversion,n,'input.json')).filter(fs.existsSync)
  .filter(f=>{const d=read(f);return d.shaderName===before.shaderName&&d.description===before.description;});
assert.equal(candidates.length,1,'Select the same actual material permutation');
const shaders=[oldInput,candidates[0]].map(input=>{
  const d=read(input),file=path.join(path.dirname(input),'output.wgsl');
  return {input:audit(input),source:audit(file),code:fs.readFileSync(file,'utf8'),metadata:d.metadata};
});
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);
fs.copyFileSync(__filename,path.join(output,'source.cjs'));
shaders.forEach((s,i)=>{fs.copyFileSync(s.input.file,path.join(output,i+'-input.json'));fs.copyFileSync(s.source.file,path.join(output,i+'-shader.wgsl'));});
const report={pass:false,source:audit(__filename),shaders:shaders.map(({code,metadata,...s})=>s),
  boundary:'Real Cooked M_Color combined shadow pixel shaders with a controlled fullscreen vertex shader and known material/virtual page inputs. '
    +'Hardware depth and the atomic VSM mirror are both read back; this is a correctness test, not an FPS measurement.'};
(async()=>{let browser;try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
  await page.goto('http://127.0.0.1:8765');
  report.gpu=await page.evaluate(async shaders=>{
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[],results=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    try{
      for(const [index,s] of shaders.entries()) {
        const location=/@location\((\d+)u\) @interpolate\(flat\)/.exec(s.code)?.[1];if(location===undefined)throw Error('Missing page info interpolant');
        const vs=device.createShaderModule({code:`struct O {@builtin(position) p:vec4f,@location(${location}) @interpolate(flat) page:u32};
          @group(0) @binding(0) var<uniform> page:u32;
          @vertex fn main(@builtin(vertex_index) i:u32)->O {var o:O;
          o.p=vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0.5,1);o.page=page;return o;}`});
        const ps=device.createShaderModule({code:s.code});
        const compilation=await ps.getCompilationInfo();if(compilation.messages.some(m=>m.type==='error'))throw Error('Cooked shader failed compilation');
        const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:vs,entryPoint:'main'},
          fragment:{module:ps,entryPoint:s.metadata.webEntry,targets:[]},
          depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
        for(const mode of [8,1]) for(const mask of [0,1]) for(const staticPage of [0,1]) {
          const buffers=[],textures=[],resources={};
          const save=b=>{buffers.push(b);return b;};
          const atomic=new Uint32Array(64+32);atomic.set([4,4,4,2]);
          resources.ShadowDepthPass_OutDepthBufferArray=save(make(atomic,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC));
          for(const b of s.metadata.spirvBindings) {
            if(b.descriptorType===6) {
              const data=new Uint8Array(b.paddedSize||b.size),dv=new DataView(data.buffer);
              for(const m of b.members) {
                if(m.name.endsWith('_ShadowDepthType'))dv.setUint32(m.offset,mode,true);
                if(m.name==='VirtualShadowMap_StaticCachedArrayIndex')dv.setUint32(m.offset,1,true);
                if(m.name==='Material_PreshaderBuffer')dv.setFloat32(m.offset+3*16+8,mask,true);
              }
              resources[b.name]=save(make(data,GPUBufferUsage.UNIFORM));
            } else if(b.name==='ShadowDepthPass_PackedNaniteViews') {
              resources[b.name]=save(make(new Uint8Array(b.storageElementStride),GPUBufferUsage.STORAGE));
            } else if(b.name==='ShadowDepthPass_VirtualSmPageTable') {
              const t=device.createTexture({size:[1,1],format:'r32uint',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});textures.push(t);
              device.queue.writeTexture({texture:t},new Uint32Array([0x40000000]),{bytesPerRow:4},[1,1]);resources[b.name]=t.createView();
            }
          }
          const pageBuffer=save(make(new Uint32Array([staticPage<<16]),GPUBufferUsage.UNIFORM));
          const group0=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:pageBuffer}}]});
          const group1=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:s.metadata.spirvBindings.map(b=>{
            if(b.group!==1||!resources[b.name])throw Error('Unrecognized actual shader binding: '+b.name);
            return {binding:b.binding,resource:b.descriptorType===2?resources[b.name]:{buffer:resources[b.name]}};
          })});
          const depth=device.createTexture({size:[4,4],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});textures.push(depth);
          const readback=save(device.createBuffer({size:1024+atomic.byteLength,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}));
          const command=device.createCommandEncoder(),pass=command.beginRenderPass({colorAttachments:[],
            depthStencilAttachment:{view:depth.createView(),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});
          pass.setPipeline(pipeline);pass.setBindGroup(0,group0);pass.setBindGroup(1,group1);pass.draw(3);pass.end();
          command.copyTextureToBuffer({texture:depth,aspect:'depth-only'},{buffer:readback,bytesPerRow:256},[4,4]);
          command.copyBufferToBuffer(resources.ShadowDepthPass_OutDepthBufferArray,0,readback,1024,atomic.byteLength);
          device.queue.submit([command.finish()]);await readback.mapAsync(GPUMapMode.READ);
          const mapped=readback.getMappedRange(),z=new Float32Array(mapped,0,256),words=new Uint32Array(mapped,1024);
          let depthErrors=0,atomicErrors=0;
          for(let y=0;y<4;y++)for(let x=0;x<4;x++)if(z[y*64+x] !== (mask?0.5:1))depthErrors++;
          const writes=mask&&(index===0||mode===1);
          for(let i=0;i<words.length;i++) {
            const expected=i<64?atomic[i]:writes&&Math.floor((i-64)/16)===staticPage?0x3f000000:0;
            if(words[i]!==expected)atomicErrors++;
          }
          results.push({index,mode,mask,staticPage,depthErrors,atomicErrors,expectedVsmPixels:writes?16:0});
          readback.unmap();buffers.forEach(b=>b.destroy());textures.forEach(t=>t.destroy());
        }
      }
      await device.queue.onSubmittedWorkDone();return {results,errors};
    }finally{device.destroy();}
  },shaders);
  assert.deepEqual(report.gpu.errors,[]);assert.equal(report.gpu.results.length,16);
  assert(report.gpu.results.every(r=>r.depthErrors===0&&r.atomicErrors===0));report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}finally{await browser?.close();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}})();
