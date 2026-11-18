'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'evidence/nanite-disocclusion-20261111');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=m=>assert.equal(audit(m.file).sha256,m.sha256,m.file);
fs.mkdirSync(dir,{recursive:true});const artifacts=[],seen=new Map();
function archive(f){f=path.resolve(f);if(seen.has(f))return seen.get(f);const bytes=fs.readFileSync(f),gz=zlib.gzipSync(bytes,{level:9});assert(zlib.gunzipSync(gz).equals(bytes));
 const target=path.join(dir,artifacts.length+'-'+path.basename(f)+'.gz');fs.writeFileSync(target,gz);
 const a={original:audit(f),archive:audit(target),encoding:'gzip'};artifacts.push(a);seen.set(f,a);return a;}
const packages={};
for(const n of ['nanite-core-scene','nanite-core-default']){
 const f=path.join(__dirname,'build',n,'package.json'),p=read(f);assert(p.pass);
 [...p.sources,...p.products,p.build,p.native,p.archive,p.streamingShaders,p.sceneCook.stage,p.sceneCook.cook,p.sceneCook.inventory,...(p.sceneConversion?[p.sceneConversion]:[])].forEach(verify);
 validateCook(read(p.sceneCook.cook.file),false,{});packages[n]={package:audit(f),runtime:p.build};archive(f);
 for(const a of [p.build,p.native,p.streamingShaders,p.sceneCook.stage,p.sceneCook.cook,p.sceneCook.inventory,...(p.sceneConversion?[p.sceneConversion]:[])])archive(a.file);
}
assert.equal(packages['nanite-core-scene'].runtime.sha256,packages['nanite-core-default'].runtime.sha256);
const build=read(packages['nanite-core-scene'].runtime.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
for(const a of [build.fullEngineBuild,full.log,full.linkResponse])archive(a.file);
const runs=[],comparisons=[];
for(const scalar of [false,true])for(const [suite,name,pkg,count] of [
 ['villa','nanite-primitive-visibility','nanite-core-scene',9],['default','nanite-automatic-scene','nanite-core-default',8],
 ['recovery','nanite-primitive-recovery','nanite-core-default',8]]){
 const f=path.join(__dirname,'results',name,(scalar?'scalar':'packed')+'.json'),r=read(f);
 assert(r.pass);assert.equal(r.scalar,scalar);assert.equal(r.tests.length,count);verify(r.source);verify(r.package);
 assert.equal(r.package.sha256,packages[pkg].package.sha256);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
 assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
 if(suite!=='default')assert(r.visualClock.materialTimeFrozen&&!r.visualClock.renderTimeFrozen);
 for(const t of r.tests){if(t.image){verify(t.image);archive(t.image.file);}
  if(suite==='recovery'){
   assert.equal(t.history.length,16);assert.equal(t.before.entries,2);assert.equal(t.after.entries,t.blocked?1:2);assert(t.covered>20);
   for(const h of t.history){assert.equal(typeof h.targetPresent,'boolean');assert.equal(typeof h.occluderBlocking,'boolean');if(h.targetPresent&&!h.occluderBlocking)assert(h.candidate,'Same-frame disocclusion');}
   if([6,8].includes(t.action))assert(t.history.some(x=>x.cameraCut&&x.candidate));
  }else{assert(t.validation);assert.equal(t.rejected,0);}
 }
 if(suite==='villa')for(const step of [5,7,9]){
  const before=r.tests[step-2],after=r.tests[step-1];assert(!before.primitiveVisibility&&after.primitiveVisibility);
  assert(after.entries<before.entries);assert(after.primitiveVisibilitySkipped>0);assert(after.primitiveComparison.compared>1000);
  assert.equal(after.primitiveComparison.maxDepthDifference,0);assert(after.primitiveComparison.maxSpecularDifference<=1/255+1e-7);
  comparisons.push({scalar,step,before:before.entries,after:after.entries,comparison:after.primitiveComparison});
 }
 archive(f);runs.push({suite,scalar,cases:count,frames:r.frames,report:audit(f)});
}
const profiles=[];
for(const mode of [0,1]){
 const f=path.join(__dirname,`results/cpu-nanite-disocclusion-final-${mode}-20261111.json`),r=read(f);
 assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,packages['nanite-core-scene'].package.sha256);
 assert.equal(r.nanite.primitiveVisibility,!!mode);assert.deepEqual(r.errors,[]);assert.equal(r.samples.length,2);
 assert(!r.visualClock?.renderTimeFrozen&&!r.visualClock?.materialTimeFrozen);
 archive(f);archive(f.replace(/\.json$/,'.log'));
 for(let i=0;i<2;i++){archive(f.replace(/\.json$/,`-${i}.cpuprofile`));archive(f.replace(/\.json$/,`-${i}.png`));}
 profiles.push({mode,report:audit(f),samples:r.samples.map(s=>({fps:s.baseline.fps,calls:s.callsPerFrame,
  rhiMs:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))});
}
for(let i=0;i<2;i++)assert(profiles[1].samples[i].fps>profiles[0].samples[i].fps*1.5);
const sources=[__filename,'probe-nanite-full-scene.cjs','probe-nanite-primitive-recovery.cjs','probe-nanite-automatic-scene.cjs',
 'profile-web-cpu.cjs','web-engine-worker.js','package-web-nanite-scene.cjs','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp'].map(f=>path.resolve(__dirname,f));
for(const n of ['Engine/Private/Nanite/NaniteWebScene.cpp','Engine/Public/Rendering/NaniteWebScene.h','Renderer/Private/DeferredShadingRenderer.cpp','Renderer/Private/RendererScene.cpp','Renderer/Private/SceneOcclusion.cpp','Renderer/Private/WebOcclusionHistory.h','Renderer/Private/WebOcclusionBounds.h'])
 sources.push(path.join(root,'reference-engine/Engine/Source/Runtime',n));sources.forEach(archive);
for(const n of fs.readdirSync(path.join(__dirname,'results/nanite-core/disocclusion-before-fix')))archive(path.join(__dirname,'results/nanite-core/disocclusion-before-fix',n));
for(const n of fs.readdirSync(path.join(__dirname,'results/nanite-core/disocclusion-broad-invalidation')))archive(path.join(__dirname,'results/nanite-core/disocclusion-broad-invalidation',n));
const contractFile=path.join(__dirname,'results/nanite-disocclusion-contract/verified.json'),contract=read(contractFile);
assert(contract.pass&&contract.runs.length===2);for(const r of contract.runs){assert(r.pass&&r.cases===200007&&r.constructed===100000&&r.excluded>50000);}
for(const a of contract.sources){verify(a);archive(a.file);}archive(contractFile);
archive(path.join(__dirname,'build-web-engine.ps1'));
archive(path.join(__dirname,'prepare-web-core-host.ps1'));
const report={pass:true,date:new Date().toISOString(),packages,build:build.fullEngineBuild,runs,comparisons,profiles,sources:sources.map(audit),artifacts,
 boundary:'Changed occluder bounds invalidate overlapping previous primitive queries, including pending results, in ordinary Web Nanite scenes. The bounded change log restores visibility on overflow; orthographic and GPU compute changes stay conservative. Actual render-thread occluder state requires the target to be a candidate on every unoccluded frame. Stable scene depth and materials remain unchanged and real-time performance is measured. Native comparison and full-scene streaming/device recovery are separate final checks.'};
const output=path.join(__dirname,'evidence/nanite-disocclusion-20261111.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log({pass:true,file:output,cases:runs.reduce((s,x)=>s+x.cases,0),frames:runs.reduce((s,x)=>s+x.frames,0),artifacts:artifacts.length});
