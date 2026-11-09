'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-default-scene/package.json'),pkg=read(packageFile);assert(pkg.pass&&pkg.defaultScene);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
for(const suffix of ['WebNaniteAutomaticSceneTest.cpp','StaticMeshSceneProxy.h','NaniteWebScene.cpp'])assert(full.sourceFiles.some(f=>f.file.endsWith(suffix)));
const cook=read(pkg.sceneCook.cook.file);assert(cook.pass&&cook.exitCode===0&&cook.naniteCookData);cook.sourceFiles.forEach(verify);verify(cook.defaultSamples);verify(cook.templateMap);
const samples=read(cook.defaultSamples.file);assert(samples.nanite&&samples.worldUnmodified&&samples.meshTriangles>=16000&&samples.nanitePages>1);
const legacyFile=path.join(__dirname,'results/nanite-pipeline-runtime-only/results.json'),legacy=read(legacyFile);
assert(legacy.pass&&legacy.oldCookDiagnostic);verify(legacy.source);verify(legacy.runtimeOverride);assert.equal(legacy.runtimeOverride.sha256,pkg.build.sha256);
assert.deepEqual(legacy.errors,[]);assert.equal(legacy.state.rhi.asyncPrecacheFailed,0);assert.equal(legacy.state.rhi.asyncPrecacheRequested,legacy.state.rhi.asyncPrecacheCompleted);
const runFiles=['packed','scalar'].map(n=>path.join(__dirname,'results/nanite-automatic-scene',n+'.json')),runs=runFiles.map(read);
const images=[];
for(const [i,r] of runs.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.equal(r.scalar,i===1);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),i===0);
  assert.equal(r.tests.length,8);assert(r.samples.sceneUnchanged);
  for(const t of r.tests){assert(t.validation);assert.equal(t.rejected,0);assert.equal(t.rhi.asyncPrecacheFailed,0);assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);verify(t.image);
    const target=path.join(__dirname,'evidence',`nanite-automatic-scene-20261110-${i?'scalar':'packed'}-${t.step}.png`);
    fs.copyFileSync(t.image.file,target);images.push(audit(target));
  }
}
const failureFiles=['failure-launch-forwarding.json','failure-static-lighting-observer.json'].map(f=>path.join(__dirname,'results/nanite-automatic-scene',f));
const failures=failureFiles.map(read);assert(failures.every(f=>!f.pass));assert.equal(failures[0].tests.length,0);assert(failures[1].final.frames>10000);
const payload=zlib.gzipSync(Buffer.from(JSON.stringify({runs,failures})),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),{runs,failures});
const startupFailure=path.join(__dirname,'results/web-default-samples-20261110-050509.log');
assert(fs.readFileSync(startupFailure,'utf8').includes("Couldn't find source file of virtual shader path '/Engine/Private/Nanite/WebNaniteVertexFactory.ush'"));
const simplifiedFixture=path.join(__dirname,'build/web-engine-webgpu-sm5-default-cook/20261110-051027/default-samples-layout.json');
assert.equal(read(simplifiedFixture).meshTriangles,256);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,cook:pkg.sceneCook.cook,samples,
  legacyStartup:{artifact:audit(legacyFile),oldCookDiagnostic:true,rhi:legacy.state.rhi},
  resolvedFailures:{startup:audit(startupFailure),simplifiedFixture:audit(simplifiedFixture),browser:failureFiles.map(audit),
    fixes:['Prepare and use the isolated shader host before generating default samples.','Select PercentTriangles explicitly so Nanite Auto fallback policy cannot simplify the reference and shadow geometry.',
      'Forward the automatic Nanite mode and explicit page budgets into the UE command line; publish default sample observations from the owner thread.',
      'Notify native material observers with static lighting disabled, and snapshot absent custom-data/precomputed-shadow targets as transparent zero without changing scene rendering.']},
  runs:runs.map((r,i)=>({artifact:audit(runFiles[i]),scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,registered:t.registered,entries:t.entries,batches:t.batches,validation:t.validation,pipelines:{requested:t.rhi.asyncPrecacheRequested,completed:t.rhi.asyncPrecacheCompleted,failed:t.rhi.asyncPrecacheFailed}}))})),
  images,payloadEncoding:'gzip-base64-json',payload:payload.toString('base64'),
  boundary:'Normal default-template world with original lighting and sky, additive streamable Nanite static meshes, actual materials and intact fallback geometry. Passive readback does not register geometry or replace materials. Native same-view image/performance comparison and remaining material/instance functionality are still open.'};
const file=path.join(__dirname,'evidence/nanite-automatic-scene-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames)}));
