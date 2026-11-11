'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const input = path.join(__dirname, 'shaders/virtual-shadow-sync-probe.hlsl');
const flagsFile = path.join(root, 'reference-engine/Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapPageAccessCommon.ush');
const helper = path.join(root, 'reference-engine/Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowPoolSync.ush');
const directory = path.join(__dirname, 'build/virtual-shadow-sync-probe');
fs.mkdirSync(directory, {recursive:true});
const report = {date:new Date().toISOString(),pass:false,sources:[__filename,input,helper,flagsFile].map(audit)};
(async () => {
  let browser;
  try {
    // Use the engine's flag definitions without pulling its unrelated shader dependencies into the fixture.
    const names = ['VSM_FLAG_ALLOCATED','VSM_FLAG_DYNAMIC_UNCACHED','VSM_FLAG_STATIC_UNCACHED',
      'VSM_FLAG_ANY_UNCACHED','VSM_EXTENDED_FLAG_UNREFERENCED','VSM_EXTENDED_FLAG_FORCE_CACHED'];
    const flags = fs.readFileSync(flagsFile,'utf8');
    const defines = names.map(name => {
      const value = flags.match(new RegExp('^#define\\s+'+name+'\\s+([^\\r\\n]+)','m'))?.[1];
      assert(value,name); return '-D'+name+'='+value.trim();
    });
    const shaders = {};
    for (const [name,toTexture] of [['to-mirror',0],['to-texture',1]]) {
      const spirv=path.join(directory,name+'.spv'),wgsl=path.join(directory,name+'.wgsl');
      for(const [tool,args] of [
        ['.tools/dxc-v1.9.2609/bin/x64/dxc.exe',['-spirv','-T','cs_6_0','-E','MainCS',...defines,
          '-DWEB_SYNC_TO_TEXTURE='+toTexture,input,'-Fo',spirv]],
        ['.tools/dawn-v20261009.190412/bin/tint.exe',[spirv,'--format','wgsl','-o',wgsl]]
      ]) {
        const result=spawnSync(path.join(root,tool),args,{encoding:'utf8',windowsHide:true});
        assert.equal(result.status,0,result.stdout+result.stderr);
      }
      shaders[name]=fs.readFileSync(wgsl,'utf8'); report.sources.push(audit(wgsl));
    }
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage(); await page.goto('http://127.0.0.1:8765');
    report.gpu=await page.evaluate(async shaders => {
      const adapter=await navigator.gpu.requestAdapter();
      const device=await adapter.requestDevice();
      const errors=[],cases=[];
      device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const pipelines={};
      for(const [name,code] of Object.entries(shaders))
        pipelines[name]=await device.createComputePipelineAsync({layout:'auto',
          compute:{module:device.createShaderModule({code}),entryPoint:'MainCS'}});
      const active=f=>(f&1)!==0 && (f&8192)===0 && (f&(6|16384))!==0;
      for(const layers of [1,2,3]) for(const size of [[384,256],[128,128]]) {
        const [width,height]=size,pitch=Math.ceil(width/64)*64,pages=width*height/(128*128);
        const count=64+pitch*height*layers,bytes=count*4;
        const texture=device.createTexture({size:[width,height,layers],format:'r32uint',
          usage:GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST|GPUTextureUsage.STORAGE_BINDING});
        const mirror=device.createBuffer({size:bytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
        const pageFlags=device.createBuffer({size:pages*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        const params=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(params,0,new Uint32Array([width,height,pages,0]));
        const mirrorRead=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const textureRead=device.createBuffer({size:pitch*height*layers*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        const groups={};
        for(const [name,pipeline] of Object.entries(pipelines)) groups[name]=device.createBindGroup({
          layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:texture.createView({dimension:'2d-array'})},
            {binding:1,resource:{buffer:mirror}}, {binding:2,resource:{buffer:pageFlags}}, {binding:3,resource:{buffer:params}}]});
        const expectedMirror=new Uint32Array(count).fill(0xa5a5a5a5);
        const expectedTexture=new Uint32Array(pitch*height*layers);
        device.queue.writeBuffer(mirror,0,expectedMirror);
        let mismatches=0, checkedValues=0;
        for(let round=0;round<3;round++) {
          const types=round===0 ? [0,1,3,5,16385,8199] : round===1 ? [7] : [1,3,8199,5,0,16385];
          const mask=Uint32Array.from({length:pages},(_,i)=>types[i%types.length]);
          device.queue.writeBuffer(pageFlags,0,mask);
          // Page management changes the texture between frames, including cached pages.
          for(let i=0;i<expectedTexture.length;i++) expectedTexture[i]=(i*13+round*97+123)>>>0;
          device.queue.writeTexture({texture},expectedTexture,{bytesPerRow:pitch*4,rowsPerImage:height},[width,height,layers]);
          const dispatch=name=>{
            const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
            pass.setPipeline(pipelines[name]);pass.setBindGroup(0,groups[name]);
            pass.dispatchWorkgroups(pages+2,1,layers);pass.end();return encoder;
          };
          const encoder=dispatch('to-mirror');
          encoder.copyBufferToBuffer(mirror,0,mirrorRead,0,bytes);
          device.queue.submit([encoder.finish()]);await mirrorRead.mapAsync(GPUMapMode.READ);
          const actual=new Uint32Array(mirrorRead.getMappedRange());
          for(let layer=0;layer<layers;layer++)for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            const page=(y>>7)*(width>>7)+(x>>7),i=(layer*height+y)*pitch+x;
            if(active(mask[page]))expectedMirror[64+i]=expectedTexture[i];
          }
          for(let i=0;i<count;i++){checkedValues++;if(actual[i]!==expectedMirror[i])mismatches++;}
          mirrorRead.unmap();
          // Distinct changes on both sides detect overwriting pages outside the selected set.
          for(let i=64;i<count;i++)expectedMirror[i]=(expectedMirror[i]+31)>>>0;
          device.queue.writeBuffer(mirror,0,expectedMirror);
          const out=dispatch('to-texture');
          out.copyTextureToBuffer({texture},{buffer:textureRead,bytesPerRow:pitch*4,rowsPerImage:height},[width,height,layers]);
          out.copyBufferToBuffer(mirror,0,mirrorRead,0,bytes);
          device.queue.submit([out.finish()]);
          await textureRead.mapAsync(GPUMapMode.READ);await mirrorRead.mapAsync(GPUMapMode.READ);
          const texels=new Uint32Array(textureRead.getMappedRange()),mirrorValues=new Uint32Array(mirrorRead.getMappedRange());
          for(let layer=0;layer<layers;layer++)for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
            const page=(y>>7)*(width>>7)+(x>>7),i=(layer*height+y)*pitch+x;
            if(active(mask[page]))expectedTexture[i]=expectedMirror[64+i];
            checkedValues++;if(texels[i]!==expectedTexture[i])mismatches++;
          }
          for(let i=0;i<count;i++){checkedValues++;if(mirrorValues[i]!==expectedMirror[i])mismatches++;}
          textureRead.unmap();mirrorRead.unmap();
        }
        cases.push({width,height,layers,rounds:3,checkedValues,mismatches});
        for(const object of [texture,mirror,pageFlags,params,mirrorRead,textureRead])object.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {cases,errors};
    },shaders);
    assert.deepEqual(report.gpu.errors,[]);assert(report.gpu.cases.every(c=>c.mismatches===0));
    report.pass=true;
  }catch(error){report.error=error.stack;process.exitCode=1;}
  finally{
    await browser?.close();
    fs.writeFileSync(path.join(__dirname,'results/web-virtual-shadow-sync.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({pass:report.pass,gpu:report.gpu,error:report.error},null,2));
  }
})();
