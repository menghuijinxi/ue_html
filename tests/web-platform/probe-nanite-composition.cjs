'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'results/nanite-composition');fs.mkdirSync(output,{recursive:true});
const scalarVisibility=process.argv.includes('--scalar-visibility');
const report={pass:false,scalarVisibility,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
function observe(scalarVisibility) {
 const state=globalThis.__webCompositionGPU={shaders:[],draws:0,errors:[]},modules=new WeakSet(),pipelines=new WeakSet(),bound=new WeakMap();
 const create=GPUDevice.prototype.createShaderModule,asyncPipeline=GPUDevice.prototype.createRenderPipelineAsync,syncPipeline=GPUDevice.prototype.createRenderPipeline;
 GPUDevice.prototype.createShaderModule=function(d){const m=create.call(this,d);if(d.code.includes('WebCompositionRect')){modules.add(m);state.shaders.push(d.code);}return m;};
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

const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((sum,x,r)=>sum+x*m[r*4+c],0));
function inv(m){
 const a=Array.from({length:4},(_,r)=>[...m.slice(r*4,r*4+4),...[0,1,2,3].map(c=>+(r===c))]);
 for(let c=0;c<4;c++){
  let p=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[p][c]))p=r;
  assert(Math.abs(a[p][c])>1e-12);[a[p],a[c]]=[a[c],a[p]];
  const n=a[c][c];a[c]=a[c].map(v=>v/n);
  for(let r=0;r<4;r++)if(r!==c){const f=a[r][c];a[r]=a[r].map((v,k)=>v-f*a[c][k]);}
 }return a.flatMap(r=>r.slice(4));
}
function verify(t){
 assert(t.hasVelocity,'the real scene velocity target must be active');assert.equal(t.rejected,0);
 assert.equal(t.pixels.length,t.width*t.height*12);assert.equal(t.entries.length,3);if(t.step>=6)assert(t.hasLightingChannels);if(t.step===9)assert(t.cameraCut);
 const clipToWorld=inv(t.worldToClip),entries=new Map(t.entries.map(e=>[e.instance,{...e,worldToLocal:inv(e.localToWorld)}]));
 const counts={},moving={},cameraReconstructed={},bins=new Map();let maxVelocityError=0,maxVelocityDepthError=0,occluded=0,zeroVelocity=0;
 for(let i=0;i<t.width*t.height;i++){
  const o=i*12,p=t.pixels,id=p[o],depth=float(p[o+1]),mask=p[o+2],stencil=p[o+3];
  if(!id){assert.equal(mask,0);continue;}
  if(p[o+1]!==p[o+10]){assert.equal(mask,0,'ordinary occluders must not acquire the Nanite mask');occluded++;continue;}
  const e=entries.get(p[o+8]);assert(e&&e.component>=0);const c=e.component,flags=p[o+9],channels=(flags>>>11)&7;
  counts[c]=(counts[c]||0)+1;
  assert.equal(mask&1,1);assert.equal((mask>>>1)&7,channels);
  assert.equal((mask>>>18)&1,+!!(flags&8));assert.equal((mask>>>19)&1,+!!(flags&128));assert.equal((mask>>>20)&1,+!!(flags&1));
  const bin=(mask>>>4)&16383;if(bins.has(c))assert.equal(bin,bins.get(c));else bins.set(c,bin);
  const expectedStencil=(flags&1?2:0)|(flags&128?4:0)|((channels^1)<<4)|(flags&8?128:0);
  assert.equal(stencil&246,expectedStencil,'native stencil flags');
  if(t.hasLightingChannels)assert.equal(p[o+11],channels|(flags&128?8:0)|(flags&1?16:0),'native lighting channel/shadow consumer');
  if(t.step>=6){assert.equal(channels,1<<c);assert.equal(!!(flags&8),c!==1);assert.equal(!!(flags&1),c!==2);}
  const actual=[float(p[o+4]),float(p[o+5])];
  const x=(i%t.width)*8+.5,y=Math.floor(i/t.width)*8+.5;
  const ndc=[x/t.viewWidth*2-1,1-y/t.viewHeight*2,depth,1];
  let world=mul(ndc,clipToWorld);world=world.map(v=>v/world[3]);
  const local=mul(world,e.worldToLocal),previousWorld=mul(local,e.previousLocalToWorld),previousClip=mul(previousWorld,t.previousWorldToClip);
  const velocity=[0,1].map(j=>ndc[j]-t.jitter[j]-(previousClip[j]/previousClip[3]-t.jitter[j+2]));
  if(!(flags&32)){
   assert.deepEqual(actual,[0,0]);zeroVelocity++;
   if(Math.hypot(...velocity)>1e-5)cameraReconstructed[c]=(cameraReconstructed[c]||0)+1;
   continue;
  }
  // UE desktop velocity enables gamma encoding for RG16 UNORM precision.
  const depthWords=[float(p[o+6]),float(p[o+7])].map(v=>Math.round(v*65535));
  const decodedDepth=float(((depthWords[0]<<16)|(depthWords[1]&65532))>>>0);
  const depthError=Math.abs(decodedDepth-(depth-previousClip[2]/previousClip[3]));
  assert(depthError<1e-7,'depth velocity must match independent reprojection');
  maxVelocityDepthError=Math.max(maxVelocityDepthError,depthError);
  const expected=velocity;
  const decoded=actual.map(v=>{const linear=(v-32767/65535)/.2495;return Math.sign(linear)*linear*linear*.5;});
  for(let j=0;j<2;j++){const err=Math.abs(decoded[j]-expected[j]);maxVelocityError=Math.max(maxVelocityError,err);const tolerance=2e-6+Math.sqrt(2*Math.abs(expected[j]))/(.2495*65535)*.51;assert(err<tolerance,`velocity step ${t.step} component ${c} pixel ${i}/${j}: ${decoded[j]} vs ${expected[j]}`);}
  if(Math.hypot(...velocity)>1e-5)moving[c]=(moving[c]||0)+1;
 }
 assert.deepEqual(Object.keys(counts).map(Number).sort(),t.step===7?[0,2]:[0,1,2]);
 for(const n of Object.values(counts))assert(n>20);assert.equal(new Set(bins.values()).size,bins.size);
 if([2,4,5,7,8].includes(t.step))assert((moving[0]||0)>10,'object movement must be sampled');
 if([3,5].includes(t.step))assert((moving[1]||cameraReconstructed[1]||0)>10,'camera movement must be sampled');
 if(t.step===7)assert(occluded>20);else assert.equal(occluded,0);
 return {counts,moving,cameraReconstructed,maxVelocityError,maxVelocityDepthError,occluded,zeroVelocity};
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
 for(let step=1;step<=9;step++) {
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteCompositionTest',s),step),1);
  let test;const start=Date.now();
  do {await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteCompositionTest',0)),1);test=await owner.evaluate(()=>globalThis.__webNaniteCompositionTest||null);}
  while((!test||test.step!==step)&&Date.now()-start<90000);assert(test&&test.step===step);
  report.tests.push(test);test.validation=verify(test);console.log({step,...test.validation});
 }
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteCompositionTest',10)),1);
 const cleanupFrame=await page.evaluate(()=>globalThis.__webEngineFrames);
 await page.waitForFunction(frame=>globalThis.__webEngineFrames>frame+12,cleanupFrame,{timeout:30000});
 report.gpu=await owner.evaluate(()=>globalThis.__webCompositionGPU);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
 assert(new Set(report.gpu.shaders).size>=3);assert.deepEqual(report.gpu.errors,[]);
 report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);
 assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.engineFailure=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,scalarVisibility?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
