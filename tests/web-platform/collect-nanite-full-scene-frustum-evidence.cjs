'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-full-scene/package.json'),pkg=read(packageFile);
assert(pkg.pass&&pkg.fullScene);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,
  pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory,pkg.sceneConversion].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
const conversion=read(pkg.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
const runs=['packed','scalar'].map(m=>read(path.join(__dirname,'results/nanite-full-scene-frustum',m+'.json')));
for(const [index,run] of runs.entries()){
  assert(run.pass&&run.scalar===(index===1));verify(run.source);verify(run.package);assert.equal(run.package.sha256,audit(packageFile).sha256);
  assert.equal(run.tests.length,9);assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
  assert.equal(run.tests.filter(t=>t.frustumComparison).length,3);
  for(const t of run.tests){verify(t.image);assert(t.validation&&t.rejected===0);assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);assert(t.performance?.frames>=120);}
  assert(Math.max(...run.tests.map(t=>t.performance.runtime.heapBytes))<2*1024**3,'The full-instance comparison must retain headroom below the failing 2 GiB heap limit');
  for(const step of [5,7,9]){
    const before=run.tests[step-2],after=run.tests[step-1];
    assert(after.frustumComparison.compared>1000);assert.equal(after.frustumComparison.maxDepthDifference,0);
    assert(after.performance.fps>before.performance.fps*3,'Whole-scene scheduling must materially improve');
  }
}
const failureFile=path.join(__dirname,'results/nanite-full-scene-frustum/failure-scalar-unculled-2gb.json');
const previousFailure=read(failureFile);assert(!previousFailure.pass&&previousFailure.scalar);
assert(previousFailure.logs.some(line=>line.includes('Ran out of memory allocating')));
assert.equal(previousFailure.tests.length,3,'The original failure must precede the uncullled comparison');
const defaultPackage=path.join(__dirname,'build/nanite-default-scene/package.json'),defaultPkg=read(defaultPackage);
assert(defaultPkg.pass&&defaultPkg.defaultScene);verify(defaultPkg.build);assert.equal(defaultPkg.build.sha256,pkg.build.sha256);
[...defaultPkg.sources,...defaultPkg.products,defaultPkg.sceneCook.stage,defaultPkg.sceneCook.cook,defaultPkg.sceneCook.inventory].forEach(verify);
const regressions=[];
for(const [suite,steps] of [['nanite-default-frustum',11],['nanite-automatic-scene',8],['nanite-instance-distance',17]]){
  for(const [index,mode] of ['packed','scalar'].entries()){
    const run=read(path.join(__dirname,'results',suite,mode+'.json'));
    assert(run.pass&&run.scalar===(index===1));verify(run.source);verify(run.package);assert.equal(run.package.sha256,audit(defaultPackage).sha256);
    assert.equal(run.tests.length,steps);assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
    if(suite==='nanite-default-frustum')assert.equal(run.tests.filter(t=>t.frustumComparison).length,4);
    if(suite==='nanite-instance-distance')assert(run.frustumDisabledForDistanceIsolation);
    for(const t of run.tests){assert(t.validation);if(t.image)verify(t.image);}
    regressions.push({suite,mode,run});
  }
}
const expectationFailureFile=path.join(__dirname,'results/nanite-automatic-scene/failure-frustum-entry-expectation.json');
const expectationFailure=read(expectationFailureFile);assert(!expectationFailure.pass&&expectationFailure.failure.includes('4 !== 8'));
const payload={runs,conversion,previousFailure,regressions,expectationFailure},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,entries:t.entries,skipped:t.skipped,
    visible:t.validation.visible,pixels:t.validation.covered,performance:t.performance,comparison:t.frustumComparison}))})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,frames:r.run.frames,steps:r.run.tests.length})),
  previousFailure:audit(failureFile),expectationFailure:audit(expectationFailureFile),payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Conservative CPU root-bound rejection matches the uncullled GPU path in three real Villa views for both device configurations. Removed entries had zero GPU-visible clusters, retained states and sampled depths match exactly, and material quantization differences are reported. Full-scene performance, programmable raster and remaining compatibility are still open.'};
const file=path.join(__dirname,'evidence/nanite-full-scene-frustum-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames)}));
