'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=v=>assert.equal(audit(v.file).sha256,v.sha256,v.file);
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'evidence/nanite-raster-batch-20261111');
fs.mkdirSync(output,{recursive:true});
const artifacts=[],archived=new Map();
function archive(file){
 file=path.resolve(file);if(archived.has(file))return archived.get(file);
 const bytes=fs.readFileSync(file),compressed=zlib.gzipSync(bytes,{level:9});assert(zlib.gunzipSync(compressed).equals(bytes));
 const target=path.join(output,`${artifacts.length}-${path.basename(file)}.gz`);fs.writeFileSync(target,compressed);
 const item={original:audit(file),archive:audit(target),encoding:'gzip'};artifacts.push(item);archived.set(file,item);return item;
}
const packages={};
for(const name of ['nanite-core-scene','nanite-core-default']){
 const file=path.join(__dirname,'build',name,'package.json'),pkg=read(file);assert(pkg.pass);
 [...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.archive,pkg.streamingShaders,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory,...(pkg.sceneConversion?[pkg.sceneConversion]:[])].forEach(verify);
 validateCook(read(pkg.sceneCook.cook.file),false,{});
 packages[name]={package:audit(file),runtime:pkg.build};archive(file);
 for(const item of [pkg.build,pkg.native,pkg.streamingShaders,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory,...(pkg.sceneConversion?[pkg.sceneConversion]:[])])archive(item.file);
}
assert.equal(packages['nanite-core-scene'].runtime.sha256,packages['nanite-core-default'].runtime.sha256);
const build=read(packages['nanite-core-scene'].runtime.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
archive(build.fullEngineBuild.file);archive(full.log.file);archive(full.linkResponse.file);
const runs=[],comparisons=[];
for(const scalar of [false,true]){
 const mode=scalar?'scalar':'packed';
 for(const [suite,name,pkg,steps] of [['villa','nanite-raster-batch','nanite-core-scene',9],['default','nanite-automatic-scene','nanite-core-default',8]]){
  const file=path.join(__dirname,'results',name,mode+'.json'),r=read(file);
  assert(r.pass);assert.equal(r.scalar,scalar);assert.equal(r.tests.length,steps);verify(r.source);verify(r.package);
  assert.equal(r.package.sha256,packages[pkg].package.sha256);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
  assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  for(const t of r.tests){assert(t.validation);assert.equal(t.rejected,0);if(t.image){verify(t.image);archive(t.image.file);}}
  if(suite==='villa')for(const step of [5,7,9]){
   const before=r.tests[step-2],after=r.tests[step-1];assert(!before.rasterBatch&&after.rasterBatch);
   assert.deepEqual(before.cullStates,after.cullStates);assert.deepEqual(before.entryInstanceIDs,after.entryInstanceIDs);
   assert.equal(before.entries,after.entries);assert.equal(before.materialDraws,after.materialDraws);
   assert(after.rasterComparison.compared>1000);assert.equal(after.rasterComparison.maxDepthDifference,0);
   assert(after.rasterComparison.maxSpecularDifference<=1/255+1e-7);
   assert(after.callsPerFrame.beginRenderPass<before.callsPerFrame.beginRenderPass*.6);
   comparisons.push({scalar,step,entries:after.entries,comparison:after.rasterComparison,
    before:{performance:before.performance,calls:before.callsPerFrame},after:{performance:after.performance,calls:after.callsPerFrame}});
  }
  archive(file);runs.push({suite,scalar,steps,frames:r.frames,report:audit(file)});
 }
}
const profiles=[];
for(const tag of ['nanite-raster-batch-0-20261111','nanite-raster-batch-1-20261111','nanite-core-fallback-20261111']){
 const file=path.join(__dirname,'results','cpu-'+tag+'.json'),r=read(file);assert(r.pass);verify(r.source);verify(r.package);
 assert.equal(r.package.sha256,packages['nanite-core-scene'].package.sha256);assert.deepEqual(r.errors,[]);assert.equal(r.samples.length,2);
 assert(!r.visualClock?.renderTimeFrozen&&!r.visualClock?.materialTimeFrozen);
 assert.equal(r.nanite.enabled,!tag.includes('fallback'));
 if(!tag.includes('fallback'))assert.equal(r.nanite.rasterBatch,tag.includes('batch-1'));
 archive(file);archive(file.replace(/\.json$/,'.log'));
 for(let i=0;i<2;i++){archive(file.replace(/\.json$/,`-${i}.cpuprofile`));archive(file.replace(/\.json$/,`-${i}.png`));}
 profiles.push({tag,report:audit(file),samples:r.samples.map(s=>({baseline:s.baseline,sampledFPS:s.fps,calls:s.callsPerFrame,
  rhiMsPerFrame:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))});
}
for(let i=0;i<2;i++)assert(profiles[1].samples[i].baseline.fps>profiles[0].samples[i].baseline.fps);
const sources=[__filename,'package-web-nanite-scene.cjs','probe-nanite-full-scene.cjs','probe-nanite-automatic-scene.cjs','profile-web-cpu.cjs',
 'prepare-web-cook-shaders.cjs','web-nanite-curve-shader-overrides.cjs','overlays/nanite-curves-shaders.json','web-engine-worker.js',
 '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp'].map(f=>path.resolve(__dirname,f));
for(const name of ['Engine/Private/Nanite/NaniteWebRaster.cpp','Engine/Public/Rendering/NaniteWebRaster.h','Renderer/Private/Nanite/NaniteWebProgrammableRaster.cpp'])
 sources.push(path.join(root,'reference-engine/Engine/Source/Runtime',name));
sources.forEach(archive);
for(const name of ['full-build-single-console.log','package-console.log','villa-conversion-verification.log','villa-conversion-recheck.log',
 'conversion-original-verified.json','conversion-original-descriptor-failure.json','lumen-off-descriptor-before.json','lumen-off-descriptor-restored.json','villa-recheck.json','villa-recheck.log'])
 archive(path.join(__dirname,'results/nanite-core',name));
const report={pass:true,date:new Date().toISOString(),packages,build:build.fullEngineBuild,runs,comparisons,profiles,sources:sources.map(audit),artifacts,
 boundary:'Explicit batches of up to 32 fixed and programmable Nanite raster draws preserve per-draw RDG resources and depth-to-ID phase dependencies. Six Villa A/B view pairs have bit-identical depths and preserved materials, plus both default-scene lifecycle suites. Actual advancing-clock game profiles improve, but Villa performance remains below the ordinary mesh path. Native temporal comparisons and complete Nanite delivery remain open.'};
const file=path.join(__dirname,'evidence/nanite-raster-batch-20261111.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log({pass:true,file,frames:runs.reduce((s,r)=>s+r.frames,0),cases:runs.reduce((s,r)=>s+r.steps,0),artifacts:artifacts.length});
