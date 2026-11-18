'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=v=>assert.equal(audit(v.file).sha256,v.sha256,v.file);
const root=path.resolve(__dirname,'../..'),output=path.join(__dirname,'evidence/nanite-material-pass-20261111');
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
 for(const [suite,name,pkg,steps] of [['villa','nanite-material-pass','nanite-core-scene',9],['default','nanite-automatic-scene','nanite-core-default',8]]){
  const file=path.join(__dirname,'results',name,mode+'.json'),r=read(file);
  assert(r.pass);assert.equal(r.scalar,scalar);assert.equal(r.tests.length,steps);verify(r.source);verify(r.package);
  assert.equal(r.package.sha256,packages[pkg].package.sha256);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
  assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  for(const t of r.tests){assert(t.validation);assert.equal(t.rejected,0);if(t.image){verify(t.image);archive(t.image.file);}}
  if(suite==='villa')for(const step of [5,7,9]){
   const before=r.tests[step-2],after=r.tests[step-1];assert(!before.materialPassBatch&&after.materialPassBatch);
   assert.deepEqual(before.cullStates,after.cullStates);assert.deepEqual(before.entryInstanceIDs,after.entryInstanceIDs);
   assert.equal(before.entries,after.entries);assert.equal(before.materialDraws,after.materialDraws);
   assert(after.materialPassComparison.compared>1000);assert.equal(after.materialPassComparison.maxDepthDifference,0);
   assert(after.materialPassComparison.maxSpecularDifference<=1/255+1e-7);
   assert(after.callsPerFrame.beginRenderPass<before.callsPerFrame.beginRenderPass*.8);
   comparisons.push({scalar,step,entries:after.entries,comparison:after.materialPassComparison,
    before:{performance:before.performance,calls:before.callsPerFrame},after:{performance:after.performance,calls:after.callsPerFrame}});
  }
  archive(file);runs.push({suite,scalar,steps,frames:r.frames,report:audit(file)});
 }
}
const profiles=[];
for(const tag of ['nanite-material-final-0-20261111','nanite-material-final-16-20261111']){
 const file=path.join(__dirname,'results','cpu-'+tag+'.json'),r=read(file);assert(r.pass);verify(r.source);verify(r.package);
 assert.equal(r.package.sha256,packages['nanite-core-scene'].package.sha256);assert.deepEqual(r.errors,[]);assert.equal(r.samples.length,2);
 assert(!r.visualClock?.renderTimeFrozen&&!r.visualClock?.materialTimeFrozen);
 assert.equal(r.nanite.enabled,!tag.includes('fallback'));
 assert.equal(r.nanite.materialPassBatch,tag.includes('final-16'));assert.equal(r.nanite.materialPassBatchMode,tag.includes('final-16')?16:0);
 archive(file);archive(file.replace(/\.json$/,'.log'));
 for(let i=0;i<2;i++){archive(file.replace(/\.json$/,`-${i}.cpuprofile`));archive(file.replace(/\.json$/,`-${i}.png`));}
 profiles.push({tag,report:audit(file),samples:r.samples.map(s=>({baseline:s.baseline,sampledFPS:s.fps,calls:s.callsPerFrame,
  rhiMsPerFrame:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))});
}
for(let i=0;i<2;i++)assert(profiles[1].samples[i].baseline.fps>profiles[0].samples[i].baseline.fps);
const sources=[__filename,'package-web-nanite-scene.cjs','probe-nanite-full-scene.cjs','probe-nanite-automatic-scene.cjs','profile-web-cpu.cjs',
 'profile-web-gpu.cjs','web-engine-worker.js',
 '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp'].map(f=>path.resolve(__dirname,f));
for(const name of ['Renderer/Private/Nanite/NaniteWebMaterialPass.cpp'])
 sources.push(path.join(root,'reference-engine/Engine/Source/Runtime',name));
sources.forEach(archive);
for(const name of ['material-explicit-build-console.log','material-explicit-repair-build-console.log','restored-original-buffer-pool.json',
 'material-interleaved-candidate.cpp','material-interleaved-package.json','material-interleaved-build.json','material-interleaved-full-build.json',
 'material-explicit32-candidate.cpp','material-explicit32-package.json','material-explicit32-build.json','material-explicit32-full-build.json',
 'material-sizes-candidate.cpp','material-sizes-package.json','material-sizes-build.json','material-sizes-full-build.json',
 'material-batch-build-console.log','material-explicit-runtime-import.log','material-final-build-console.log','material-final-runtime-import.log']) archive(path.join(__dirname,'results/nanite-core',name));
for(const enabled of [0,1]){
 const file=path.join(__dirname,'results',`cpu-nanite-material-pass-${enabled}-20261111.json`),run=read(file);
 assert(run.pass);archive(file);archive(file.replace(/\.json$/,'.log'));
 for(let i=0;i<2;i++)archive(file.replace(/\.json$/,`-${i}.cpuprofile`));
}
const gpuFile=path.join(__dirname,'results/gpu-nanite-material-pass-20261111.json'),gpu=read(gpuFile);
const gpuSource=path.join(__dirname,'results/nanite-core/profile-web-gpu-original.cjs');
assert(gpu.pass);assert.equal(audit(gpuSource).sha256,gpu.source.sha256);assert.deepEqual(gpu.errors,[]);assert.equal(gpu.frames.length,16);archive(gpuFile);archive(gpuSource);
const finalGPUFile=path.join(__dirname,'results/gpu-nanite-material-final-20261111.json'),finalGPU=read(finalGPUFile);
assert(finalGPU.pass);verify(finalGPU.source);verify(finalGPU.package);assert.equal(finalGPU.package.sha256,packages['nanite-core-scene'].package.sha256);
assert.deepEqual(finalGPU.errors,[]);assert.equal(finalGPU.frames.length,16);assert(finalGPU.meanSpanMs>0);archive(finalGPUFile);
const sizes=[];
for(const size of [0,2,4,8,16]){
 const file=path.join(__dirname,`results/cpu-nanite-material-size-${size}-20261111.json`),run=read(file);assert(run.pass);verify(run.source);
 assert.equal(run.nanite.materialPassBatchMode,size);assert.deepEqual(run.errors,[]);archive(file);archive(file.replace(/\.json$/,'.log'));
 for(let i=0;i<2;i++)archive(file.replace(/\.json$/,`-${i}.cpuprofile`));
 sizes.push({size,report:audit(file),fps:run.samples.map(s=>s.baseline.fps)});
}

const report={pass:true,date:new Date().toISOString(),packages,build:build.fullEngineBuild,runs,comparisons,profiles,sizes,sources:sources.map(audit),artifacts,
 boundary:"Explicit batches default to 16 Nanite material draws (maximum 32), preserving per-draw resources, shared static uniform bindings, draw order and matching target layouts. Six Villa A/B view pairs plus both default-scene lifecycle suites must pass. Actual advancing-clock game performance improves modestly. GPU timestamps are diagnostic and not acceptance FPS. The earlier pass-reordering candidate did not reduce render-pass count and is retained separately. Full Nanite delivery and remaining scene performance work remain open."};
const file=path.join(__dirname,'evidence/nanite-material-pass-20261111.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log({pass:true,file,frames:runs.reduce((s,r)=>s+r.frames,0),cases:runs.reduce((s,r)=>s+r.steps,0),artifacts:artifacts.length});
