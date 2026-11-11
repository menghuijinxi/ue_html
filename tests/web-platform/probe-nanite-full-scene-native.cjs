'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {PNG}=require('pngjs');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const scalar=process.argv.includes('--scalar-visibility'),mode=scalar?'scalar':'packed';
const defaultScene=process.argv.includes('--default-scene');
const folder=process.argv.find(a=>a.startsWith('--folder='))?.slice(9)||(defaultScene?'nanite-core-default':'nanite-full-scene');
assert(/^[a-z0-9-]+$/.test(folder));
const output=path.join(__dirname,defaultScene?'results/nanite-default-native-current':'results/nanite-full-scene-native');fs.mkdirSync(output,{recursive:true});
const report={pass:false,scalar,defaultScene,source:audit(__filename),package:audit(path.join(__dirname,'build',folder,'package.json')),
  views:[],errors:[],logs:[],configs:[],boundary:'Native comparison input captures; acceptance requires the separate SM6 captures and image comparison.'};
const cameras=defaultScene?[null]:[[-175,-80,160,-5,50],[-175,-80,160,-5,230],[-1000,-70,230,-8,65]];
const save=()=>fs.writeFileSync(path.join(output,mode+'.json'),JSON.stringify(report,null,2));
function observe(scalar){
  const request=GPUAdapter.prototype.requestDevice;globalThis.__nativeSceneGPU={errors:[]};
  GPUAdapter.prototype.requestDevice=async function(d){
    if(scalar)d={...d,requiredFeatures:[...(d?.requiredFeatures||[])].filter(f=>f!=='atomic-vec2u-min-max')};
    const device=await request.call(this,d);__nativeSceneGPU.features=[...device.features];
    device.addEventListener('uncapturederror',e=>__nativeSceneGPU.errors.push(e.error.message));return device;
  };
}
(async()=>{let context,page;try{
  for(const [index,camera] of cameras.entries()){
    context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),{
      channel:'msedge',headless:true,viewport:{width:1280,height:720}});
    await context.route('**/web-engine-worker.js?*',async route=>{const r=await route.fetch();
      await route.fulfill({response:r,body:`(${observe.toString()})(${scalar});\n`+await r.text()});});
    await context.route('**/'+folder+'/index.html',async route=>{const r=await route.fetch();
      await route.fulfill({response:r,body:(await r.text()).replace('arguments: [','arguments: ["-WebMaterialTestClock",')});});
    await context.route('**/config-files.json*',async route=>{
      const r=await route.fetch(),files=await r.json();
      const file=files.find(f=>defaultScene?f.path==='/Engine/Platforms/Web/Config/WebEngine.ini':f.path.endsWith('/UEWebEngine/Config/DefaultEngine.ini'));assert(file);
      const text=Buffer.from(file.data,'base64').toString('utf8')+'\n[SystemSettings]\nr.Test.FreezeTemporalSequences=1\n';
      const data=Buffer.from(text);file.data=data.toString('base64');file.sha256=crypto.createHash('sha256').update(data).digest('hex');
      report.configs.push({path:file.path,sha256:file.sha256,text});await route.fulfill({response:r,body:JSON.stringify(files)});
    });
    page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.stack));
    page.on('console',m=>{const line=m.text();if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(line))report.errors.push(line);
      report.logs.push(line);if(report.logs.length>500)report.logs.shift();});
    await page.goto('http://127.0.0.1:8765/build/'+folder+'/index.html');
    await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineRecovery?.phase==='running',null,{timeout:180000});
    assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
    const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
    report.visualClock=await owner.evaluate(()=>globalThis.__webVisualTestClock);
    assert(report.visualClock.materialTimeFrozen&&!report.visualClock.renderTimeFrozen&&report.visualClock.materialTime===0);
    if(camera)assert.equal(await page.evaluate(c=>__webEngineRPC('WebProjectViewTest',...c),camera),1);
    if(defaultScene){report.samples=await owner.evaluate(()=>globalThis.__webDefaultSamples);
      assert(report.samples.sceneUnchanged);assert.equal(report.samples.count,8);}
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBoundsTest',1,0,1)),1);
    await page.addStyleTag({content:'body > :not(canvas) { visibility: hidden !important; } canvas, canvas * { visibility: visible !important; }'});
    const view={camera:camera||['x','y','z','pitch','yaw'].map(k=>report.samples.camera[k]),index,tests:[]};report.views.push(view);
    for(const step of [1,2,3]){
      assert.equal(await page.evaluate(s=>__webEngineRPC('WebNaniteAutomaticSceneTest',s),step),1);
      let t;const start=Date.now();
      do{await page.waitForTimeout(250);assert.deepEqual(report.errors,[]);
        assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
        await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',0));
        t=await owner.evaluate(()=>globalThis.__webNaniteAutomaticSceneTest||null);
      }while((!t||t.step!==step)&&Date.now()-start<120000);
      assert(t&&t.step===step);view.tests.push(t);save();
      assert(t.automatic&&t.rejected===0);assert.equal(t.enabled,step!==2);
      const suppressed=t.batches.filter(b=>!b.material&&!b.depth&&!b.occluder).length;
      if(defaultScene){assert.equal(t.assets.length,8);assert.equal(t.batches.length,8);
        for(const asset of t.assets){assert(asset.mesh.includes('SM_TestSphere'));assert(asset.clusters>1&&asset.fallbackTriangles>=16000);}}
      else assert(t.assets.length>2000&&t.batches.length>2000);
      if(step===2){assert.equal(t.entries,0);assert.equal(suppressed,0);}
      else{
        assert(t.materialComplete&&t.entries>0);
        if(defaultScene){assert.equal(t.registered,8);assert.equal(suppressed,8);}
        else assert(t.registered>1254&&suppressed>1254);
        assert.equal(t.cullStates.length,t.entries*4);
        for(let i=0;i<t.entries;i++)assert.equal(t.cullStates[i*4+1],0);
      }
      const frame=await page.evaluate(()=>__webEngineFrames);
      await page.waitForFunction(f=>__webEngineFrames>=f+600,frame,{timeout:120000});
      t.rhi=await owner.evaluate(()=>globalThis.__webOptimizationRHI);
      assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
      const previous=new Map(),stable=[0,0,0,0];t.captureChecks=[];
      for(let round=0;round<8;round++){
        const phases=[];
        for(let phase=0;phase<4;phase++){
          const serial=await owner.evaluate(()=>globalThis.__webNaniteNativeCapture?.serial||0);
          assert.equal(await page.evaluate(p=>__webEngineRPC('WebNaniteNativeCaptureTest',p),phase),1);
          let capture;const started=Date.now();
          do {await page.waitForTimeout(50);assert.deepEqual(report.errors,[]);await page.evaluate(()=>__webEngineRPC('WebNaniteNativeCaptureTest',-1));
            capture=await owner.evaluate(()=>globalThis.__webNaniteNativeCapture||null);
          }while((!capture||capture.serial<=serial)&&Date.now()-started<30000);
          assert(capture&&capture.serial===serial+1);assert.equal(capture.phase,phase);assert.equal(capture.width,1280);assert.equal(capture.height,720);
          assert.equal(capture.antiAliasingMethod,defaultScene?2:4);assert(capture.worldTime>0);
          const bytes=Buffer.from(capture.rgba,'base64');assert.equal(bytes.length,1280*720*4);delete capture.rgba;
          let difference=255;if(previous.has(phase)){let sum=0;const before=previous.get(phase);for(let i=0;i<bytes.length;i++)if(i%4!==3)sum+=Math.abs(bytes[i]-before[i]);difference=sum/(1280*720*3);}
          previous.set(phase,bytes);stable[phase]=difference<.05?stable[phase]+1:0;
          const file=path.join(output,`${mode}-${index}-${step}-round${round}-phase${phase}.png`);
          fs.writeFileSync(file,PNG.sync.write({width:1280,height:720,data:bytes}));
          phases.push({...capture,image:audit(file)});t.captureChecks.push({round,phase,frame:capture.frame,meanDifference:difference,stable:stable[phase],image:audit(file)});
        }
        if(stable.every(n=>n>=2)){t.phases=phases;break;}
        const current=await page.evaluate(()=>__webEngineFrames);await page.waitForFunction(f=>__webEngineFrames>=f+120,current,{timeout:120000});
      }
      assert(t.phases,'Each AO phase must stabilize independently');
      t.streaming=await owner.evaluate(()=>globalThis.__webTextureStreaming);
      assert.equal(t.streaming.pending,0);assert.equal(t.streaming.residentMips,t.streaming.requestedMips);
      const file=path.join(output,`${mode}-${index}-${step}.png`);fs.copyFileSync(t.phases[0].image.file,file);t.image=audit(file);
      t.captureWarmupFrames=await page.evaluate(()=>__webEngineFrames)-frame;
      const before=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames}));
      await page.waitForFunction(f=>__webEngineFrames>=f+240,before.frames,{timeout:120000});
      const after=await page.evaluate(()=>({time:performance.now(),frames:__webEngineFrames}));
      t.performance={frames:after.frames-before.frames,milliseconds:after.time-before.time,
        fps:(after.frames-before.frames)*1000/(after.time-before.time)};
      console.log({index,step,entries:t.entries,suppressed,fps:t.performance.fps});save();
    }
    assert.deepEqual(view.tests[0].view,view.tests[1].view);assert.deepEqual(view.tests[0].view,view.tests[2].view);
    view.gpu=await owner.evaluate(()=>__nativeSceneGPU);assert.deepEqual(view.gpu.errors,[]);
    assert.equal(view.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
    view.frames=await page.evaluate(()=>__webEngineFrames);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteAutomaticSceneTest',-1)),1);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteNativeCaptureTest',-2)),1);
    assert.equal(await page.evaluate(()=>__webEngineRPC('WebNaniteMaterialBoundsTest',-1,0,1)),1);
    await context.close();context=null;save();
  }
  assert.deepEqual(report.errors,[]);report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{await context?.close();save();}})();
