'use strict';
// User accepted the complete villa input/performance candidate on 2026-11-07.
// Apply only to desktop threaded packages, after staging, so source projects and
// archived comparison packages keep their own settings.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const profile='desktop-accepted-20261107';
const settings=Object.freeze({
  't.MaxFPS':0,'r.VSync':0,'r.MotionBlurQuality':0,
  'r.Shadow.CSMCaching':1,'r.WebGPU.ReuseComputePass':1,
  'r.WebGPU.StagingUploadPages':1,'r.WebGPU.RDGMergeRenderPasses':1,
  'r.WebGPU.BatchSubmissions':1,'r.WebGPU.ReusePresentEncoder':1,
  'r.WebGPU.FrameUniformSnapshots':1,'r.WebGPU.MergeShadowMaskClear':1,
  'r.Web.OcclusionMotionQueryInterval':0,'r.Web.OcclusionGroupMotionQueries':1,
  'r.Web.LightGridAllocationBuckets':1,'r.WebGPU.StagingReadbackPool':1,
  'r.WebGPU.GroupAccessRevalidation':2,'r.WebGPU.DynamicGlobalsGroupReuse':1,'r.WebGPU.BindingPlan':1,
});
const runtimeAssets=Object.freeze({performanceProfile:profile,gameFrameClock:'page',pageFrameBudget:3,
  inputBridge:'direct-game-thread',pageFrameMaxFPS:0,localFrameBudget:0,localFrameBudgetMode:'submitted',
  reuseReplayScratch:true});
function applyAcceptedDefaults(folder){
  const htmlPath=path.join(folder,'index.html'),configPath=path.join(folder,'config-files.json');
  let html=fs.readFileSync(htmlPath,'utf8');
  const match=html.match(/const localRuntimeAssets = (\{[^\n]+\});/);assert(match);
  const assets=JSON.parse(match[1]);assert(assets.threads&&assets.renderer==='desktop');
  Object.assign(assets,runtimeAssets);
  delete assets.gameFrameBridge;
  html=html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';');
  const args=html.match(/arguments: (\[[^\n]+\]),/);assert(args);
  assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(args[1]));
  const values=[...args[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(m=>m[1])
    .filter(v=>!/^-(WebGameLocalClock|WebFrameScheduler=|WebOcclusionMode=|WebRHIWake=)/.test(v));
  html=html.replace(args[0],'arguments: '+JSON.stringify(values.filter(v=>v!=='-WebPSOPrecacheTest'))+',');
  const configs=JSON.parse(fs.readFileSync(configPath));
  function append(file,text){
    let item=configs.find(c=>c.path===file);
    if(!item){item={path:file,data:''};configs.push(item);}
    const value=Buffer.from(item.data,'base64').toString()+text;
    item.data=Buffer.from(value).toString('base64');
    item.sha256=crypto.createHash('sha256').update(value).digest('hex');
  }
  append('/Engine/Platforms/Web/Config/WebEngine.ini','\n[SystemSettings]\n'+
    Object.entries(settings).map(([k,v])=>k+'='+v).join('\n')+'\n');
  append('/Engine/Programs/UEWebEngine/Config/DefaultInput.ini',
    '\n[/Script/Engine.InputSettings]\nbEnableMouseSmoothing=False\n');
  fs.writeFileSync(htmlPath,html);
  fs.writeFileSync(configPath,JSON.stringify(configs));
  return profile;
}
module.exports={profile,settings,runtimeAssets,applyAcceptedDefaults};
