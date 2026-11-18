'use strict';
// The release contract audits backend efficiencies without changing project INIs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const {settings}=require('./web-accepted-defaults.cjs');
const root=path.resolve(__dirname,'../..'),version='web-backend-20261115';
const defaults=Object.freeze(Object.fromEntries(Object.entries(settings).filter(([key])=>/^r\.Web(?:GPU)?\./.test(key))));
const sourceFor=key=>key==='r.WebGPU.RDGMergeRenderPasses'?'reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderGraphPrivate.cpp':
 key==='r.WebGPU.MergeShadowMaskClear'?'reference-engine/Engine/Source/Runtime/Renderer/Private/LightRendering.cpp':
 key==='r.Web.LightGridAllocationBuckets'?'reference-engine/Engine/Source/Runtime/Renderer/Private/LightGridInjection.cpp':
 key.startsWith('r.Web.Occlusion')?'reference-engine/Engine/Source/Runtime/Renderer/Private/SceneOcclusion.cpp':
 key==='r.WebGPU.TSRLargeTiles'?'reference-engine/Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp':
 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/'+(key==='r.WebGPU.ReusePresentEncoder'?'WebGPUViewport.cpp':'WebGPUDynamicRHI.cpp');
function verifyBuildDefaults(build,wasm){
 assert(build.pass&&build.buildSucceeded&&build.threads,'Require a successful threaded build');
 assert(build.products.some(p=>p.sha256===wasm&&p.file.endsWith('.wasm')),'Build does not match package WASM');
 const sources=[];
 for(const relative of new Set(Object.keys(defaults).map(sourceFor))){
  const file=path.join(root,relative),input=build.sourceFiles.find(p=>path.resolve(p.file)===file);
  assert(input&&audit(file).sha256===input.sha256,'Missing or stale optimization source: '+relative);
  const text=fs.readFileSync(file,'utf8');
  for(const [key,value] of Object.entries(defaults).filter(([key])=>sourceFor(key)===relative)){
   const escaped=key.split('.').join('\\.');
   const expression=key==='r.WebGPU.RDGMergeRenderPasses'?
    text.match(/int32 GRDGWebMergeRenderPasses\s*=\s*(\d+)\s*;/)?.[1]:
    text.match(new RegExp('TEXT\\("'+escaped+'"\\),\\s*(PLATFORM_WEB\\s*\\?\\s*\\d+\\s*:\\s*\\d+|\\d+)\\s*,'))?.[1];
   const actual=expression?.match(/\?\s*(\d+)/)?.[1]??expression;
   assert.equal(Number(actual),value,'Backend default was lost: '+key);
  }
  sources.push(input);
  if(relative.startsWith('reference-engine/Engine/Source/')){
   const copied=path.join(root,'.tools/ue58-web-build-host/Engine/Source',relative.split('/Engine/Source/')[1]);
   const audited=build.sourceFiles.find(p=>path.resolve(p.file)===copied);
   assert(audited&&audited.sha256===input.sha256&&audit(copied).sha256===input.sha256,'Compiled overlay lost optimization: '+relative);
   sources.push(audited);
  }
 }
 return {version,wasm,defaults,sources};
}
function installOptimizationContract(folder,build,page){
 const contract=verifyBuildDefaults(build,page.assets.wasm.sha256);
 const configs=JSON.parse(fs.readFileSync(path.join(folder,'config-files.json')));
 const explicitOverrides={};
 for(const item of configs){let section='';for(const line of Buffer.from(item.data,'base64').toString().split(/\r?\n/)){
  const header=line.trim().match(/^\[([^\]]+)\]/);if(header){section=header[1];continue;}
  const setting=line.trim().match(/^([^;#=]+)\s*=\s*(-?[\d.]+)\s*$/);
  if(section==='SystemSettings'&&setting&&setting[1].trim() in defaults)
   explicitOverrides[setting[1].trim()]={value:Number(setting[2]),file:item.path};
 }}
 contract.config= audit(path.join(folder,'config-files.json')).sha256;
 contract.explicitOverrides=explicitOverrides;
 contract.runtime={gameFrameClock:page.assets.gameFrameClock||'owner',inputBridge:page.assets.inputBridge||'owner-forwarded',reuseReplayScratch:page.assets.reuseReplayScratch!==false};
 const name='optimization-contract.json',file=path.join(folder,name);
 fs.writeFileSync(file,JSON.stringify(contract));
 page.assets.optimizationContract={url:name,sha256:audit(file).sha256,version};
 page.assets.versions[name]=page.assets.optimizationContract.sha256;
 return contract;
}
function verifyOptimizationContract(folder,page){
 const metadata=page.assets.optimizationContract;if(!metadata)return null;
 assert.equal(metadata.url,'optimization-contract.json');
 const file=path.join(folder,metadata.url);assert.equal(audit(file).sha256,metadata.sha256,'Optimization manifest changed');
 const contract=JSON.parse(fs.readFileSync(file));
 assert.equal(contract.version,version);assert.deepEqual(contract.defaults,defaults,'Optimization baseline changed; rebuild or audit the release');
 assert.equal(contract.wasm,page.assets.wasm.sha256,'Optimization manifest belongs to another runtime');
 assert.equal(contract.config,audit(path.join(folder,'config-files.json')).sha256,'Project configuration changed after optimization audit');
 assert.deepEqual(contract.runtime,{gameFrameClock:page.assets.gameFrameClock||'owner',inputBridge:page.assets.inputBridge||'owner-forwarded',reuseReplayScratch:page.assets.reuseReplayScratch!==false},'Runtime scheduling/reuse changed after optimization audit');
 return contract;
}
const nativeFields={
 'r.WebGPU.GroupAccessRevalidation':['rhi','groupAccessRevalidation'],
 'r.WebGPU.DynamicGlobalsGroupReuse':['rhi','dynamicGlobalsGroupReuse'],
 'r.WebGPU.BindingPlan':['rhi','bindingPlanEnabled'],
 'r.WebGPU.IndirectDrawReuse':['rhi','indirectDrawReuse'],
 'r.WebGPU.VSMPageOptimization':['rhi','vsmPageOptimization'],
 'r.WebGPU.ReuseComputePass':['rhi','reuseComputePass'],
 'r.Web.OcclusionGroupMotionQueries':['history','groupMotionQueries'],
 'r.Web.OcclusionMotionQueryInterval':['history','motionQueryInterval'],
 'r.WebGPU.StagingReadbackPool':['readback','enabled'],
 'r.WebGPU.StagingUploadPages':['upload','enabled'],
};
function verifyNativeDefaults(contract,state){
 const result={};for(const [key,[group,field]] of Object.entries(nativeFields)){
  const expected=contract.explicitOverrides[key]?.value??contract.defaults[key],actual=state[group]?.[field];
  assert(actual!==undefined,'Missing native optimization readback: '+key);
  assert.equal(Number(actual),expected,'Runtime lost optimization: '+key);result[key]=actual;
 }return result;
}
module.exports={version,defaults,verifyBuildDefaults,installOptimizationContract,verifyOptimizationContract,verifyNativeDefaults};
