'use strict';
// Preserve historical packages; create an independently versioned candidate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {writeVersions}=require('./asset-versions.cjs');
const {audit,metadata}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const baseline=option('baseline')||'villa-scheduling-pipeline-v74',name=option('output');
assert(name && [baseline,name].every(v=>/^[a-z0-9-]+$/.test(v)));
const source=path.join(__dirname,'build',baseline),dest=path.join(__dirname,'build',name);
const versions=JSON.parse(fs.readFileSync(path.join(source,'asset-versions.json')));
const runtimeBuild=option('runtime-build');
const cores=option('cores');assert(cores===undefined||/^[468]$/.test(cores));
const csmScrollSubjects=option('csm-scroll-subjects');
const csmMode=option('csm-mode');
assert(csmMode===undefined||/^[01]$/.test(csmMode));
assert(csmScrollSubjects===undefined||(/^\d+$/.test(csmScrollSubjects)&&Number(csmScrollSubjects)<=4096));
const motionQueryInterval=option('motion-query-interval');
assert(motionQueryInterval===undefined||(/^[0-8]$/.test(motionQueryInterval)));
const queryBuffering=option('query-buffering');
assert(queryBuffering===undefined||/^[1-4]$/.test(queryBuffering));
const motionGroupHold=option('motion-group-hold');
assert(motionGroupHold===undefined||(/^\d+$/.test(motionGroupHold)&&Number(motionGroupHold)<=200));
assert(!runtimeBuild||!process.argv.includes('--owner-lookahead'),'Runtime replacement and owner lookahead must be tested separately');
let build;
if(runtimeBuild){
  build=JSON.parse(fs.readFileSync(runtimeBuild,'utf8').replace(/^\uFEFF/,''));
  assert(build.pass&&build.threads&&build.buildSucceeded&&build.exitCode===0&&
    (build.fullLinkAttempted||build.fullLinkVerified)&&!build.trace&&!build.simd);
  for(const item of [...build.sourceFiles,...build.products])assert.equal(audit(item.file).sha256,item.sha256);
  for(const object of build.objects)for(const key of ['object','response','definitions','source'])
    assert.equal(audit(object[key].file).sha256,object[key].sha256);
}
for(const [n,v] of Object.entries(versions)){
  assert.equal(path.basename(n),n);assert.equal(audit(path.join(source,n)).sha256,v.sha256,'Source package changed: '+n);
}
assert(!fs.existsSync(dest));fs.mkdirSync(dest);
const changed=new Set(['index.html','config-files.json','asset-versions.json','web-engine-host.js']);
if(build){changed.add('UEWebEngineThreads.js');changed.add('UEWebEngineThreads.wasm');}
const lookahead=process.argv.includes('--owner-lookahead');
const mergeCompute=process.argv.includes('--merge-compute');
const replayScratch=process.argv.includes('--replay-scratch');
const currentWorker=process.argv.includes('--current-worker');
if(lookahead)changed.add('UEWebEngineThreads.js');
if(mergeCompute||replayScratch||currentWorker)changed.add('web-engine-worker.js');
// Copy only audited runtime products. Old comparison pages and launch/readme
// files can describe another clock mode and must not appear in a new candidate.
for(const f of Object.keys(versions))if(!changed.has(f))fs.linkSync(path.join(source,f),path.join(dest,f));
if(build)for(const name of ['UEWebEngineThreads.js','UEWebEngineThreads.wasm'])
  fs.copyFileSync(build.products.find(p=>path.basename(p.file)===name).file,path.join(dest,name));
fs.copyFileSync(path.join(__dirname,'web-engine-host.js'),path.join(dest,'web-engine-host.js'));
const configs=JSON.parse(fs.readFileSync(path.join(source,'config-files.json')));
const config=configs.find(v=>v.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(config);
const settings={'t.MaxFPS':0,'r.VSync':0};
if(process.argv.includes('--csm'))settings['r.Shadow.CSMCaching']=1;
if(csmMode!==undefined)settings['r.Shadow.CSMCaching']=Number(csmMode);
if(csmScrollSubjects!==undefined)settings['r.Shadow.MaxCSMScrollingStaticShadowSubjects']=Number(csmScrollSubjects);
if(motionQueryInterval!==undefined)settings['r.Web.OcclusionMotionQueryInterval']=Number(motionQueryInterval);
if(queryBuffering!==undefined)settings['r.NumBufferedOcclusionQueries']=Number(queryBuffering);
if(process.argv.includes('--no-shadows'))settings['r.ShadowQuality']=0;
if(process.argv.includes('--bundles'))settings['r.WebGPU.RenderBundles']=1;
if(process.argv.includes('--group-motion-queries'))settings['r.Web.OcclusionGroupMotionQueries']=1;
if(process.argv.includes('--group-new-motion-queries'))settings['r.Web.OcclusionGroupNewMotionQueries']=1;
if(motionGroupHold!==undefined)settings['r.Web.OcclusionMotionGroupHoldMs']=Number(motionGroupHold);
if(process.argv.includes('--hzb'))Object.assign(settings,{'r.HZBOcclusion':2,'r.Web.OcclusionGroupMotionQueries':0});
if(process.argv.includes('--light-grid-buckets'))settings['r.Web.LightGridAllocationBuckets']=1;
if(process.argv.includes('--staging-readback-pool'))settings['r.WebGPU.StagingReadbackPool']=1;
if(process.argv.includes('--staging'))settings['r.WebGPU.StagingUploadPages']=1;
if(process.argv.includes('--reuse-compute'))settings['r.WebGPU.ReuseComputePass']=1;
if(process.argv.includes('--merge-raster'))settings['r.WebGPU.RDGMergeRenderPasses']=1;
if(process.argv.includes('--merge-shadow-clear'))settings['r.WebGPU.MergeShadowMaskClear']=1;
if(process.argv.includes('--batch-submissions'))settings['r.WebGPU.BatchSubmissions']=1;
if(process.argv.includes('--reuse-present'))settings['r.WebGPU.ReusePresentEncoder']=1;
if(process.argv.includes('--frame-uniforms'))settings['r.WebGPU.FrameUniformSnapshots']=1;
if(process.argv.includes('--batch-staging'))settings['r.WebGPU.BatchStagingWrites']=1;
if(process.argv.includes('--group-access-uniform'))settings['r.WebGPU.GroupAccessRevalidation']=1;
if(process.argv.includes('--group-access-all'))settings['r.WebGPU.GroupAccessRevalidation']=2;
if(process.argv.includes('--dynamic-globals'))settings['r.WebGPU.DynamicGlobalsGroupReuse']=1;
if(process.argv.includes('--binding-plan'))settings['r.WebGPU.BindingPlan']=1;
if(process.argv.includes('--tlv-share'))settings['r.WebGPU.TLVShareCascades']=1;
let ini=Buffer.from(config.data,'base64').toString();
ini+='\n[SystemSettings]\n'+Object.entries(settings).map(([k,v])=>k+'='+v).join('\n')+'\n';
config.data=Buffer.from(ini).toString('base64');config.sha256=crypto.createHash('sha256').update(ini).digest('hex');
fs.writeFileSync(path.join(dest,'config-files.json'),JSON.stringify(configs));
let html=fs.readFileSync(path.join(source,'index.html'),'utf8');
if(cores){
  const args=html.match(/arguments: (\[[^\n]+\]),/);assert(args);
  const values=JSON.parse(args[1]).filter(v=>!v.startsWith('-corelimit='));values.push('-corelimit='+cores);
  html=html.replace(args[0],'arguments: '+JSON.stringify(values)+',');
}
const match=html.match(/const localRuntimeAssets = (\{[^\n]+\});/);assert(match);
const assets=JSON.parse(match[1]);assets.localFrameBudget=0;assets.localFrameBudgetMode='submitted';
if(build){
  for(const name of ['UEWebEngineThreads.js','UEWebEngineThreads.wasm'])assets.versions[name]=audit(path.join(dest,name)).sha256;
  assets.wasm=metadata(path.join(dest,'UEWebEngineThreads.wasm'),'UEWebEngineThreads.wasm');
}
if(mergeCompute||replayScratch||currentWorker){
  const worker=(replayScratch?'globalThis.__webReuseReplayScratch=true;\n':'')+
    (mergeCompute?'('+require('./web-compute-pass-merge.cjs').toString()+')();\n':'')+
    fs.readFileSync(path.join(currentWorker?__dirname:source,'web-engine-worker.js'),'utf8');
  fs.writeFileSync(path.join(dest,'web-engine-worker.js'),worker);
  assets.versions['web-engine-worker.js']=crypto.createHash('sha256').update(worker).digest('hex');
}
if(lookahead){
  let runtime=fs.readFileSync(path.join(source,'UEWebEngineThreads.js'),'utf8');
  const marker='var findCanvasEventTarget =';assert.equal(runtime.split(marker).length,2);
  runtime=runtime.replace(marker,`const parityOriginalBridge = WebThreadBridge;\nWebThreadBridge = () => {parityOriginalBridge();if(ENVIRONMENT_IS_PTHREAD)(${require('./web-owner-lookahead.cjs').toString()})(globalThis, MainLoop.preMainLoop);};\n`+marker);
  fs.writeFileSync(path.join(dest,'UEWebEngineThreads.js'),runtime);
  assets.versions['UEWebEngineThreads.js']=crypto.createHash('sha256').update(runtime).digest('hex');
}
assets.versions['web-engine-host.js']=crypto.createHash('sha256').update(fs.readFileSync(path.join(dest,'web-engine-host.js'))).digest('hex');
html=html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';');
fs.writeFileSync(path.join(dest,'index.html'),html);
const products=Object.keys(versions).map(n=>audit(path.join(dest,n)));
writeVersions(dest,products);
fs.writeFileSync(path.join(__dirname,'results',name+'-package.json'),JSON.stringify({baseline,name,settings,cores,clock:'owner',lookahead,mergeCompute,replayScratch,currentWorker,experimental:true,
  performanceAccepted:false,runtimeBuild:runtimeBuild?audit(runtimeBuild):null,source:audit(__filename),baselineManifest:audit(path.join(source,'asset-versions.json')),
  candidateManifest:audit(path.join(dest,'asset-versions.json'))},null,2));
console.log(dest);
