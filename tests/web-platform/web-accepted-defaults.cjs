'use strict';
// User accepted the complete villa input/performance candidate on 2026-11-07.
// Apply only to desktop threaded packages, after staging, so source projects and
// archived comparison packages keep their own settings.
// VSM adaptive SMRT sampling was additionally accepted on 2026-11-12.
// The 2026-11-13 manual retest retracted the indirect-reuse regression.
// Keep its accepted default; TSR large tiles remain opt-in pending acceptance.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {assertProjectOutputTree}=require('./project-output.cjs');
const {readPage,writePage,replaceFile}=require('./web-pipeline-prewarm-package.cjs');
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
  'r.Shadow.Virtual.SMRT.AdaptiveRayCount':1,
  'r.WebGPU.IndirectDrawReuse':2,
  'r.WebGPU.VSMPageOptimization':3,
  // Larger tiles improved one pass but did not pass movement smoothness acceptance.
  'r.WebGPU.TSRLargeTiles':0,
});
const runtimeAssets=Object.freeze({performanceProfile:profile,gameFrameClock:'page',pageFrameBudget:3,
  inputBridge:'direct-game-thread',pageFrameMaxFPS:0,localFrameBudget:0,localFrameBudgetMode:'submitted',
  reuseReplayScratch:true});
function applyAcceptedDefaults(folder, {preserveProjectSettings = false} = {}){
  assertProjectOutputTree(folder);
  const page=readPage(folder);
  assert(page.assets.threads&&page.assets.renderer==='desktop');
  Object.assign(page.assets,runtimeAssets);
  delete page.assets.gameFrameBridge;
  page.args=page.args.filter(v=>v!=='-WebPSOPrecacheTest' &&
    !/^-(WebGameLocalClock|WebFrameScheduler=|WebOcclusionMode=|WebRHIWake=)/.test(v));
  writePage(folder,page);
  if(preserveProjectSettings) return profile;

  const configPath=path.join(folder,'config-files.json');
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
  replaceFile(configPath,JSON.stringify(configs));
  return profile;
}
module.exports={profile,settings,runtimeAssets,applyAcceptedDefaults};
