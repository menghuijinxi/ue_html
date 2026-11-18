'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalarVisibility=process.argv.includes('--scalar-visibility');
const output=path.join(__dirname,'results/nanite-sidedness');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalarVisibility,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__sidednessGPU={errors:[],microDispatches:0};
  const modules=new WeakSet(),pipelines=new WeakSet(),bound=new WeakMap();
  const shader=GPUDevice.prototype.createShaderModule,compute=GPUDevice.prototype.createComputePipeline,asyncCompute=GPUDevice.prototype.createComputePipelineAsync;
  GPUDevice.prototype.createShaderModule=function(d){const m=shader.call(this,d);if(d.code.includes('WebRasterMaterialMasks')&&d.code.includes('@compute'))modules.add(m);return m;};
  GPUDevice.prototype.createComputePipeline=function(d){const p=compute.call(this,d);if(modules.has(d.compute.module))pipelines.add(p);return p;};
  GPUDevice.prototype.createComputePipelineAsync=async function(d){const p=await asyncCompute.call(this,d);if(modules.has(d.compute.module))pipelines.add(p);return p;};
  const set=GPUComputePassEncoder.prototype.setPipeline,dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.setPipeline=function(p){bound.set(this,pipelines.has(p));return set.call(this,p);};
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...args){if(bound.get(this))++__sidednessGPU.microDispatches;return dispatch.apply(this,args);};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__sidednessGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__sidednessGPU.errors.push(e.error.message));return device;
  };
}
function verify(t){
  assert.equal(t.rejected,0);assert.equal(t.cullState[1],0);assert(t.cullState[0]>0);
  assert.equal(t.microSpan,t.step%2?0:8);
  assert.equal(t.pixels.length,t.width*t.height*28);assert.equal(t.inputs.length,t.width*t.height*16);
  const scenario=Math.floor((t.step-1)/2),expected=[[0,1],[1],[0,1],[1],[0,1],[1],[0,1],[0,1],[1],[],[0,1]][scenario];
  const counts={};let covered=0,maxColorError=0;
  for(let i=0;i<t.width*t.height;i++){
    const p=i*28,m=i*16,id=t.pixels[p];
    if(!id){assert.equal(t.inputs[m],0);continue;}
    assert.equal(t.pixels[p+1],t.pixels[p+2],'visible Nanite depth must reach the scene');
    assert.equal(t.inputs[m],id);assert.equal(t.inputs[m+1],t.instance);
    const slot=t.inputs[m+2];assert(slot===0||slot===1);
    counts[slot]=(counts[slot]||0)+1;covered++;
    const material=scenario===9?0:scenario===10?1:slot;
    const color=material?[.1,.7,.2]:[.7,.1,.2];
    assert.equal(Math.round(asFloat(t.pixels[p+15])*255)&15,1,'actual DefaultLit shader must execute');
    for(let j=0;j<3;j++){
      const error=Math.abs(srgb(asFloat(t.pixels[p+16+j]))*255-Math.round(srgb(color[j])*255));
      assert(error<=.5,`material ${material} color at ${i}/${j}`);maxColorError=Math.max(maxColorError,error);
    }
  }
  assert.deepEqual(Object.keys(counts).map(Number).sort(),expected,`sidedness case ${scenario}: visible material slots`);
  for(const n of Object.values(counts))assert(n>100,'each expected surface needs substantial coverage');
  return {scenario,counts,covered,maxColorError};
}
function compare(hardware,mixed){
  assert.equal(hardware.width,mixed.width);assert.equal(hardware.height,mixed.height);
  let maxDepthError=0,maxNormalError=0,covered=0;
  for(let i=0;i<hardware.width*hardware.height;i++){
    const p=i*28;assert.equal(!!hardware.pixels[p],!!mixed.pixels[p],`HW/compute coverage at ${i}`);
    if(!hardware.pixels[p])continue;covered++;
    assert.equal(hardware.inputs[i*16+2],mixed.inputs[i*16+2]);
    maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(hardware.pixels[p+1])-asFloat(mixed.pixels[p+1])));
    for(let j=0;j<3;j++)maxNormalError=Math.max(maxNormalError,Math.abs(asFloat(hardware.pixels[p+8+j])-asFloat(mixed.pixels[p+8+j])));
  }
  assert(maxDepthError<3e-5);assert(maxNormalError<.003);
  return {covered,maxDepthError,maxNormalError};
}
(async()=>{let context,page;try{
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:`(${observe.toString()})(${scalarVisibility});\n`+await r.text()});});
  await context.route('**/nanite-browser/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,body:(await r.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12"')});});
  page=await context.newPage();page.on('pageerror',e=>report.errors.push({name:e.name,message:e.message}));
  page.on('console',m=>{const t=m.text();report.logs.push(t);if(report.logs.length>400)report.logs.shift();});
  await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  for(let step=1;step<=22;step++){
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteSidednessTest',s),step),1);
    const start=Date.now();let t;
    do{await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
      await page.evaluate(()=>__webEngineRPC('WebNaniteSidednessTest',0));
      t=await owner.evaluate(()=>globalThis.__webNaniteSidednessTest||null);
    }while((!t||t.step!==step)&&Date.now()-start<90000);
    assert(t&&t.step===step);report.tests.push(t);t.validation=verify(t);
    if(step%2===0)t.hardwareComparison=compare(report.tests.at(-2),t);
    console.log({step,...t.validation,hardwareComparison:t.hardwareComparison});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteSidednessTest',23)),1);
  const before=await page.evaluate(()=>__webEngineFrames);
  await page.waitForFunction(f=>globalThis.__webEngineFrames>f+15,before,{timeout:30000});
  report.gpu=await owner.evaluate(()=>__sidednessGPU);assert.deepEqual(report.gpu.errors,[]);
  assert(report.gpu.microDispatches>20,'real scene must execute the material-aware compute raster');
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
  report.frames=await page.evaluate(()=>__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;
  report.final=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames,
    recovery:globalThis.__webEngineRecovery,stages:globalThis.__webThreadStages,pso:globalThis.__webOptimizationRHI})).catch(()=>null):null;
}finally{await context?.close();fs.writeFileSync(path.join(output,scalarVisibility?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
