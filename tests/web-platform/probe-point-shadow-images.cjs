'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{PNG}=require('pngjs'),{audit}=require('./content-file-metadata.cjs');
const [baseline,candidate,tag]=process.argv.slice(2);assert([baseline,candidate,tag].every(n=>/^[a-z0-9-]+$/.test(n)));
const output=path.join(__dirname,'results',tag);assert(!fs.existsSync(output));fs.mkdirSync(output);
fs.copyFileSync(__filename,path.join(output,'source.cjs'));
const cameras=[[75,-66,150,-9.7,51.8],[6,-82,151,-8.9,56.8],[-253,-143,152,-5.8,75.5],[-775,-300,180,-30,270]];
const report={pass:false,source:audit(__filename),cameras,runs:[],comparisons:[],
  boundary:'Fixed material-expression time for visual comparison only, with advancing render/streaming time, separate from normal moving performance. '
    +'Identical views and existing quality; whole-canvas pixel error is descriptive, not full desktop parity.'};
const save=()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
(async()=>{try{
  for(const [index,folder] of [baseline,candidate].entries()) {
    const run={folder,images:[],errors:[]};report.runs.push(run);
    const context=await chromium.launchPersistentContext(`C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}-${index}`,
      {channel:'msedge',headless:true,viewport:{width:1280,height:720},deviceScaleFactor:1});
    try {
      await context.route('**/index.html',async route=>{const r=await route.fetch();await route.fulfill({response:r,
        body:(await r.text()).replace('arguments: [','arguments: ["-WebMaterialTestClock",')});});
      const page=context.pages()[0];
      page.on('pageerror',e=>run.errors.push(e.message));
      page.on('console',m=>{if(/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text()))run.errors.push(m.text());});
      await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,{waitUntil:'commit'});
      await page.waitForFunction(()=>globalThis.__webEngineFailure||(globalThis.__webEngineFrames>180&&globalThis.__webPSOPrecacheReady),null,{timeout:300000});
      assert(!await page.evaluate(()=>globalThis.__webEngineFailure));
      const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
      run.clock=await owner.evaluate(()=>globalThis.__webVisualTestClock);assert(!run.clock.renderTimeFrozen&&run.clock.materialTimeFrozen);
      await page.addStyleTag({content:'body > :not(canvas) { visibility:hidden !important } canvas { visibility:visible !important }'});
      for(const [view,camera] of cameras.entries()) {
        assert.equal(await page.evaluate(c=>__webEngineRPC('WebProjectViewTest',...c),camera),1);
        const frame=await page.evaluate(()=>__webEngineFrames);
        await page.waitForFunction(f=>__webEngineFrames>=f+300&&__webTextureStreaming?.pending===0,frame,{timeout:120000});
        await page.waitForTimeout(3000);
        const image=path.join(output,index+'-'+view+'.png');await page.locator('canvas').screenshot({path:image});
        run.images.push({view,camera,image:audit(image),state:await owner.evaluate(()=>({camera:__webDefaultCamera,
          view:__webRenderView,settings:__webProjectSettings,streaming:__webTextureStreaming,optimization:__webOptimizationRHI}))});save();
      }
      assert.deepEqual(run.errors,[]);run.pass=true;
    } finally {await context.close();}
  }
  for(let view=0;view<cameras.length;view++) {
    const [a,b]=report.runs.map(r=>PNG.sync.read(fs.readFileSync(r.images[view].image.file)));
    assert.equal(a.width,b.width);assert.equal(a.height,b.height);let sum=0,changed=0,max=0;
    for(let i=0;i<a.data.length;i+=4)for(let c=0;c<3;c++) {const d=Math.abs(a.data[i+c]-b.data[i+c]);sum+=d;max=Math.max(max,d);if(d>8)changed++;}
    const comparison={view,meanAbsoluteRGB:sum/(a.width*a.height*3),channelFractionOver8:changed/(a.width*a.height*3),max};
    report.comparisons.push(comparison);assert(comparison.meanAbsoluteRGB<2,'Unexpected visual change; inspect images');
  }
  report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}finally{save();console.log(JSON.stringify({pass:report.pass,comparisons:report.comparisons,failure:report.failure,output}));}})();
