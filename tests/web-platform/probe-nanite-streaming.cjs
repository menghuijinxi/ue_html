'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');
const spline=process.argv.includes('--spline'),splineReference=require('./nanite-spline-reference.cjs');
const wpo=spline||process.argv.includes('--wpo');
const output=path.join(__dirname,spline?'results/nanite-spline-streaming':wpo?'results/nanite-wpo-streaming':'results/nanite-streaming');fs.mkdirSync(output,{recursive:true});
const scalarVisibility=process.argv.includes('--scalar-visibility');
const report={pass:false,scalarVisibility,wpo,spline,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
if(spline)report.geometryReference=audit(require.resolve('./nanite-spline-reference.cjs'));
if(wpo)report.geometryDecoder=audit(path.join(__dirname,'verify-nanite-material-inputs.cjs'));
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((s,x,r)=>s+x*m[r*4+c],0));
function inverse(m){
 const a=Array.from({length:4},(_,r)=>[...m.slice(r*4,r*4+4),...[0,1,2,3].map(c=>r===c?1:0)]);
 for(let c=0;c<4;c++){
  let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[pivot][c]))pivot=r;
  [a[pivot],a[c]]=[a[c],a[pivot]];const d=a[c][c];assert(Math.abs(d)>1e-20);a[c]=a[c].map(v=>v/d);
  for(let r=0;r<4;r++)if(r!==c){const k=a[r][c];a[r]=a[r].map((v,j)=>v-k*a[c][j]);}
 }
 return a.flatMap(r=>r.slice(4));
}
function verifyVelocity(t){
 assert(t.hasVelocity&&t.evaluateWPO);assert(!t.cameraCut||t.step===1);
 const splineParams=t.spline?splineReference.unpack(t.splineParams):null;
 if(t.cameraCut)return {cameraCut:true};
 const records=Buffer.from(t.visibleRecords,'base64'),stream=Buffer.from(t.streamPages,'base64'),roots=Buffer.from(t.rootPagesData,'base64');
 assert.equal(records.length,t.recordBytes);assert.equal(stream.length,t.streamBytes);assert.equal(roots.length,t.rootBytes);
 const triangles=new Map();let samples=0,maxXY=0,maxXYTolerance=0,maxZ=0;
 for(let i=0;i<t.width*t.height;i++){
  const p=i*12;if(!t.pixels[p])continue;
  const depth=float(t.pixels[p+1]),ndc=[((i%t.width)*8+.5)/t.viewWidth*2-1,
   1-(Math.floor(i/t.width)*8+.5)/t.viewHeight*2,depth,1];
  const id=t.pixels[p];
  if(!triangles.has(id)){
   const raw=records.readBigUInt64LE(((id>>>8)-1)*8),pool=Number(raw>>41n),limit=t.poolPages*256;
   assert.equal(Number((raw>>17n)&0xffffffn),t.pixels[p+8],'visibility instance');
   const page=pool<limit?pool>>>8:t.poolPages+((pool-limit)>>>6);
   const cluster=pool<limit?pool&255:(pool-limit)&63;
   const data=page<t.poolPages?stream.subarray(page*131072,(page+1)*131072):
    roots.subarray((page-t.firstRoot)*32768,(page-t.firstRoot+1)*32768);
   assert(page<t.poolPages?t.owners[page]===t.firstRoot:page>=t.firstRoot&&page<t.firstRoot+t.rootPages,'sample page ownership');
   const decoded=decodeTriangle(data,cluster,id&255);
   const vertices=decoded.vertices.map(v=>{
    assert(v.color.length===4&&v.color.every(v=>v===1),'authored streaming fixture color');
    const position=splineParams?splineReference.deform(splineParams,v.position).position:v.position;
    const world=mul([...position,1],t.localToWorld);
    return {clip:mul(world.map((v,j)=>v+([40,25,15,0][j])),t.worldToClip),
     old:mul(world.map((v,j)=>v+([15,-10,-20,0][j])),t.previousWorldToClip)};
   });
   for(const v of vertices){v.clip=v.clip.map(Math.fround);v.old=v.old.map(Math.fround);}
   triangles.set(id,vertices);
  }
  // Solve homogeneous triangle coordinates from independently decoded page
  // bytes. Native material attributes use these analytic weights, while the
  // current depth comes from the hardware's snapped coverage/depth plane.
  // Match the float32 viewport conversion before solving in double precision.
  // A sub-ULP pixel shift becomes a measurable depth change on silhouette slivers.
  const pixelClip=[Math.fround(Math.fround(Math.fround(((i%t.width)*8+.5)*Math.fround(1/t.viewWidth))*2)-1),
   Math.fround(1-Math.fround(Math.fround((Math.floor(i/t.width)*8+.5)*Math.fround(1/t.viewHeight))*2))];
  const vertices=triangles.get(id),a=vertices.map(v=>v.clip[0]-pixelClip[0]*v.clip[3]),b=vertices.map(v=>v.clip[1]-pixelClip[1]*v.clip[3]);
  const weights=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],sum=weights.reduce((a,b)=>a+b,0);
  assert(Math.abs(sum)>1e-15);
  const old=[0,1,2,3].map(j=>vertices.reduce((s,v,k)=>s+v.old[j]*weights[k]/sum,0));
  const actual=[float(t.pixels[p+4]),float(t.pixels[p+5])];assert(actual.some(v=>v!==0),'streamed WPO velocity must be written');
  for(let j=0;j<2;j++){
   const expected=ndc[j]-old[j]/old[3],linear=(actual[j]-32767/65535)/.2495;
   const error=Math.abs(Math.sign(linear)*linear*linear*.5-expected);maxXY=Math.max(maxXY,error);
   // FLOAT -> UNORM permits 0.6 ULP on the integer side, as also tested by
   // Dawn TextureFormatsTier1Tests. Preserve the independent arithmetic bound;
   // propagate the format conversion through the quadratic gamma decoder.
   // https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm#3.2.3.6%20FLOAT%20-%3E%20UNORM
   const q=.6/(.2495*65535),tolerance=2e-6+Math.sqrt(2*Math.abs(expected))*q+q*q*.5;
   maxXYTolerance=Math.max(maxXYTolerance,tolerance);assert(error<tolerance,'streamed WPO XY velocity');
  }
  const words=[float(t.pixels[p+6]),float(t.pixels[p+7])].map(v=>Math.round(v*65535));
  const dz=float(((words[0]<<16)|(words[1]&65532))>>>0),error=Math.abs(dz-(depth-old[2]/old[3]));
  maxZ=Math.max(maxZ,error);assert(error<1e-7,'streamed WPO depth velocity');samples++;
 }
 assert(samples>30);return {samples,triangles:triangles.size,maxXY,maxXYTolerance,maxZ};
}
function observe(scalarVisibility){
 const s=globalThis.__webStreamingGPU={errors:[],shaders:[],dispatches:{}};
 const request=GPUAdapter.prototype.requestDevice,create=GPUDevice.prototype.createShaderModule;
 const modules=new WeakMap(),pipelines=new WeakMap(),bound=new WeakMap();
 GPUDevice.prototype.createShaderModule=function(d){const m=create.call(this,d);const kind=d.code.includes('OutStreamingRequests')?'clear':d.code.includes('PackedUpdates')?'fixup':d.code.includes('WebStreamingRequests')?'requests':null;if(kind){modules.set(m,kind);s.shaders.push({kind,code:d.code});}return m;};
 for(const name of ['createComputePipeline','createComputePipelineAsync']){const orig=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(d){const p=orig.call(this,d),kind=modules.get(d.compute.module);if(p?.then)return p.then(v=>{if(kind)pipelines.set(v,kind);return v;});if(kind)pipelines.set(p,kind);return p;};}
 const set=GPUComputePassEncoder.prototype.setPipeline,dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
 GPUComputePassEncoder.prototype.setPipeline=function(p){bound.set(this,pipelines.get(p));return set.call(this,p);};
 GPUComputePassEncoder.prototype.dispatchWorkgroups=function(...a){const k=bound.get(this);if(k)s.dispatches[k]=(s.dispatches[k]||0)+1;return dispatch.apply(this,a);};
 GPUAdapter.prototype.requestDevice=async function(d){if(scalarVisibility)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};const device=await request.call(this,d);s.features=[...device.features];device.addEventListener('uncapturederror',e=>s.errors.push(e.error.message));device.lost.then(v=>s.errors.push('lost: '+v.message));return device;};
}
function verify(t){
 assert.equal(t.wpo,wpo);
 assert.equal(t.spline,spline);
 assert.equal(t.rejected,0);assert.equal(t.poolPages,12);assert.equal(t.cullState[1],0);assert(t.cullState[0]>0);
 assert(t.firstRoot>=t.poolPages);assert(t.history.length>=1);assert(t.history.every((v,i,a)=>!i||v.requestVersion>=a[i-1].requestVersion));
 const covered=[];for(let i=0;i<t.pixels.length;i+=12)if(t.pixels[i]){assert(t.pixels[i+2]);assert.equal(t.pixels[i+1],t.pixels[i+10]);covered.push(i/12);}
 assert(covered.length>30,'Nanite must render without any fallback triangles');
 if(t.asset!==1){assert(t.bulkBytes>0,'real cooked streamable bulk data');assert.equal(t.rootPages,1);assert.equal(t.totalPages,12);}
 if(t.step>=3&&t.step<=6){assert(t.owners.filter(o=>o===t.firstRoot).length>=10,'fine pages must be installed');assert.equal(t.residentClusters,t.totalClusters);}
 if(t.owners.includes(t.firstRoot)&&t.asset!==1)assert(t.foreignPageState[1]&2,'foreign/stale streaming pages must be rejected');
 for(let i=3;i<t.requests.length;i+=3){assert.equal(t.requests[i],t.runtimeID);assert(t.requests[i+1]&0x40000000);assert(t.requests[i+2]>0);}
 return {covered:covered.length,triangles:t.cullState[3],clusters:t.cullState[0],residentClusters:t.residentClusters,requests:t.requestCount,ownedPages:t.owners.filter(o=>o===t.firstRoot).length,...(wpo?{velocity:verifyVelocity(t)}:{})};
}
function compare(a,b){
 assert.equal(a.width,b.width);assert.equal(a.height,b.height);let common=0,differentCoverage=0,maxDepthError=0;
 const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
 for(let i=0;i<a.pixels.length;i+=12){const x=!!a.pixels[i],y=!!b.pixels[i];if(x!==y)differentCoverage++;if(x&&y){common++;maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(a.pixels[i+1])-asFloat(b.pixels[i+1])));assert.equal(a.pixels[i+3],b.pixels[i+3]);assert.equal(a.pixels[i+11],b.pixels[i+11]);}}
 assert(common>30);assert(differentCoverage<=3,`coverage mismatch ${differentCoverage}`);assert(maxDepthError<2e-6,`depth mismatch ${maxDepthError}`);return {common,differentCoverage,maxDepthError};
}
(async()=>{let browser,page;try{
 browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
 await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+observe.toString()+')('+JSON.stringify(scalarVisibility)+');\n'+await response.text()});});
 await browser.route('**/nanite-browser/index.html',async route=>{const response=await route.fetch();let text=await response.text();assert(text.includes('"-WebNaniteRootPages=2"'));text=text.replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12"'+(wpo?',"-WebNaniteScene"':''));await route.fulfill({response,body:text});});
 page=await browser.newPage();page.on('console',m=>{const text=m.text();report.logs.push(text);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(text)){report.errors.push(text);console.error(text);}});page.on('pageerror',e=>report.errors.push(e.stack));
 await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
 assert(report.logs.some(s=>s.includes('Command Line:')&&s.includes('-WebNaniteStreamingPages=12')));
 const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
 report.initialIO=await owner.evaluate(()=>globalThis.__webContentIO?.stats);
 if(wpo)assert.equal(await page.evaluate(mode=>__webEngineRPC('WebNaniteStreamingTest',mode),spline?-2:-1),1);
 for(let step=1;step<=9;step++){
  if(step===4)await owner.evaluate(()=>{
   const io=globalThis.__webContentIO,read=io.readRequest;
   globalThis.__webStreamingIOFailure={failures:0,retries:0};
   io.readRequest=function(id,path,offset,size,destination){
    const s=globalThis.__webStreamingIOFailure;
    if(path.includes('/WebNaniteStreaming/NaniteStreamingSphereB.ubulk')&&size>4096){
     if(!s.failures){s.failures=1;s.offset=offset;s.size=size;queueMicrotask(()=>this.complete(id,false));return;}
     if(offset===s.offset&&size===s.size)++s.retries;
    }
    return read.call(this,id,path,offset,size,destination);
   };
  });
  assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteStreamingTest',s),step),1);
  let test;const start=Date.now();do{await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteStreamingTest',0)),1);test=await owner.evaluate(()=>globalThis.__webNaniteStreamingTest||null);}while((!test||test.step!==step)&&Date.now()-start<120000);
  assert(test&&test.step===step);test.io=await owner.evaluate(()=>globalThis.__webContentIO?.stats);report.tests.push(test);
  test.validation=verify(test);console.log({step,...test.validation});
 }
 report.comparisons=report.tests.filter(t=>[3,4,5,6,8,9].includes(t.step)).map(t=>({step:t.step,...compare(report.tests[1],t)}));
 assert.notEqual(report.tests[4].runtimeID,report.tests[5].runtimeID,'resource reinitialization must advance version');
 assert(report.tests[0].residentClusters<report.tests[2].residentClusters,'cold start must refine');
 for(const t of report.tests.filter(t=>[4,5,6,9].includes(t.step)))assert(Math.min(...t.history.map(h=>h.residentClusters))<t.totalClusters,'evicted/reset resource must refill');
 report.ioFailure=await owner.evaluate(()=>globalThis.__webStreamingIOFailure);
 assert.equal(report.ioFailure.failures,1);assert(report.ioFailure.retries>=1);
 assert(report.logs.some(s=>s.includes('Retrying IO request RuntimeResourceID:')),'native retry path must run');
 assert(report.tests[3].io.diskReadBytes>report.tests[2].io.diskReadBytes,'cold resource reads persistent bulk data');
 assert.equal(report.tests[4].io.diskReadBytes,report.tests[3].io.diskReadBytes,'evicted GPU pages reload from hot CPU cache');
 assert(report.tests[4].io.memoryHits>report.tests[3].io.memoryHits);
 assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteStreamingTest',10)),1);
 const frame=await page.evaluate(()=>globalThis.__webEngineFrames);await page.waitForFunction(f=>globalThis.__webEngineFrames>f+12,frame,{timeout:30000});
 report.gpu=await owner.evaluate(()=>globalThis.__webStreamingGPU);assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalarVisibility);assert.deepEqual(report.gpu.errors,[]);
 for(const k of ['clear','fixup','requests'])assert(report.gpu.dispatches[k]>0,`actual ${k} dispatches`);
 report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.engineFailure=page?await page.evaluate(()=>({failure:globalThis.__webEngineFailure,frames:globalThis.__webEngineFrames})).catch(()=>null):null;report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(browser)await browser.close();fs.writeFileSync(path.join(output,scalarVisibility?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
