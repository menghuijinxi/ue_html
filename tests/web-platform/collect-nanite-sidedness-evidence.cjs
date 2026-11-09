'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(packageFile);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
const cook=read(pkg.sceneCook.cook.file);assert(cook.pass&&cook.exitCode===0);cook.sourceFiles.forEach(verify);
const conversionFiles=fs.readdirSync(path.dirname(cook.shaderInventory.artifact.file)).sort();
assert.deepEqual(conversionFiles,['inventory.json'],'Regression must exercise the cached Cook without compiler jobs');
const failureFiles=['failure-fixture-winding-20261110.json','failure-fixture-winding-package-20261110.json',
  'failure-cached-cook-inventory-20261110.json'].map(f=>path.join(__dirname,'results/nanite-sidedness',f));
const failures=failureFiles.map(read);assert(!failures[0].pass);assert(!failures[2].shaderInventory);
for(const name of ['WebNaniteSidednessTest.cpp','NaniteWebRaster.cpp','WebNaniteSceneTest.cpp','WebNaniteSceneCullTest.cpp','WebNaniteInstancesTest.cpp','WebNaniteViewsTest.cpp'])
  assert(full.sourceFiles.some(f=>f.file.endsWith(name)));
const helperFile=path.join(__dirname,'results/nanite-face-culling/verified.json'),helper=read(helperFile);
assert(helper.pass&&helper.failureCount===0&&helper.triangles===2048&&helper.computePixels>100);
[helper.source,...helper.sources,...helper.tools,...helper.products].forEach(verify);
const runFiles=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-sidedness',f)),runs=runFiles.map(read);
for(const [i,r] of runs.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.equal(r.scalarVisibility,i===1);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
  assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),i===0);assert.equal(r.tests.length,22);
  assert(r.gpu.microDispatches>20);
  for(const t of r.tests){assert(t.validation);assert.equal(t.rejected,0);assert.equal(t.cullState[1],0);
    if(t.step%2===0){assert(t.hardwareComparison.maxDepthError<3e-5);assert(t.hardwareComparison.maxNormalError<.003);}}
}
const regressionFiles=['nanite-browser','nanite-browser-scalar'].map(d=>path.join(__dirname,'results',d,'results.json')),regressions=regressionFiles.map(read);
for(const [i,r] of regressions.entries()){
  assert(r.pass&&r.scalarVisibility===(i===1));verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  for(const [name,item] of Object.entries(r))if(name.endsWith('Oracle'))verify(item);
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.startupPipelineFailures,[]);assert.equal(r.sceneMicroRepeats.length,128);assert.equal(r.sceneViews.length,10);
  for(const p of [r.storagePrecache,r.defaultDisabled.storagePrecache]){assert(p.validation.pass);assert.equal(p.rhi.asyncPrecacheFailed,0);assert.equal(p.rhi.asyncPrecacheCompleted,p.rhi.asyncPrecacheRequested);}
}
const streamFiles=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-streaming',f)),streaming=streamFiles.map(read);
for(const [i,r] of streaming.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.equal(r.scalarVisibility,i===1);assert.equal(r.tests.length,9);assert.deepEqual(r.errors,[]);
}
const payload=zlib.gzipSync(Buffer.from(JSON.stringify({runs,streaming,failures})),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),{runs,streaming,failures});
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
  cachedCook:{report:pkg.sceneCook.cook,inventory:cook.shaderInventory.artifact,conversionFiles},
  resolvedFailures:{artifacts:failureFiles.map(audit),
    fixture:'The generated plane and streaming sphere used the opposite triangle order to UE left-handed normals. Corrected source triangle winding; fixed-function GPU culling remains the independent reference.',
    cachedCook:'A complete shader-map cache hit ran no compiler jobs and skipped inventory recording. The shader-format module now records loaded shader types before engine shutdown; Cook rejects missing inventories while preserving its failure report.'},
  helper:{artifact:audit(helperFile),...helper},
  asset:{report:audit(path.join(__dirname,'results/nanite-sidedness/asset.json')),triangles:audit(path.join(__dirname,'results/nanite-sidedness/source-triangles.bin')),
    producer:audit(path.join(root,'tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteSidednessProbe.cpp'))},
  runs:runs.map((r,i)=>({artifact:audit(runFiles[i]),scalarVisibility:r.scalarVisibility,frames:r.frames,steps:r.tests.map(t=>({step:t.step,validation:t.validation,hardwareComparison:t.hardwareComparison}))})),
  regressions:regressions.map((r,i)=>({artifact:audit(regressionFiles[i]),scalarVisibility:r.scalarVisibility,frames:r.framesAfter,enabled:r.storagePrecache.rhi,disabled:r.defaultDisabled.storagePrecache.rhi})),
  streaming:streaming.map((r,i)=>({artifact:audit(streamFiles[i]),scalarVisibility:r.scalarVisibility,frames:r.frames})),
  payloadEncoding:'gzip-base64-json',payload:payload.toString('base64'),
  boundary:'Per-material rigid opaque sidedness in hardware and compute raster, instance mirroring, component reverse culling, orthographic views and material replacement. Original source geometry and fixed-function GPU culling provide independent references. Full native scene visual/performance comparison and remaining material/instance features remain open.'};
const file=path.join(__dirname,'evidence/nanite-sidedness-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,bytes:fs.statSync(file).size,frames:report.regressions.map(r=>r.frames)}));
