'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PNG}=require('pngjs'),{audit}=require('./content-file-metadata.cjs');
const dir=path.join(__dirname,'results/nanite-automatic-scene'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const mode=process.argv.includes('--scalar-visibility')?'scalar':'packed';
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const report={pass:false,mode,source:audit(__filename)};
function image(file){return PNG.sync.read(fs.readFileSync(file));}
function statistics(values){values.sort((a,b)=>a-b);return {samples:values.length,mean:values.reduce((a,b)=>a+b,0)/values.length,p95:values[Math.floor(values.length*.95)],p99:values[Math.floor(values.length*.99)],max:values.at(-1)};}
try{
  const browserFile=path.join(dir,mode+'.json'),nativeFile=path.join(dir,'native-results.json');
  const browser=read(browserFile),native=read(nativeFile);assert(browser.pass&&native.pass&&browser.visualClock.renderTimeFrozen);
  [native.source,native.producer,native.binary,native.input,native.profile,...native.captures.flatMap(c=>[c.image,c.metadata])].forEach(verify);
  const views=read(native.input.file);assert.deepEqual(views.samples,browser.samples.samples);
  const files=[browser.tests[0].image,browser.tests[1].image,native.captures[0].image,native.captures[1].image];files.forEach(verify);
  const images=files.map(f=>image(f.file));for(const p of images){assert.equal(p.width,1280);assert.equal(p.height,720);}
  const c=browser.samples.camera;
  for(const view of views.views)for(const k of ['x','y','z','pitch','yaw'])assert(Math.abs(view[k]-c[k])<1e-5);
  const projection=browser.tests[0].view;assert(projection&&projection.projectionX>0);
  for(const capture of native.captures)for(const k of ['projectionX','projectionY'])assert(Math.abs(capture.values[k]-projection[k])<1e-5,'effective render projections must match');
  for(const k of ['x','y','z'])assert(Math.abs(projection[k]-c[k])<1e-5);
  for(const k of ['projectionX','projectionY'])assert.equal(browser.tests[1].view[k],projection[k]);
  const p=c.pitch*Math.PI/180,y=c.yaw*Math.PI/180;
  const forward=[Math.cos(p)*Math.cos(y),Math.cos(p)*Math.sin(y),Math.sin(p)],right=[-Math.sin(y),Math.cos(y),0],up=[-Math.sin(p)*Math.cos(y),-Math.sin(p)*Math.sin(y),Math.cos(p)];
  const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0),focal=640*projection.projectionX;
  assert(Math.abs(focal-360*projection.projectionY)<.001);
  const regions=browser.samples.samples.map(s=>{const d=[s.x-c.x,s.y-c.y,s.z-c.z],z=dot(d,forward);assert(z>0);return {material:s.material,x:640+dot(d,right)/z*focal,y:360-dot(d,up)/z*focal,radius:s.radius/z*focal};});
  const delta=(a,b,i)=>[0,1,2].reduce((s,k)=>s+Math.abs(a.data[i+k]-b.data[i+k]),0)/3;
  const residual=i=>[0,1,2].reduce((s,k)=>s+Math.abs((images[0].data[i+k]-images[1].data[i+k])-(images[2].data[i+k]-images[3].data[i+k])),0)/3;
  report.comparisons=[];report.failures=[];
  for(const region of [null,...regions]){
    const web=[],desktop=[],difference=[],absolute=[];
    for(let yy=0;yy<720;yy++)for(let xx=0;xx<1280;xx++){
      if(region&&Math.hypot(xx-region.x,yy-region.y)>region.radius*.65)continue;
      const i=(yy*1280+xx)*4;web.push(delta(images[0],images[1],i));desktop.push(delta(images[2],images[3],i));difference.push(residual(i));absolute.push(delta(images[0],images[2],i));
    }
    assert(web.length>50);const result={region:region||'whole-image',webNaniteToFallback:statistics(web),nativeNaniteToFallback:statistics(desktop),naniteEffectDifference:statistics(difference),absolutePlatformDifference:statistics(absolute)};
    report.comparisons.push(result);
    // Compare the change caused by Nanite on each platform as well as recording
    // absolute platform differences. Existing sky/reflection differences are
    // not silently called pixel parity by subtracting them from the report.
    if(result.naniteEffectDifference.mean>=5||result.naniteEffectDifference.p95>=18)
      report.failures.push({region:result.region,reason:'Nanite shading change exceeds mean 5 or p95 18 code values.'});
  }
  const sheet=new PNG({width:2560,height:1440});
  for(let n=0;n<4;n++)PNG.bitblt(images[n],sheet,0,0,1280,720,(n%2)*1280,Math.floor(n/2)*720);
  const sheetFile=path.join(dir,mode+'-native-web-comparison.png');fs.writeFileSync(sheetFile,PNG.sync.write(sheet));
  report.contactSheet={...audit(sheetFile),order:['Web Nanite','Web fallback','Native SM6 Nanite','Native SM6 fallback']};
  report.inputs=[audit(browserFile),audit(nativeFile),...files];
  assert.equal(report.failures.length,0,'Nanite must preserve normal scene shading relative to the same platform fallback');report.pass=true;
  report.boundary='Original default lighting and sky, identical sample materials/transforms/camera and frozen render time. Native SM6 proves eight real Nanite scene proxies, then zero with r.Nanite disabled. Thresholds measure the Nanite-induced image change; absolute Web/native lighting differences remain separately reported.';
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
fs.writeFileSync(path.join(dir,mode+'-native-comparison-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,comparisons:report.comparisons?.map(c=>({region:c.region,delta:c.naniteEffectDifference,absolute:c.absolutePlatformDifference}))}));
