'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const {validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packages={};
for(const name of ['nanite-full-scene','nanite-default-scene','nanite-browser']){
  const file=path.join(__dirname,'build',name,'package.json'),pkg=read(file);assert(pkg.pass);
  [...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,
    pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
  validateCook(read(pkg.sceneCook.cook.file),false,{});
  packages[name]={file,pkg};
}
const full=packages['nanite-full-scene'].pkg,build=read(full.build.file);
assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
for(const {pkg} of Object.values(packages))assert.equal(pkg.build.sha256,full.build.sha256);
verify(full.sceneConversion);const conversion=read(full.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
const runs=['packed','scalar'].map(m=>read(path.join(__dirname,'results/nanite-material-bins',m+'.json')));
for(const [index,run] of runs.entries()){
  assert(run.pass&&run.scalar===(index===1));verify(run.source);verify(run.package);
  assert.equal(run.package.sha256,audit(packages['nanite-full-scene'].file).sha256);
  assert.equal(run.tests.length,9);assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
  assert.equal(run.tests.filter(t=>t.binsComparison).length,3);
  for(const t of run.tests){verify(t.image);assert(t.validation&&t.rejected===0);assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);assert(t.performance.frames>=120);}
  for(const step of [5,7,9]){
    const before=run.tests[step-2],after=run.tests[step-1];assert(after.binsComparison.compared>1000);
    assert.equal(after.binsComparison.maxDepthDifference,0);assert(after.materialDraws<before.materialDraws*.75);
    assert(after.performance.fps>=before.performance.fps*.9,'Material grouping must not substantially regress full-scene performance');
  }
}
const regressions=[];
for(const [index,mode] of ['packed','scalar'].entries()){
  const automatic=read(path.join(__dirname,'results/nanite-automatic-scene',mode+'.json'));
  assert(automatic.pass&&automatic.scalar===(index===1));verify(automatic.source);verify(automatic.package);
  assert.equal(automatic.package.sha256,audit(packages['nanite-default-scene'].file).sha256);
  assert.equal(automatic.tests.length,8);assert.deepEqual(automatic.errors,[]);assert.deepEqual(automatic.gpu.errors,[]);
  for(const t of automatic.tests){assert(t.validation);verify(t.image);}
  regressions.push({suite:'automatic',mode,run:automatic});
  for(const unmerged of [false,true]){
    const material=read(path.join(__dirname,'results/nanite-materials',`browser${index?'-scalar':''}${unmerged?'-unmerged':''}.json`));
    assert(material.pass&&material.scalarVisibility===(index===1)&&material.unmerged===unmerged);
    verify(material.source);verify(material.package);assert.equal(material.package.sha256,audit(packages['nanite-browser'].file).sha256);
    assert.equal(material.tests.length,10);assert.deepEqual(material.errors,[]);assert.deepEqual(material.gpu.errors,[]);
    for(const t of material.tests){assert(t.validation&&t.complete);assert.equal(t.bins,unmerged?(t.step===5||t.step===7?2:3):(t.step>=3&&t.step<=7?2:3));}
    regressions.push({suite:'material-lifecycle',mode,unmerged,run:material});
  }
}
const missingFixtureFailure=read(path.join(__dirname,'results/nanite-materials/failure-missing-recook-fixtures.json'));
assert(!missingFixtureFailure.pass&&missingFixtureFailure.logs.some(l=>l.includes('WebNaniteMaterials/NaniteMaterial0')&&l.includes('does not exist')));
const payload={runs,regressions,missingFixtureFailure},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),packages:Object.fromEntries(Object.entries(packages).map(([name,p])=>[name,audit(p.file)])),
  build:build.fullEngineBuild,runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,entries:t.entries,
    materialDraws:t.materialDraws,performance:t.performance,comparison:t.binsComparison}))})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,unmerged:r.unmerged,frames:r.run.frames,steps:r.run.tests.length})),
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Groups only identical native pixel shaders and actual shader bindings, with one cached bin list shared by composition and material passes. Three full Villa views and live material updates are verified for both atomic paths. Programmable raster, remaining material permutations, full performance and other tracker items remain open.'};
const file=path.join(__dirname,'evidence/nanite-material-bins-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames),regressions:report.regressions}));
