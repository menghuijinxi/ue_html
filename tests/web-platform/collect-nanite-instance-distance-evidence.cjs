'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const pkgFile=path.join(__dirname,'build/nanite-default-scene/package.json'),pkg=read(pkgFile);assert(pkg.pass&&pkg.defaultScene);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
for(const suffix of ['WebNaniteInstanceDistanceTest.cpp','InstancedStaticMesh.cpp','NaniteWebScene.cpp'])assert(full.sourceFiles.some(i=>i.file.endsWith(suffix)));
const cook=read(pkg.sceneCook.cook.file);assert(cook.pass&&cook.naniteCookData);cook.sourceFiles.forEach(verify);verify(cook.defaultSamples);verify(cook.templateMap);
const runs=['packed','scalar'].map(mode=>read(path.join(__dirname,'results/nanite-instance-distance',mode+'.json')));
const automatic=['packed','scalar'].map(mode=>read(path.join(__dirname,'results/nanite-automatic-scene',mode+'.json')));
for(const [index,r] of runs.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(pkgFile).sha256);assert.equal(r.scalar,index===1);
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);assert.equal(r.tests.length,17);
  assert.equal(r.rhi.asyncPrecacheFailed||0,0);assert.equal(r.rhi.asyncPrecacheCompleted,r.rhi.asyncPrecacheRequested);
  for(const t of r.tests)assert(t.validation&&t.rejected===0);
}
for(const r of automatic){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(pkgFile).sha256);assert.deepEqual(r.gpu.errors,[]);
  assert.equal(r.tests.length,8);for(const t of r.tests){verify(t.image);assert.equal(t.rhi.asyncPrecacheFailed||0,0);}
}
const failureFile=path.join(__dirname,'results/web-cook-host-20261110-062151.log'),failure=read(failureFile);
assert(!failure.pass&&failure.failure.includes('ENOENT')&&failure.failure.includes('H:'));
const payload={runs,automatic,hostFailure:failure},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const nativeSources=['Engine/Shaders/Private/Nanite/NaniteCullingCommon.ush','Engine/Source/Runtime/Engine/Private/PrimitiveUniformShaderParameters.cpp',
  'Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp'].map(f=>audit(path.join(__dirname,'../../reference-engine',f)));
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(pkgFile),build:build.fullEngineBuild,cook:pkg.sceneCook.cook,nativeSources,
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,pipelines:{requested:r.rhi.asyncPrecacheRequested,completed:r.rhi.asyncPrecacheCompleted,failed:r.rhi.asyncPrecacheFailed||0},steps:r.tests.map(t=>({step:t.step,...t.validation}))})),
  automatic:automatic.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.length})),resolvedHostFailure:audit(failureFile),payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Real Cooked streamable Nanite spheres and materials in ordinary ISM/HISM components. CPU instance range matches native center-distance and scalability semantics; GPU traversal/raster and fallback suppression are read back. GPU-only instances, remaining view/fade policies and full-scene performance remain open.'};
const file=path.join(__dirname,'evidence/nanite-instance-distance-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames)}));
