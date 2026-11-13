'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const folder=option('folder')||'nanite-browser',tag=option('tag')||'nanite-wpo';assert([folder,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
const output=path.join(__dirname,'results',tag);fs.mkdirSync(output,{recursive:true});
assert(!fs.existsSync(path.join(output,scalar?'browser-scalar.json':'browser.json')),'Use a new result tag');
fs.copyFileSync(__filename,path.join(output,scalar?'scalar-source.cjs':'packed-source.cjs'));
const source=path.join(__dirname,'results/nanite-programmable/wpo-source-triangles.bin');
const bytes=fs.readFileSync(source),vertices=new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
assert.equal(vertices.length,2048*3*8);
const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
for(let i=0;i<vertices.length;i+=8)for(let j=0;j<3;j++){
  bounds.min[j]=Math.min(bounds.min[j],vertices[i+j]);bounds.max[j]=Math.max(bounds.max[j],vertices[i+j]);
}
const sourceCenter=bounds.min.map((v,j)=>(v+bounds.max[j])/2);
const report={pass:false,scalar,source:audit(__filename),geometry:audit(source),package:audit(path.join(__dirname,'build',folder,'package.json')),tests:[],errors:[],validationFailures:[],logs:[]};
const save=()=>fs.writeFileSync(path.join(output,scalar?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((n,x,r)=>n+x*m[r*4+c],0));
function inverse(m){
  const a=Array.from({length:4},(_,r)=>[...m.slice(r*4,r*4+4),...[0,1,2,3].map(c=>r===c?1:0)]);
  for(let c=0;c<4;c++){
    let pivot=c;for(let r=c+1;r<4;r++)if(Math.abs(a[r][c])>Math.abs(a[pivot][c]))pivot=r;
    [a[pivot],a[c]]=[a[c],a[pivot]];const d=a[c][c];assert(Math.abs(d)>1e-20);a[c]=a[c].map(v=>v/d);
    for(let r=0;r<4;r++)if(r!==c){const k=a[r][c];a[r]=a[r].map((v,j)=>v-k*a[c][j]);}
  }
  return a.flatMap(r=>r.slice(4));
}
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
const floatULP=v=>2**(Math.floor(Math.log2(Math.max(Math.abs(v),2**-126)))-23);
function depthInterval(vertices,px,py){
  let min=Infinity,max=-Infinity;
  const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
  for(const a of vertices[0].rasterChoices)for(const b of vertices[1].rasterChoices)for(const c of vertices[2].rasterChoices){
    const area=cross(a,b,c.x,c.y);if(Math.abs(area)<1e-9)continue;
    const w=[cross(b,c,px,py),cross(c,a,px,py),cross(a,b,px,py)].map(v=>v/area);
    if(w.some(v=>v<0))continue;
    const z=w.reduce((s,v,j)=>s+v*vertices[j].z,0);min=Math.min(min,z);max=Math.max(max,z);
  }
  assert(Number.isFinite(min)&&Number.isFinite(max));return {min,max};
}
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__wpoGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__wpoGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__wpoGPU.errors.push(e.error.message));return device;
  };
}
function evaluateWPO(t,e){
  if(e.component===1||[8,14,26,29].includes(t.step))return false;
  const distance=({10:399,11:400,12:401,13:250,27:399,28:401})[t.step];
  if(!distance)return true;
  // Use the authored source bounds, not the component pivot or renderer flag.
  const center=mul([...sourceCenter,1],e.localToWorld).slice(0,3)
    .map((v,j)=>Math.fround(v-[100000,0,100000][j]));
  const length=Math.fround(center.reduce((s,v)=>Math.fround(s+Math.fround(v*v)),0));
  return length<(distance*(t.step===13?2:1))**2;
}
function settings(t,e,slot){
  const s=t.step;
  if(e.component===1)return {current:[0,0,0],previous:[0,0,0],maximum:0};
  let current=[40,25,15],previous=current;
  if(s===1||(!evaluateWPO(t,e)&&s!==14))current=previous=[0,0,0];
  if(s===3)previous=[15,-10,-20];
  if(s===7)current=previous=[240,-180,300];
  if(s===15)current=previous=[-50,-300,0];
  if(s===16||s===17)current=previous=[0,-120,0];
  if(s>=26&&s<=29&&((slot===1)!==(s===29)))current=previous=[20,-30,35];
  if(s>=30)previous=[15,-10,-20];
  return {current,previous,maximum:s===14||s===15?0:120,masked:s===6,pdo:s===6?80:0,oneSided:s>=18&&s<=20,reverse:s===20};
}
// Project authored source triangles independently of the Nanite visibility,
// decoded barycentrics and material-input snapshots being tested.
function reference(t){
  const result=Array(t.width*t.height).fill(null),edge=new Uint8Array(result.length);
  for(const e of t.entries){
    const translated=e.localToWorld.map(Math.fround);
    for(let j=0;j<3;j++)translated[12+j]=Math.fround(e.localToWorld[12+j]+t.preViewTranslation[j]);
    const projection=t.translatedWorldToClip.map(Math.fround);
    for(let base=0;base<vertices.length;base+=24){
      const slot=Math.floor(base/48)%32<16?0:1,config=settings(t,e,slot);
      const offset=(v,current)=>v.map((x,j)=>{
        const d=x*current[j];return config.maximum>0?Math.min(config.maximum,Math.max(-config.maximum,d)):d;
      });
      const v=[];
      for(let k=0;k<3;k++){
        const a=Array.from(vertices.slice(base+k*8,base+k*8+8));
        const p=mul([...a.slice(0,3).map(x=>Math.round(x*1024)/1024),1],e.localToWorld);
        const delta=offset(a.slice(5,8),config.current),prevDelta=offset(a.slice(5,8),config.previous);
        const oldP=mul([...a.slice(0,3).map(x=>Math.round(x*1024)/1024),1],e.previousLocalToWorld);
        const world=p.map((x,j)=>x+(delta[j]||0)),previous=oldP.map((x,j)=>x+(prevDelta[j]||0));
        // Independent source geometry projected at the GPU's float precision.
        // Raster setup snaps screen coordinates to the 8-bit subpixel grid.
        const relative=mul([...a.slice(0,3).map(x=>Math.round(x*1024)/1024),1],translated).map(Math.fround)
          .map((x,j)=>Math.fround(x+Math.fround(delta[j]||0)));
        const clip=mul(relative,projection).map(Math.fround),old=mul(previous,t.previousWorldToClip);
        const materialClip=mul(world,t.worldToClip);
        assert(clip[3]>0,'fixture must remain in front of the near plane');
        // Float dot products and perspective division can straddle a hardware
        // subpixel rounding boundary. Bound the arithmetic error from the source
        // operands, then retain every possible adjacent snapped vertex position.
        const unit=2**-24,gamma=8*unit/(1-8*unit),local=[...a.slice(0,3).map(x=>Math.round(x*1024)/1024),1];
        const relativeError=[0,1,2].map(c=>gamma*(local.reduce((s,x,r)=>s+Math.abs(x*translated[r*4+c]),0)+Math.abs(delta[c])));
        const clipError=[0,1,2,3].map(c=>gamma*relative.reduce((s,x,r)=>s+Math.abs(x*projection[r*4+c]),0)+
          relativeError.reduce((s,x,r)=>s+x*Math.abs(projection[r*4+c]),0));
        const screen=[(clip[0]/clip[3]+1)*t.viewWidth/2,(1-clip[1]/clip[3])*t.viewHeight/2];
        const choices=screen.map((value,c)=>{
          const half=(c?t.viewHeight:t.viewWidth)/2,w=clip[3],ew=clipError[3];
          const error=half*(clipError[c]*w+Math.abs(clip[c])*ew)/(w*(w-ew))+unit*(Math.abs(value)+half);
          const lo=Math.round((value-error)*256),hi=Math.round((value+error)*256);
          assert(hi-lo<=1,'fixture projection uncertainty must stay within adjacent subpixel positions');
          return lo===hi?[lo/256]:[lo/256,hi/256];
        });
        const rasterChoices=choices[0].flatMap(x=>choices[1].map(y=>({x,y})));
        v.push({x:Math.round((clip[0]/clip[3]+1)*t.viewWidth/2*256)/256,
          y:Math.round((1-clip[1]/clip[3])*t.viewHeight/2*256)/256,
          z:clip[2]/clip[3],w:clip[3],uv:a.slice(3,5),world,old,rasterChoices,
          material:{x:(materialClip[0]/materialClip[3]+1)*t.viewWidth/2,
            y:(1-materialClip[1]/materialClip[3])*t.viewHeight/2,w:materialClip[3]}});
      }
      const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
      const area=cross(v[0],v[1],v[2].x,v[2].y);if(Math.abs(area)<1e-9)continue;
      if(config.oneSided&&((area<0)===!!config.reverse))continue;
      const xmin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.x))-.51)/8));
      const xmax=Math.min(t.width-1,Math.floor((Math.max(...v.map(a=>a.x))-.49)/8));
      const ymin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.y))-.51)/8));
      const ymax=Math.min(t.height-1,Math.floor((Math.max(...v.map(a=>a.y))-.49)/8));
      for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
        const px=x*8+.5,py=y*8+.5,i=y*t.width+x;
        const c=[cross(v[1],v[2],px,py),cross(v[2],v[0],px,py),cross(v[0],v[1],px,py)];
        const b=c.map(a=>a/area);
        const distances=c.map((a,j)=>Math.abs(a)/Math.hypot(v[(j+2)%3].x-v[(j+1)%3].x,v[(j+2)%3].y-v[(j+1)%3].y));
        if(Math.min(...distances)<.01&&Math.min(...b)>-.005)edge[i]=1;
        if(b.some(a=>a<0))continue;
        // Nanite reconstructs material attributes analytically from the original
        // triangle. Hardware subpixel snapping applies to raster coverage/depth.
        const m=v.map(a=>a.material),ma=cross(m[0],m[1],m[2].x,m[2].y);
        const mb=[cross(m[1],m[2],px,py),cross(m[2],m[0],px,py),cross(m[0],m[1],px,py)].map(a=>a/ma);
        const reciprocal=mb.reduce((n,a,j)=>n+a/m[j].w,0),weights=mb.map((a,j)=>a/m[j].w/reciprocal);
        const interpolate=(key,n)=>Array.from({length:n},(_,j)=>weights.reduce((sum,a,k)=>sum+a*v[k][key][j],0));
        const uv=interpolate('uv',2);
        if(config.masked){const p=uv.map(a=>Math.floor((a-Math.floor(a))*8));if(((p[0]>>1)+(p[1]>>1))%2===0)continue;}
        let depth=b.reduce((n,a,j)=>n+a*v[j].z,0);
        if(config.pdo){
          const world=interpolate('world',4),delta=[world[0]-100000,world[1],world[2]-100000];
          const forward=config.pdo*delta[0]/Math.hypot(...delta);depth/=1+forward*reciprocal;
        }
        if(depth<0||depth>1)continue;
        if(!result[i]||depth>result[i].depth)result[i]={component:e.component,depth,previousClip:interpolate('old',4),uv,vertices:v,pdo:!!config.pdo};
      }
    }
  }
  return {pixels:result,edge};
}
function verify(t){
  assert.equal(t.rejected,0);assert(t.hasVelocity);assert.equal(t.cameraCut,t.step===36);
  assert.equal(t.pixels.length,t.width*t.height*12);assert.equal(t.gbuffer.length,t.width*t.height*28);
  if(t.step<35){assert.equal(t.jitterX,0);assert.equal(t.jitterY,0);}
  else assert(Math.abs(t.jitterX)+Math.abs(t.jitterY)>0,'temporal jitter must be active');
  assert.deepEqual(t.entries.map(e=>e.component).sort(),[22,24].includes(t.step)?[1]:[0,1]);
  for(const e of t.entries)assert.equal(e.evaluateWPO,evaluateWPO(t,e),`step ${t.step} WPO component/distance policy`);
  for(const e of t.entries)if(e.component===0&&!e.unboundedWPO&&(e.evaluateWPO||t.step>=26&&t.step<=29)){
    const back=inverse(e.localToWorld);
    for(let corner=0;corner<8;corner++){
      const local=mul([corner&1?120:-120,corner&2?120:-120,corner&4?120:-120,0],back);
      for(let j=0;j<3;j++)assert(Math.abs(local[j])<=e.localWPOExtent[j]+1e-4,'culling bounds must contain every allowed world displacement');
    }
  }
  const expected=reference(t),byInstance=new Map(t.entries.map(e=>[e.instance,e]));
  const counts={};let compared=0,edgeSamples=0,maxDepthError=0,maxVelocityError=0,maxVelocityDepthError=0,moving=0;
  let maxQuantizedDepthError=0;
  let subpixelChecks=0,maxDepthResidual=0,maxDepthIntervalWidth=0,maxVelocityDepthTolerance=0;
  for(let i=0;i<expected.pixels.length;i++){
    const p=i*12,g=i*28,id=t.pixels[p],owner=id?byInstance.get(t.pixels[p+8])?.component:-1,ref=expected.pixels[i];
    assert(owner===-1||owner===0||owner===1);
    if(id){
      assert.equal(t.pixels[p+1],t.pixels[p+10],'WPO depth must reach the real scene');
      assert.equal(t.gbuffer[g],id);assert.equal(t.gbuffer[g+1],t.pixels[p+1]);assert.equal(t.pixels[p+2]&1,1);
      counts[owner]=(counts[owner]||0)+1;
      const color=owner===0?[.2,.4,.7]:[.1,.7,.2];
      for(let j=0;j<3;j++)assert(Math.abs(srgb(float(t.gbuffer[g+16+j]))*255-Math.round(srgb(color[j])*255))<=.5);
    }
    if(expected.edge[i]){edgeSamples++;continue;}
    assert.equal(owner,ref?.component??-1,`step ${t.step} pixel ${i} independent WPO coverage`);
    if(!ref)continue;
    compared++;const depth=float(t.pixels[p+1]),de=Math.abs(depth-ref.depth);maxDepthError=Math.max(maxDepthError,de);
    const depthTolerance=t.perspective?1e-7:1.2e-7;
    // The scene attachment stores R32F. Compare its representable value to
    // the independent result rounded to that format, while retaining the raw
    // double-precision discrepancy above. In orthographic views the existing
    // two-ULP limit must not accidentally include a third fractional ULP from
    // comparing a float attachment against an unrepresentable real value.
    const quantizedError=Math.abs(depth-Math.fround(ref.depth));
    maxQuantizedDepthError=Math.max(maxQuantizedDepthError,quantizedError);
    let residual=quantizedError;
    if(quantizedError>=depthTolerance&&!ref.pdo){
      const interval=depthInterval(ref.vertices,(i%t.width)*8+.5,Math.floor(i/t.width)*8+.5);
      residual=Math.max(0,Math.fround(interval.min)-depth,depth-Math.fround(interval.max));subpixelChecks++;
      maxDepthIntervalWidth=Math.max(maxDepthIntervalWidth,interval.max-interval.min);
    }
    maxDepthResidual=Math.max(maxDepthResidual,residual);
    assert(residual<depthTolerance,`step ${t.step} pixel ${i} WPO depth residual ${residual}, raw ${de}`);
    if((t.step!==3&&t.step<30)||owner!==0)continue;
    const old=ref.previousClip,px=(i%t.width)*8+.5,py=Math.floor(i/t.width)*8+.5;
    const velocity=[px/t.viewWidth*2-1-t.jitterX-old[0]/old[3]+t.previousJitterX,
      1-py/t.viewHeight*2-t.jitterY-old[1]/old[3]+t.previousJitterY];
    const actual=[float(t.pixels[p+4]),float(t.pixels[p+5])];assert(actual.some(v=>v!==0),'WPO must emit velocity');
    const decoded=actual.map(v=>{const linear=(v-32767/65535)/.2495;return Math.sign(linear)*linear*linear*.5;});
    for(let j=0;j<2;j++){
      const error=Math.abs(decoded[j]-velocity[j]);maxVelocityError=Math.max(maxVelocityError,error);
      const tolerance=2e-6+Math.sqrt(2*Math.abs(velocity[j]))/(.2495*65535)*.51;
      assert(error<tolerance,`WPO velocity pixel ${i}/${j}: ${decoded[j]} versus ${velocity[j]}`);
    }
    const words=[float(t.pixels[p+6]),float(t.pixels[p+7])].map(v=>Math.round(v*65535));
    const dz=float(((words[0]<<16)|(words[1]&65532))>>>0),error=Math.abs(dz-(depth-old[2]/old[3]));
    // Projection, interpolation and depth subtraction each quantize to float32.
    // Keep the absolute error as evidence as well as the per-sample bound.
    const zTolerance=Math.max(1e-7,3*Math.max(floatULP(depth),floatULP(old[2]/old[3])));
    maxVelocityDepthTolerance=Math.max(maxVelocityDepthTolerance,zTolerance);
    maxVelocityDepthError=Math.max(maxVelocityDepthError,error);assert(error<zTolerance,'WPO depth velocity');
    if(Math.hypot(...velocity)>1e-5)moving++;
  }
  assert(compared>200);assert(edgeSamples<expected.pixels.length*.05);
  if(t.step===3||t.step>=30)assert(moving>20&&moving>Math.min(100,(counts[0]||0)*.8));
  if([2,3,4,5,7,9,12,13,14,15,16,17,18,20,21,23,25].includes(t.step))assert((counts[0]||0)>20,'deformed surface coverage');
  if(t.step===19)assert.equal(counts[0]||0,0);
  return {counts,compared,edgeSamples,maxDepthError,maxQuantizedDepthError,maxDepthResidual,subpixelChecks,maxDepthIntervalWidth,
    maxVelocityError,maxVelocityDepthError,maxVelocityDepthTolerance,moving};
}
(async()=>{let browser,page,owner;try{
  browser=await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}-${scalar?'scalar':'packed'}`,{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await require('./startup-cvars.cjs')(browser,process.argv,report);
  await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+require('./observe-nanite-paths.cjs').toString()+')();\n('+observe.toString()+')('+JSON.stringify(scalar)+');\n'+await response.text()});});
  await browser.route('**/'+folder+'/index.html',async route=>{const response=await route.fetch();await route.fulfill({response,
    body:(await response.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12","-WebNaniteScene"')});});
  page=await browser.newPage();page.on('console',m=>{const s=m.text();report.logs.push(s);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(s))report.errors.push(s);});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=120,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  for(let step=1;step<=36;step++){
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteWPOTest',s),step),1);
    let test;const start=Date.now();
    do{
      await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
      assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteWPOTest',0)),1);
      test=await owner.evaluate(()=>globalThis.__webNaniteWPOTest||null);
    }while((!test||test.step!==step)&&Date.now()-start<90000);
    assert(test&&test.step===step);report.tests.push(test);
    assert(test.entries.every(e=>Array.isArray(e.previousLocalToWorld)&&Array.isArray(e.localWPOExtent)),
      'Runtime must contain the current WPO motion and culling diagnostics');
    try{test.validation=verify(test);}catch(error){test.validationFailure=error.stack;report.validationFailures.push({step,failure:error.stack});}
    const screenshot=path.join(output,`${scalar?'scalar':'packed'}-${step}.png`);
    await page.locator('canvas').screenshot({path:screenshot});test.image=audit(screenshot);
    console.log({step,...test.validation,failure:test.validationFailure});save();
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteWPOTest',37)),1);
  const cleanup=await page.evaluate(()=>globalThis.__webEngineFrames);
  await page.waitForFunction(f=>globalThis.__webEngineFrames>f+20,cleanup,{timeout:30000});
  report.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
  assert(report.rhi.asyncPrecacheRequested>100);assert.equal(report.rhi.asyncPrecacheRequested,report.rhi.asyncPrecacheCompleted);
  assert.equal(report.rhi.asyncPrecacheFailed||0,0);
  report.gpu=await owner.evaluate(()=>globalThis.__wpoGPU);
  report.paths=await owner.evaluate(()=>globalThis.__nanitePaths);
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.gpu.errors,[]);
  report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);assert.deepEqual(report.errors,[]);
  assert.deepEqual(report.validationFailures,[],'Every WPO scenario must satisfy its independent oracle');report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(owner)report.gpu=await owner.evaluate(()=>globalThis.__wpoGPU).catch(()=>report.gpu);if(browser)await browser.close();
  save();}})();
