'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility');
const output=path.join(__dirname,'results/nanite-programmable');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalar,source:audit(__filename),package:audit(path.join(__dirname,'build/nanite-browser/package.json')),tests:[],errors:[],logs:[]};
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;
  globalThis.__programmableGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__programmableGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__programmableGPU.errors.push(e.error.message));return device;
  };
}
function entry(t,id){const index=(id>>>8)-1;return t.entries.find(e=>index>=e.clusterBase&&index<e.clusterBase+e.clusterCount);}
function checker(t,i){
  const u=float(t.inputs[i*16+7]),v=float(t.inputs[i*16+11]);
  const x=Math.floor((u-Math.floor(u))*8),y=Math.floor((v-Math.floor(v))*8);
  return ((x>>1)+(y>>1))%2===1;
}
function offsetDepth(front,i,offset){
  if(!front.perspective)return float(front.pixels[i*28+1])+Math.max(0,offset)*front.worldDepthScale;
  const p=i*28,m=i*16,e=entry(front,front.pixels[p]);
  const local=[float(front.inputs[m+4]),float(front.inputs[m+5]),float(front.inputs[m+6]),1];
  const w=local.reduce((sum,x,k)=>sum+x*e.localToClip[k*4+3],0);
  const delta=[0,1,2].map(j=>local.reduce((sum,x,k)=>sum+x*e.localToWorld[k*4+j],0)-[100000,0,100000][j]);
  // The authored UE material uses PDOM_AlongCameraVector. Independent camera
  // projection gives the forward-depth change for a world-space ray offset.
  const forwardOffset=Math.max(0,offset)*delta[0]/Math.hypot(...delta);
  return float(front.pixels[p+1])*w/(w+forwardOffset);
}
function verify(t){
  assert(t.complete);assert.equal(t.rejected,0);assert.equal(t.pixels.length,t.width*t.height*28);
  assert.equal(t.inputs.length,t.width*t.height*16);assert.equal(t.hzb,t.step>=12);
  const extended=t.step>16,scenario=extended?Math.floor((t.step-17)/4):-1,phase=extended?(t.step-17)%4:-1;
  const base=extended?16+scenario*4:0,front=report.tests[base],back=report.tests[base+1],counts={};
  let compared=0,maxDepthError=0,maxColorError=0;
  const masked=extended?phase>=2:[4,8,9,12,14,16].includes(t.step);
  const oneSidedHidden=extended&&phase===2&&[1,3,4,8].includes(scenario);
  let holes=0,pdoChangedWinner=0;
  for(let i=0;i<t.width*t.height;i++){
    const p=i*28,id=t.pixels[p],owner=id?entry(t,id)?.component:-1;
    assert(owner===-1||owner===0||owner===1,'visibility must belong to a registered component');
    if(extended?phase>=2:t.step>=3){
      let fg=!!front.pixels[p]&&!([13,15].includes(t.step)),bg=!!back.pixels[p];
      if(oneSidedHidden)fg=false;
      if(fg&&masked&&!checker(front,i)){fg=false;holes++;}
      if(t.step===11)fg=false;
      const offset=extended?(phase===3?80:0):t.step===5?25:[6,8].includes(t.step)?80:0;
      const fd=fg?offsetDepth(front,i,offset):-1,bd=bg?float(back.pixels[p+1]):-1;
      const expected=fd<0&&bd<0?-1:fd>=bd?0:1;
      if(fg&&bg&&offset>0&&bd>fd&&float(front.pixels[p+1])>bd)pdoChangedWinner++;
      assert.equal(owner,expected,`step ${t.step} pixel ${i} ownership (${fd}, ${bd})`);
      if(expected>=0){
        const error=Math.abs(float(t.pixels[p+1])-Math.max(fd,bd));maxDepthError=Math.max(maxDepthError,error);
        // Orthographic depth spans [0,1], so allow two float32 ULPs there.
        assert(error<(t.perspective?3e-8:1.2e-7),`step ${t.step} pixel ${i} PDO depth error ${error}`);compared++;
      }
    }else if(id)assert.equal(owner,extended?phase:t.step-1);
    if(!id)continue;
    assert.equal(t.pixels[p+1],t.pixels[p+2],'programmable depth must reach actual scene depth');
    assert.equal(t.inputs[i*16],id);counts[owner]=(counts[owner]||0)+1;
    assert.equal(Math.round(float(t.pixels[p+15])*255)&15,1,'real DefaultLit material must execute');
    const color=owner===0?[.2,.4,.7]:[.1,.7,.2];
    for(let j=0;j<3;j++){
      const error=Math.abs(srgb(float(t.pixels[p+16+j]))*255-Math.round(srgb(color[j])*255));
      maxColorError=Math.max(maxColorError,error);assert(error<=.5,`step ${t.step} pixel ${i} material color ${j}`);
    }
  }
  assert(Object.values(counts).reduce((a,b)=>a+b,0)>250,'substantial real coverage required');
  if(masked&&!oneSidedHidden)assert(holes>100,'checker must expose actual holes');
  if([6,8].includes(t.step)||(extended&&phase===3))assert(pdoChangedWinner>100,'PDO must change the winning geometry');
  return {scenario,phase,counts,compared,holes,pdoChangedWinner,maxDepthError,maxColorError};
}
(async()=>{let browser,page,owner;try{
  browser=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{channel:'msedge',headless:true,viewport:{width:960,height:640}});
  await browser.route('**/web-engine-worker.js?*',async route=>{const response=await route.fetch();await route.fulfill({response,body:'('+observe.toString()+')('+JSON.stringify(scalar)+');\n'+await response.text()});});
  // The real two-slot corrugated plane has more root data than the small
  // uploader fixture. Use the same verified budget as the sidedness suite.
  await browser.route('**/nanite-browser/index.html',async route=>{const response=await route.fetch();await route.fulfill({response,
    body:(await response.text()).replace('"-WebNaniteRootPages=2"','"-WebNaniteRootPages=128","-WebNaniteStreamingPages=12"')});});
  page=await browser.newPage();page.on('console',m=>{const s=m.text();report.logs.push(s);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(s))report.errors.push(s);});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://127.0.0.1:8765/build/nanite-browser/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=120,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  for(let step=1;step<=52;step++){
    assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteProgrammableTest',s),step),1);
    let test;const start=Date.now();
    do{
      await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
      assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteProgrammableTest',0)),1);
      test=await owner.evaluate(()=>globalThis.__webNaniteProgrammableTest||null);
    }while((!test||test.step!==step)&&Date.now()-start<90000);
    assert(test&&test.step===step);report.tests.push(test);test.validation=verify(test);
    const pipelineStart=Date.now();
    do{
      test.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
      if(test.rhi&&test.rhi.asyncPrecacheRequested===test.rhi.asyncPrecacheCompleted)break;
      await page.waitForTimeout(100);assert.deepEqual(report.errors,[]);
    }while(Date.now()-pipelineStart<90000);
    assert(test.rhi.asyncPrecacheRequested>100);assert.equal(test.rhi.asyncPrecacheRequested,test.rhi.asyncPrecacheCompleted);
    assert.equal(test.rhi.asyncPrecacheFailed||0,0);
    const screenshot=path.join(output,`${scalar?'scalar':'packed'}-${step}.png`);
    await page.locator('canvas').screenshot({path:screenshot});test.image=audit(screenshot);
    console.log({step,...test.validation});
  }
  assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteProgrammableTest',53)),1);
  const cleanup=await page.evaluate(()=>globalThis.__webEngineFrames);
  await page.waitForFunction(f=>globalThis.__webEngineFrames>f+20,cleanup,{timeout:30000});
  report.gpu=await owner.evaluate(()=>globalThis.__programmableGPU);
  assert.equal(report.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert.deepEqual(report.gpu.errors,[]);
  report.frames=await page.evaluate(()=>globalThis.__webEngineFrames);assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(owner)report.gpu=await owner.evaluate(()=>globalThis.__programmableGPU).catch(()=>report.gpu);if(page)report.engine=await page.evaluate(()=>({frames:globalThis.__webEngineFrames,failure:globalThis.__webEngineFailure})).catch(()=>null);if(browser)await browser.close();fs.writeFileSync(path.join(output,scalar?'browser-scalar.json':'browser.json'),JSON.stringify(report,null,2));}})();
