'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {audit,metadata}=require('./content-file-metadata.cjs');
const runtimeOnly=process.argv.includes('--runtime-only');
const output=path.join(__dirname,'results',runtimeOnly?'nanite-pipeline-runtime-only':'nanite-pipeline-startup');
fs.mkdirSync(output,{recursive:true});
const report={pass:false,date:new Date().toISOString(),source:audit(__filename),
  package:audit(path.join(__dirname,'build/nanite-browser/package.json')),logs:[],errors:[]};
(async()=>{let context;
try {
  context=await chromium.launchPersistentContext(path.join(__dirname,'results/nanite-browser/profile'),
    {channel:'msedge',headless:true,viewport:{width:960,height:640}});
  if(runtimeOnly) {
    // Diagnose RHI changes while a new scene Cook runs. This result cannot
    // validate shader-compiler changes or serve as a complete package check.
    const buildFile=path.join(__dirname,'build/nanite-browser-runtime/build.json');
    const build=JSON.parse(fs.readFileSync(buildFile,'utf8'));
    assert(build.pass);[...build.sources,...build.products].forEach(i=>assert.equal(audit(i.file).sha256,i.sha256,i.file));
    report.runtimeOverride=audit(buildFile);report.oldCookDiagnostic=true;
    const file=path.join(__dirname,'build/nanite-browser/index.html');
    let html=fs.readFileSync(file,'utf8');const match=html.match(/const localRuntimeAssets = (\{[^\n]+\});/);assert(match);
    const assets=JSON.parse(match[1]);
    assets.wasm=metadata(path.join(__dirname,'build/nanite-browser-runtime/UEWebEngineThreads.wasm'),'UEWebEngineThreads.wasm');
    for(const p of build.products)assets.versions[path.basename(p.file)]=p.sha256;
    html=html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';');
    const dir=path.join(__dirname,'build/nanite-pipeline-runtime-only');fs.mkdirSync(dir,{recursive:true});
    const original=JSON.parse(fs.readFileSync(report.package.file,'utf8'));
    for(const item of original.products){
      const name=path.basename(item.file);if(name==='index.html'||name.startsWith('UEWebEngineThreads.'))continue;
      assert.equal(audit(item.file).sha256,item.sha256,item.file);
      const dest=path.join(dir,name);
      if(name==='content.bin'){if(!fs.existsSync(dest))fs.linkSync(item.file,dest);assert.equal(audit(dest).sha256,item.sha256);}
      else fs.copyFileSync(item.file,dest);
    }
    for(const item of build.products)fs.copyFileSync(item.file,path.join(dir,path.basename(item.file)));
    fs.writeFileSync(path.join(dir,'index.html'),html);
    report.diagnosticIndex=audit(path.join(dir,'index.html'));
  }
  const page=await context.newPage();
  page.on('console',m=>{const text=m.text();report.logs.push(text);if(/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(text))report.errors.push(text);});
  page.on('pageerror',e=>report.errors.push(e.stack));
  await page.goto('http://127.0.0.1:8765/build/'+(runtimeOnly?'nanite-pipeline-runtime-only':'nanite-browser')+'/index.html');
  await page.waitForFunction(()=>globalThis.__webEngineFailure||globalThis.__webEngineFrames>=90,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>globalThis.__webEngineFailure||null),null);
  const owner=page.workers().find(w=>w.url().includes('web-engine-worker.js'));assert(owner);
  await page.waitForFunction(()=>globalThis.__webPSOPrecache?.active===0&&globalThis.__webPSOPrecache?.filePrecompileTasks===0&&
    globalThis.__webOptimizationRHI?.asyncPrecacheRequested>2000&&
    globalThis.__webOptimizationRHI.asyncPrecacheRequested===globalThis.__webOptimizationRHI.asyncPrecacheCompleted,
    null,{timeout:180000});
  report.state=await owner.evaluate(()=>({rhi:globalThis.__webOptimizationRHI,precache:globalThis.__webPSOPrecache,view:globalThis.__webRenderView,settings:globalThis.__webProjectSettings}));
  report.rejections=report.logs.filter(l=>l.includes('PRECACHE_REJECT')||l.includes('PIPELINE_REJECT'));
  report.failures=report.logs.filter(l=>/Failed to create .*pipeline/.test(l));
  assert.equal(report.state.rhi.asyncPrecacheRequested,report.state.rhi.asyncPrecacheCompleted);
  assert(report.state.rhi.asyncPrecacheRequested>2000&&report.state.rhi.precachedGraphicsPipelines>0,
    'The full Villa startup must actually exercise compute and graphics precaching');
  assert.equal(report.errors.length,0,report.errors.join('\n'));
  if(!runtimeOnly) {
    assert.equal(report.failures.length,0,report.rejections.join('\n'));
    assert.deepEqual(report.rejections,[]);
    assert.equal(report.state.rhi.asyncPrecacheFailed,0);
    assert.equal(report.state.rhi.unsupportedPrecacheRequests,0);
    const atlas=report.logs.find(l=>l.includes('P3_TEXTURE_CREATE name=GlobalDistanceField.PageAtlas '));
    assert(atlas&&/format=13\b/.test(atlas),'The running renderer must allocate the R32F distance-field page atlas');
    const size=/extent=(\d+)x(\d+) depth=(\d+)/.exec(atlas);assert(size);
    report.distanceFieldAtlas={creation:atlas,format:'PF_R32_FLOAT',extent:size.slice(1).map(Number),
      bytes:size.slice(1).map(Number).reduce((n,v)=>n*v,4)};
  }
  report.pass=true;
}catch(e){report.failure=e.stack;console.error(e.stack);process.exitCode=1;}
finally{if(context)await context.close();fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({pass:report.pass,failures:report.failures?.length,rejections:report.rejections?.length,output}));}
})();
