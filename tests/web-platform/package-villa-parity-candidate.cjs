'use strict';
// Preserve historical packages; create an independently versioned candidate.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {writeVersions}=require('./asset-versions.cjs');
const {audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const baseline=option('baseline')||'villa-scheduling-pipeline-v74',name=option('output');
assert(name && [baseline,name].every(v=>/^[a-z0-9-]+$/.test(v)));
const source=path.join(__dirname,'build',baseline),dest=path.join(__dirname,'build',name);
const versions=JSON.parse(fs.readFileSync(path.join(source,'asset-versions.json')));
for(const [n,v] of Object.entries(versions)){
  assert.equal(path.basename(n),n);assert.equal(audit(path.join(source,n)).sha256,v.sha256,'Source package changed: '+n);
}
assert(!fs.existsSync(dest));fs.mkdirSync(dest);
const changed=new Set(['index.html','config-files.json','asset-versions.json','web-engine-host.js']);
const lookahead=process.argv.includes('--owner-lookahead');
const mergeCompute=process.argv.includes('--merge-compute');
if(lookahead)changed.add('UEWebEngineThreads.js');
if(mergeCompute)changed.add('web-engine-worker.js');
// Copy only audited runtime products. Old comparison pages and launch/readme
// files can describe another clock mode and must not appear in a new candidate.
for(const f of Object.keys(versions))if(!changed.has(f))fs.linkSync(path.join(source,f),path.join(dest,f));
fs.copyFileSync(path.join(__dirname,'web-engine-host.js'),path.join(dest,'web-engine-host.js'));
const configs=JSON.parse(fs.readFileSync(path.join(source,'config-files.json')));
const config=configs.find(v=>v.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(config);
const settings={'t.MaxFPS':0,'r.VSync':0};
if(process.argv.includes('--csm'))settings['r.Shadow.CSMCaching']=1;
if(process.argv.includes('--no-shadows'))settings['r.ShadowQuality']=0;
if(process.argv.includes('--bundles'))settings['r.WebGPU.RenderBundles']=1;
if(process.argv.includes('--staging'))settings['r.WebGPU.StagingUploadPages']=1;
if(process.argv.includes('--binding-plan'))settings['r.WebGPU.BindingPlan']=1;
if(process.argv.includes('--tlv-share'))settings['r.WebGPU.TLVShareCascades']=1;
let ini=Buffer.from(config.data,'base64').toString();
ini+='\n[SystemSettings]\n'+Object.entries(settings).map(([k,v])=>k+'='+v).join('\n')+'\n';
config.data=Buffer.from(ini).toString('base64');config.sha256=crypto.createHash('sha256').update(ini).digest('hex');
fs.writeFileSync(path.join(dest,'config-files.json'),JSON.stringify(configs));
let html=fs.readFileSync(path.join(source,'index.html'),'utf8');
const match=html.match(/const localRuntimeAssets = (\{[^\n]+\});/);assert(match);
const assets=JSON.parse(match[1]);assets.localFrameBudget=0;assets.localFrameBudgetMode='submitted';
if(mergeCompute){
  const worker='('+require('./web-compute-pass-merge.cjs').toString()+')();\n'+fs.readFileSync(path.join(source,'web-engine-worker.js'),'utf8');
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
fs.writeFileSync(path.join(__dirname,'results',name+'-package.json'),JSON.stringify({baseline,name,settings,clock:'owner',lookahead,mergeCompute,experimental:true,
  performanceAccepted:false,source:audit(__filename),baselineManifest:audit(path.join(source,'asset-versions.json')),
  candidateManifest:audit(path.join(dest,'asset-versions.json'))},null,2));
console.log(dest);
