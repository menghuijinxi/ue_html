'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PNG}=require('pngjs'),{audit}=require('./content-file-metadata.cjs');
const dir=path.join(__dirname,'results/nanite-full-scene-native');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const mode=process.argv.includes('--scalar-visibility')?'scalar':'packed';
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const report={pass:false,mode,source:audit(__filename),comparisons:[],failures:[],inputs:[],contactSheets:[]};
function statistics(values){values.sort((a,b)=>a-b);return {samples:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,
  p95:values[Math.floor(values.length*.95)],p99:values[Math.floor(values.length*.99)],max:values.at(-1)};}
try{
  const browserFile=path.join(dir,mode+'.json'),nativeFile=path.join(dir,'native-results.json');
  const browser=read(browserFile),native=read(nativeFile);
  assert(browser.pass&&native.pass&&browser.visualClock.materialTimeFrozen&&!browser.visualClock.renderTimeFrozen&&browser.visualClock.materialTime===0);
  verify(native.browserSettings);const settings=read(native.browserSettings.file);assert(settings.pass);
  [browser.source,browser.package,native.source,native.producer,native.binary,native.input,native.project,native.host,native.log,
    ...native.captures.flatMap(c=>[c.image,c.metadata,...c.phases.map(p=>p.image)])].forEach(verify);
  assert.equal(browser.views.length,3);assert.equal(native.captures.length,9);
  report.inputs.push(audit(browserFile),audit(nativeFile));
  for(const view of browser.views){
    const captures=native.captures.slice(view.index*3,view.index*3+3);assert.equal(view.tests.length,3);
    const inventory=items=>{
      const counts=new Map();
      for(const item of items){const key=`${item.mesh}:${item.clusters}`;counts.set(key,(counts.get(key)||0)+1);}
      return [...counts].sort(([a],[b])=>a.localeCompare(b));
    };
    assert.deepEqual(view.gpu.errors,[]);assert.equal(view.gpu.features.includes('atomic-vec2u-min-max'),mode==='packed');
    for(const c of captures){
      for(const key of ['projectionX','projectionY'])assert(Math.abs(c.values[key]-view.tests[0].view[key])<1e-5,'Actual projections differ');
      for(const [i,key] of ['x','y','z','pitch','yaw'].entries())assert(Math.abs(c.values.view[key]-view.camera[i])<1e-5,'Camera differs');
      assert.equal(c.values.naniteAssetComponents,view.tests[0].assets.length);
      assert.deepEqual(inventory(c.values.components),inventory(view.tests[0].assets),'Native/browser mesh and cluster inventories differ');
    }
    assert(captures[0].values.naniteSceneProxies>=view.tests[0].registered);
    assert.equal(captures[1].values.naniteSceneProxies,0);
    assert.equal(captures[2].values.naniteSceneProxies,captures[0].values.naniteSceneProxies);
    for(const phase of [0,1,2,3]){
    const getPhase=(item)=>{assert.equal(item.phases.length,4);const result=item.phases.find(p=>p.phase===phase);assert(result);return result.image;};
    for(const [i,c] of captures.entries()){
      const final=c.values.stability.filter(s=>s.phase===phase).at(-1),web=view.tests[i].phases.find(p=>p.phase===phase);
      assert(final&&web);assert.equal(final.antiAliasingMethod,settings.settings.lighting.antiAliasing);
      assert.equal(web.antiAliasingMethod,final.antiAliasingMethod);assert.equal(c.values.materialTime,0);assert(!c.values.renderTimeFrozen);
      assert(Math.abs(final.materialMipBias-web.materialMipBias)<1e-7,'Actual material mip bias differs');
      assert(final.realtime&&final.temporalAA);for(const key of ['jitterX','jitterY'])assert(Math.abs(final[key]-web[key])<1e-7,'Rendered projection jitter differs');
    }
    const files=[getPhase(view.tests[0]),getPhase(view.tests[1]),getPhase(captures[0]),getPhase(captures[1]),getPhase(view.tests[2]),getPhase(captures[2])];
    files.forEach(verify);report.inputs.push(...files);
    const images=files.map(f=>PNG.sync.read(fs.readFileSync(f.file)));
    for(const image of images){assert.equal(image.width,1280);assert.equal(image.height,720);}
    const regions=[{name:'whole-image',x:0,y:0,width:1280,height:720}];
    for(let y=0;y<3;y++)for(let x=0;x<4;x++)regions.push({name:`tile-${x}-${y}`,x:x*320,y:y*240,width:320,height:240});
    for(const region of regions){
      const web=[],desktop=[],difference=[],absolute=[],webRestore=[],nativeRestore=[];
      for(let yy=region.y;yy<region.y+region.height;yy++)for(let xx=region.x;xx<region.x+region.width;xx++){
        const p=(yy*1280+xx)*4;let wd=0,nd=0,residual=0,platform=0,wr=0,nr=0;
        for(let c=0;c<3;c++){
          const [a,b,n,f,r,s]=images.map(image=>image.data[p+c]);
          wd+=Math.abs(a-b);nd+=Math.abs(n-f);residual+=Math.abs((a-b)-(n-f));platform+=Math.abs(a-n);
          wr+=Math.abs(a-r);nr+=Math.abs(n-s);
        }
        web.push(wd/3);desktop.push(nd/3);difference.push(residual/3);absolute.push(platform/3);webRestore.push(wr/3);nativeRestore.push(nr/3);
      }
      const comparison={view:view.index,phase,region,webNaniteToFallback:statistics(web),nativeNaniteToFallback:statistics(desktop),
        naniteEffectDifference:statistics(difference),absolutePlatformDifference:statistics(absolute),
        webRecreationDifference:statistics(webRestore),nativeRecreationDifference:statistics(nativeRestore)};
      report.comparisons.push(comparison);
      for(const metric of ['naniteEffectDifference','webRecreationDifference','nativeRecreationDifference']){
        if(comparison[metric].mean>=5||comparison[metric].p95>=18)report.failures.push({view:view.index,phase,region:region.name,metric,
          reason:'Exceeds the established default-scene threshold: mean 5 or p95 18 code values.'});
      }
    }
    if(phase===0){
    const sheet=new PNG({width:2560,height:2160});
    for(let n=0;n<images.length;n++)PNG.bitblt(images[n],sheet,0,0,1280,720,n%2*1280,Math.floor(n/2)*720);
    const sheetFile=path.join(dir,`${mode}-${view.index}-comparison.png`);fs.writeFileSync(sheetFile,PNG.sync.write(sheet));
    report.contactSheets.push({...audit(sheetFile),order:['Web Nanite','Web fallback','Native SM6 Nanite','Native SM6 fallback','Web restored','Native restored']});
    }
    }
  }
  assert.equal(report.failures.length,0,'Full-scene Nanite must preserve shading and recreation at all fixed views');report.pass=true;
  report.boundary='Three original Villa views and all four actual AO phases, native SM6 real proxies and ordinary fallback, effective projections and frozen material time/general sampling sequence. AO jitter and temporal histories remain active. Each phase stabilizes before capture. Absolute platform differences are recorded independently. This comparison does not accept native standalone performance or unsupported deformation/material/view permutations.';
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
fs.writeFileSync(path.join(dir,mode+'-comparison.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:report.pass,failures:report.failures,views:report.comparisons.filter(c=>c.region.name==='whole-image')}));
