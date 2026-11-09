'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const fullFile=path.join(__dirname,'build/nanite-full-scene/package.json'),full=read(fullFile);
const defaultFile=path.join(__dirname,'build/nanite-default-scene/package.json'),defaults=read(defaultFile);
assert(full.pass&&full.fullScene&&defaults.pass&&defaults.defaultScene);
for(const pkg of [full,defaults]){
  [...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,
    pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
  const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
  const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
  assert(compiled.sourceFiles.some(s=>s.file.endsWith('NaniteWebScene.cpp')));
}
verify(full.sceneConversion);const conversion=read(full.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
const scene=read(path.join(__dirname,'results/nanite-full-scene/packed.json'));
assert(scene.pass&&!scene.scalar);verify(scene.source);verify(scene.package);assert.equal(scene.package.sha256,audit(fullFile).sha256);
assert.equal(scene.tests.length,6);assert.deepEqual(scene.errors,[]);assert.deepEqual(scene.gpu.errors,[]);
for(const t of scene.tests){verify(t.image);assert(t.validation&&t.rejected===0);assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);assert(t.performance?.frames>=120);}
const bounds=['packed','scalar'].map(m=>read(path.join(__dirname,'results/nanite-material-bounds',m+'.json')));
for(const [index,run] of bounds.entries()){
  assert(run.pass&&run.scalar===(index===1));verify(run.source);verify(run.package);assert.equal(run.package.sha256,audit(defaultFile).sha256);
  assert.equal(run.tests.length,9);assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
  assert.equal(run.tests.filter(t=>t.boundsComparison).length,3);
  for(const t of run.tests){verify(t.image);assert.equal(t.rhi.asyncPrecacheFailed||0,0);}
}
const failureFile=path.join(__dirname,'results/nanite-full-scene/failure-2gb-rdg.json'),failure=read(failureFile);
assert(!failure.pass&&failure.final.frames===3&&failure.logs.some(l=>l.includes('Ran out of memory allocating')));
assert(failure.logs.some(l=>l.includes('the limit is 2147483648 bytes')));
const comparisonFailureFile=path.join(__dirname,'results/nanite-material-bounds/failure-unowned-pixel-comparison.json');
const comparisonFailure=read(comparisonFailureFile);assert(!comparisonFailure.pass&&comparisonFailure.failure.includes('Bounds pixel 0, channel 3'));
const payload={conversion,scene,bounds,failure,comparisonFailure},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});
assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),packages:[audit(fullFile),audit(defaultFile)],
  assets:conversion.summary,scene:{scalar:scene.scalar,frames:scene.frames,steps:scene.tests.map(t=>({step:t.step,entries:t.entries,
    draws:t.materialDraws,...t.validation,unboundedPixels:t.unboundedEntryPixels,boundedPixels:t.boundedEntryPixels,
    hierarchyDispatchLevels:t.hierarchyDispatchLevels,performance:t.performance}))},
  comparisons:bounds.map(r=>({scalar:r.scalar,frames:r.frames,comparisons:r.tests.filter(t=>t.boundsComparison).map(t=>({step:t.step,view:t.view,...t.boundsComparison}))})),
  resolvedMemoryFailure:audit(failureFile),correctedComparisonFailure:audit(comparisonFailureFile),
  comparisonBoundary:'Coverage and depth match exactly. Nanite GBuffer channels match exactly except the one-code UNORM8 specular rounding boundary at 0.5; differences are retained. View.PreExposure is not a material output, and scene color is compared after undoing pre-exposure.',
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'The full-scene packed diagnostic survived the original 2 GiB heap failure and six views/toggles with zero GPU errors. Both device configurations passed fixed-jitter GBuffer bounds comparisons. Full-scene performance remains unacceptable, and masked/PDO and other compatibility items remain open; this is not a delivery build.'};
const file=path.join(__dirname,'evidence/nanite-full-scene-bounds-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,sceneFrames:scene.frames,boundsFrames:bounds.map(r=>r.frames)}));
