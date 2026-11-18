'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'evidence/nanite-primitive-visibility-20261111');
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
   if(!t.blocked)assert(t.history.slice(-8).every(x=>x.candidate));
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
 const f=path.join(__dirname,`results/cpu-nanite-primitive-final-${mode}-20261111.json`),r=read(f);
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
for(const n of ['Engine/Private/Nanite/NaniteWebScene.cpp','Engine/Public/Rendering/NaniteWebScene.h','Renderer/Private/DeferredShadingRenderer.cpp'])
 sources.push(path.join(root,'reference-engine/Engine/Source/Runtime',n));sources.forEach(archive);
for(const n of ['primitive-visibility-build-console.log','primitive-visibility-runtime-import.log','primitive-recovery-build-console.log',
 'primitive-recovery-runtime-import.log','primitive-recovery-static-build-console.log','primitive-recovery-static-runtime-import.log',
 'primitive-recovery-final-build-console.log','primitive-recovery-final-runtime-import.log',
 'primitive-recovery-conservative-query-failure.json','primitive-recovery-conservative-query-probe.cjs',
 'primitive-recovery-startup-failure.json','primitive-recovery-startup-probe.cjs','primitive-recovery-frozen-clock-failure.json',
 'primitive-recovery-frozen-clock-probe.cjs','primitive-recovery-movable-target-failure.json','primitive-recovery-movable-target-probe.cjs',
 'primitive-recovery-movable-target.cpp','primitive-recovery-movable-build.json','primitive-recovery-movable-package.json',
 'primitive-recovery-cleanup-failure.json','primitive-recovery-cleanup.cpp','primitive-recovery-cleanup-build.json','primitive-recovery-cleanup-package.json'])archive(path.join(__dirname,'results/nanite-core',n));
for(const n of fs.readdirSync(path.join(__dirname,'results/nanite-core/visibility-first-build')))archive(path.join(__dirname,'results/nanite-core/visibility-first-build',n));
const report={pass:true,date:new Date().toISOString(),packages,build:build.fullEngineBuild,runs,comparisons,profiles,sources:sources.map(audit),artifacts,
 boundary:'Use completed current renderer primitive visibility only for ordinary rigid proxies, with a runtime baseline switch. Camera cuts, moved/hidden occluders and proxy recreation require bounded visibility recovery and unchanged final depth/materials. This evidence does not independently complete native visual comparison, full streaming/device recovery or all Nanite delivery requirements.'};
const output=path.join(__dirname,'evidence/nanite-primitive-visibility-20261111.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log({pass:true,file:output,cases:runs.reduce((s,x)=>s+x.cases,0),frames:runs.reduce((s,x)=>s+x.frames,0),artifacts:artifacts.length});
