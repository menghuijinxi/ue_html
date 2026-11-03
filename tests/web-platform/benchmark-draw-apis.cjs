'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const option=name=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const tag=option('tag')||'draw-api-v1',rounds=Number(option('rounds')||3),only=option('only');
assert(/^[a-z0-9-]+$/.test(tag));assert(Number.isInteger(rounds)&&rounds>=1&&rounds<=5);
const root=__dirname,build=path.join(root,'build/draw-api'),out=path.join(root,'results',tag);
const sources=['draw-api-common.h','draw-api-d3d12.cpp','draw-api-webgpu.cpp','draw-api-worker.js',
  'draw-api-wasm-worker.js','draw-api-benchmark.html','benchmark-draw-apis.cjs','build-draw-api-benchmark.ps1','draw-api/CMakeLists.txt'];
const files=[...sources.map(a=>path.join(root,a)),...['Release/draw_d3d12.exe','Release/draw_dawn.exe','draw-wasm.js','draw-wasm.wasm','build-config.json'].map(a=>path.join(build,a))];
const hash=file=>({file:path.relative(root,file),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report={date:new Date().toISOString(),tag,rounds,build:JSON.parse(fs.readFileSync(path.join(build,'build-config.json'),'utf8').replace(/^\uFEFF/,'')),environment:{cpu:os.cpus()[0].model,logicalCores:os.cpus().length,os:os.version(),node:process.version},
  workload:{counts:[1000,3200,10000],modes:['draw-only','rotate-pipeline-bindgroup-vertex-index','prebuilt-rotating-bundle','single-instanced-draw'],
    verticesPerDraw:3,target:'64x64 RGBA8, 1x1 scissor, clear=0, no depth/blend/culling',warmupFrames:12,measuredFrames:60,inFlight:3,
    gpuSamples:10,pipelinesCreatedDuringMeasurement:0,resourceCreationDuringMeasurement:0,
    scheduling:'one CPU recording thread per backend; no UE; no canvas, presentation or animation-frame cap',
    timestamps:'extra GPU-only samples after CPU samples; GPU timestamp ranges include the render pass clear',
    limits:'Dawn version differs from browser; DX12 HLSL and WebGPU WGSL compile separately; production WebGPU validation remains enabled'},
  files:files.map(hash),runs:[],pass:false};
assert(!fs.existsSync(out+'.json'),'Use a new tag to preserve earlier measurements');
const save=()=>fs.writeFileSync(out+'.json',JSON.stringify(report,null,2));
function native(exe,file,log){return new Promise((resolve,reject)=>{
  const fd=fs.openSync(log,'w'),child=spawn(exe,[file],{windowsHide:true,stdio:['ignore',fd,fd]});
  const timer=setTimeout(()=>{child.kill();reject(new Error('Native timeout'));},300000);
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);fs.closeSync(fd);
    if(code!==0)reject(new Error('Native exit '+code+'; '+log));else resolve(JSON.parse(fs.readFileSync(file)));});
});}
async function browser(kind,round){
  const profile=path.join(root,'build/browser-profiles',`${tag}-${round}-${kind}`);
  assert(!fs.existsSync(profile),'Fresh benchmark profile required');
  const context=await chromium.launchPersistentContext(profile,{channel:'msedge',headless:false,viewport:{width:640,height:480},args:[]});
  try{
    const page=context.pages()[0],cdp=await context.newCDPSession(page),browserCDP=await context.browser().newBrowserCDPSession();
    report.browser=await cdp.send('Browser.getVersion');
    report.gpu=await browserCDP.send('SystemInfo.getInfo');
    report.browserCommand=await cdp.send('Browser.getBrowserCommandLine').catch(e=>({unavailable:e.message,additionalArguments:[]}));
    const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push(e.stack));
    await page.goto('http://127.0.0.1:8765/draw-api-benchmark.html');await page.bringToFront();
    await page.waitForFunction(()=>window.runDrawBenchmark);
    const result=await page.evaluate(async kind=>{
      return await Promise.race([runDrawBenchmark(kind),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker timeout')),300000))]);
    },kind);
    result.console=logs;result.crossOriginIsolated=await page.evaluate(()=>crossOriginIsolated);return result;
  }finally{await context.close();}
}
(async()=>{try{
  for(let round=0;round<rounds;round++){
    const order=round%2?['wasm','js','dawn','dx12']:['dx12','dawn','js','wasm'];
    for(const kind of order){if(only&&kind!==only)continue;
      console.log(`Start round=${round} backend=${kind}`);const start=new Date().toISOString(),file=`${out}-r${round}-${kind}.json`;
      const r=kind==='dx12'||kind==='dawn'?await native(path.join(build,'Release',kind==='dx12'?'draw_d3d12.exe':'draw_dawn.exe'),file,file+'.log'):await browser(kind,round);
      r.round=round;r.started=start;r.ended=new Date().toISOString();
      assert(r.pass&&r.cases.length===12&&r.cases.every(c=>c.outputVerified));
      fs.writeFileSync(file,JSON.stringify(r,null,2));report.runs.push(r);save();
      console.log(`Done ${kind}: 3200 rotating draw loop=${r.cases.find(c=>c.draws===3200&&c.mode===1).drawLoop.medianMs.toFixed(3)} ms`);
    }
  }
  assert.equal(report.runs.length,rounds*(only?1:4));report.pass=true;
}finally{save();}})().catch(e=>{console.error(e);process.exitCode=1;});
