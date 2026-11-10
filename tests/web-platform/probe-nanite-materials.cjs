'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'results/nanite-materials');fs.mkdirSync(output,{recursive:true});
const scalarVisibility=process.argv.includes('--scalar-visibility');
const unmerged=process.argv.includes('--unmerged');
const report={pass:false,scalarVisibility,unmerged,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
function observe(scalarVisibility) {
 const state=globalThis.__webNativeMaterialsGPU={shaders:[],draws:0,errors:[]},modules=new WeakSet(),pipelines=new WeakSet(),bound=new WeakMap();
 const create=GPUDevice.prototype.createShaderModule,asyncPipeline=GPUDevice.prototype.createRenderPipelineAsync,syncPipeline=GPUDevice.prototype.createRenderPipeline;
 GPUDevice.prototype.createShaderModule=function(d){const m=create.call(this,d);if(d.code.includes('WebNaniteMaterial_MemberCount')){modules.add(m);state.shaders.push(d.code);}return m;};
 GPUDevice.prototype.createRenderPipeline=function(d){const p=syncPipeline.call(this,d);if(modules.has(d.fragment?.module))pipelines.add(p);return p;};
 GPUDevice.prototype.createRenderPipelineAsync=async function(d){const p=await asyncPipeline.call(this,d);if(modules.has(d.fragment?.module))pipelines.add(p);return p;};
 const set=GPURenderPassEncoder.prototype.setPipeline,draw=GPURenderPassEncoder.prototype.drawIndirect;
 GPURenderPassEncoder.prototype.setPipeline=function(p){bound.set(this,pipelines.has(p));return set.call(this,p);};
 GPURenderPassEncoder.prototype.drawIndirect=function(...args){if(bound.get(this))++state.draws;return draw.apply(this,args);};
 const request=GPUAdapter.prototype.requestDevice;
 GPUAdapter.prototype.requestDevice=async function(d){
  if(scalarVisibility)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
  const device=await request.call(this,d);state.features=[...device.features];
  device.addEventListener('uncapturederror',e=>state.errors.push(e.error.message));return device;
 };
}
const bits=new DataView(new ArrayBuffer(4)),float=b=>{bits.setUint32(0,b,true);return bits.getFloat32(0,true);};
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
function verify(t) {
 assert(t.complete,'all registered material shaders must be available');assert.equal(t.rejected,0);
 // Steps 3..7 share the same live MID across components 0 and 1. The
 // normal-mapped material and different material instances remain separate.
 assert.equal(t.bins,unmerged?(t.step===5||t.step===7?2:3):(t.step>=3&&t.step<=7?2:3));assert.equal(t.pixels.length,t.width*t.height*28);
 const counts={},maxError={baseColorCode:0,emissive:0,normalAngleCosine:0};
 for(let i=0;i<t.width*t.height;i++) {
  const o=i*28,id=t.pixels[o];if(!id||t.pixels[o+1]!==t.pixels[o+2])continue;
  const slot=(id>>>8)-1,e=t.entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.clusterCount);assert(e&&e.component>=0);
  const c=e.component,unlit=c===0&&(t.step<3||t.step>=8),color=(c===1&&t.step>=2)||(c===0&&t.step>=3&&t.step<=7)?[.7,.1,.25]:[.2,.4,.7];
  counts[c]=(counts[c]||0)+1;
  const model=Math.round(float(t.pixels[o+15])*255)&15;assert.equal(model,unlit?0:1,`component ${c} shading model at ${i}`);
  for(let j=0;j<3;j++) {
   if(unlit) {
    const expected=color[j]*float(t.pixels[o+3]),actual=float(t.pixels[o+4+j]);
    assert(Math.abs(actual-expected)<=Math.max(1e-6,expected*.035),`emissive ${i}/${j}: ${actual} vs ${expected}`);
    maxError.emissive=Math.max(maxError.emissive,Math.abs(actual-expected));
   }else {
    const actual=srgb(float(t.pixels[o+16+j]))*255,expected=Math.round(srgb(color[j])*255),error=Math.abs(actual-expected);
    assert(error<=.5,`base color ${i}/${j}: ${actual} vs ${expected}`);maxError.baseColorCode=Math.max(maxError.baseColorCode,error);
   }
  }
  if(!unlit) {
   const local=[8,9,10].map(j=>float(t.inputs[i*16+j])),m=e.localToWorld;
   const world=[0,1,2].map(j=>local.reduce((sum,v,k)=>sum+v*m[k*4+j],0)),length=Math.hypot(...world);
   const actual=[0,1,2].map(j=>float(t.pixels[o+8+j])*2-1),actualLength=Math.hypot(...actual);
   const cosine=world.reduce((sum,v,j)=>sum+v*actual[j],0)/(length*actualLength),expected=t.step===9&&c===2?Math.sqrt(1-.6**2-(1/255)**2):1;
   const error=Math.abs(cosine-expected);assert(error<.003,`normal angle ${i}: ${cosine} vs ${expected}`);
   maxError.normalAngleCosine=Math.max(maxError.normalAngleCosine,error);
  }
 }
 const expected=[0,1,2].filter(c=>!(t.step===5&&c===1)&&!(t.step===7&&c===0));
 assert.deepEqual(Object.keys(counts).map(Number).sort(),expected);for(const n of Object.values(counts))assert(n>20);
 return {counts,maxError};
}
(async()=>{let browser,page;try {
 browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
 await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+observe.toString()+')('+JSON.stringify(scalarVisibility)+');\n'+await response.text()});});
 page=await browser.newPage();page.on('console',m=>{const text=m.text();report.logs.push(text);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(text))report.errors.push(text);});
 page.on('pageerror',e=>report.errors.push(e.stack));
 await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
 await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
 assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 assert.equal(await page.evaluate(v=>__webEngineRPC('WebNaniteMaterialBinsTest',v),unmerged?0:1),1);
 for(let step=1;step<=10;step++) {
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteMaterialsTest',s),step),1);
  let test;const start=Date.now();
  do {await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialsTest',0)),1);test=await owner.evaluate(()=>globalThis.__webNaniteMaterialsTest||null);}
  while((!test||test.step!==step)&&Date.now()-start<90000);assert(test&&test.step===step);
  report.tests.push(test);test.validation=verify(test);console.log({step,...test.validation});
 }
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialsTest',11)),1);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBinsTest',-1)),1);
 const cleanupFrame=await page.evaluate(()=>globalThis.__webEngineFrames);
 await page.waitForFunction(frame=>globalThis.__webEngineFrames>frame+12,cleanupFrame,{timeout:30000});
 report.gpu=await owner.evaluate(()=>globalThis.__webNativeMaterialsGPU);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
 assert(report.gpu.draws>30);assert(new Set(report.gpu.shaders).size>=3);assert.deepEqual(report.gpu.errors,[]);
 report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.engineFailure=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,`browser${scalarVisibility?'-scalar':''}${unmerged?'-unmerged':''}.json`),JSON.stringify(report,null,2));}})();
