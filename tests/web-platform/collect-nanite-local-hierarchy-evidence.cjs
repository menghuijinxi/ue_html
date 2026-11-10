'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const {validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packages={};
for(const name of ['nanite-browser','nanite-default-scene','nanite-full-scene']){
  const file=path.join(__dirname,'build',name,'package.json'),pkg=read(file);assert(pkg.pass);
  [...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,
    pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
  validateCook(read(pkg.sceneCook.cook.file),false,{});packages[name]={file,pkg};
}
const build=read(packages['nanite-browser'].pkg.build.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
for(const {pkg} of Object.values(packages))assert.equal(pkg.build.sha256,packages['nanite-browser'].pkg.build.sha256);
const hierarchy=read(packages['nanite-browser'].pkg.hierarchyShaders.file);assert(hierarchy.pass);
[...hierarchy.sources,hierarchy.binary,...hierarchy.compiler,...hierarchy.logs,...hierarchy.shaderInputs].forEach(verify);
const shader=read(packages['nanite-browser'].pkg.programmableShaders.file);assert(shader.pass);
[...shader.sources,shader.binary,...shader.logs].forEach(verify);assert.equal(shader.cases.length,12);
for(const c of shader.cases)assert(c.compiled&&c.preprocessed&&c.errors.length===0);
verify(packages['nanite-full-scene'].pkg.sceneConversion);
const conversion=read(packages['nanite-full-scene'].pkg.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
function check(run,pkg,scalar,steps){
  assert(run.pass);assert.equal(run.scalar??run.scalarVisibility,scalar);verify(run.source);verify(run.package);
  assert.equal(run.package.sha256,audit(packages[pkg].file).sha256);
  assert.deepEqual(run.errors,[]);
  if(steps!==undefined){assert.equal(run.tests.length,steps);assert.deepEqual(run.gpu.errors,[]);
    assert.equal(run.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
    for(const t of run.tests){assert(t.validation);if(t.image)verify(t.image);if(t.rhi){
      assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
    }}
  }
}
const runs=[],regressions=[];
for(const scalar of [false,true]){
  const mode=scalar?'scalar':'packed';
  const run=read(path.join(__dirname,`results/nanite-local-hierarchy/${mode}.json`));
  check(run,'nanite-full-scene',scalar,9);runs.push(run);
  assert.equal(run.tests.filter(t=>t.hierarchyComparison).length,3);
  for(const t of run.tests){assert.equal(t.rejected,0);assert(t.performance.frames>=120);}
  for(const step of [5,7,9]){
    const before=run.tests[step-2],after=run.tests[step-1],comparison=after.hierarchyComparison;
    assert.equal(before.localHierarchy,false);assert.equal(before.localHierarchyEntries,0);
    assert.equal(after.localHierarchy,true);assert.equal(after.localHierarchyEntries,after.entries);
    assert(after.maxHierarchyNodes>0&&after.maxHierarchyNodes<=256);
    assert.equal(after.entries,before.entries);assert.equal(after.materialDraws,before.materialDraws);
    assert.equal(after.entryInstanceIDs.length,after.entries);
    assert.deepEqual(after.entryInstanceIDs,before.entryInstanceIDs);assert.deepEqual(after.cullStates,before.cullStates);
    assert(comparison.compared>1000);assert.equal(comparison.maxDepthDifference,0);
    assert(comparison.maxSpecularDifference<=1/255+1e-7);
    assert.equal(comparison.before,before.hierarchyDispatchLevels);assert.equal(comparison.after,after.entries);
    assert(comparison.after<comparison.before);
    assert(after.performance.fps>=before.performance.fps,'The local queue must improve each paired full-scene view');
  }
  const automatic=read(path.join(__dirname,`results/nanite-automatic-scene/${mode}.json`));
  check(automatic,'nanite-default-scene',scalar,8);regressions.push({suite:'automatic',mode,run:automatic});
  const streaming=read(path.join(__dirname,`results/nanite-streaming-budget/browser${scalar?'-scalar':''}.json`));
  check(streaming,'nanite-browser',scalar);assert.deepEqual(streaming.budgets.map(b=>b.budget),[1,2,4,8,12]);
  for(const b of streaming.budgets){
    assert.deepEqual(b.gpu.errors,[]);assert.equal(b.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
    assert.equal(b.tests.length,9);assert.notEqual(b.tests[4].runtimeID,b.tests[5].runtimeID);
    for(const t of b.tests){assert.equal(t.poolPages,b.budget);assert.equal(t.owners.length,b.budget);assert.equal(t.rejected,0);assert.equal(t.cullState[1],0);}
    const compared=b.tests.filter(t=>t.comparison);assert.equal(compared.length,6);
    for(const t of compared){assert.equal(t.comparison.missingCore,0);assert(t.comparison.core>800);
      assert(t.comparison.differentCoverage<=50);assert(t.comparison.maxDepthError<.002);}
    if(b.budget===12)for(const t of compared){assert.equal(t.residentClusters,t.totalClusters);
      assert.equal(t.comparison.maxDepthError,0);assert.equal(t.comparison.differentCoverage,0);}
    else assert(b.tests[2].residentClusters<b.tests[2].totalClusters);
  }
  regressions.push({suite:'streaming-budget',mode,run:streaming});
}
const provenance=read(path.join(__dirname,'results/cpu-nanite-programmable-provenance.json'));
verify(provenance.source);
const historicalFile=path.join(__dirname,'evidence/nanite-programmable-20261110.json'),historical=read(historicalFile);assert(historical.pass);
assert.equal(provenance.package.sha256,historical.packages['nanite-full-scene'].sha256);
const profiles=['nanite-programmable','nanite-local-hierarchy'].map(tag=>{
  const file=path.join(__dirname,`results/cpu-${tag}.json`),run=read(file);assert(run.pass);assert.deepEqual(run.errors,[]);
  assert.equal(run.folder,'nanite-full-scene');assert.equal(run.samples.length,2);
  assert.equal(run.cameraMode,'fixed-room-wall');assert.deepEqual(run.settingsOverrides,[]);
  const raw=[];
  for(const [i,s] of run.samples.entries()){
    assert.equal(s.profileThread,'rhi-worker');assert.equal(s.frameSource,'rhi-present');
    const p=path.join(__dirname,`results/cpu-${tag}-${i}.cpuprofile`);raw.push({file:audit(p),data:read(p)});
  }
  return {file:audit(file),run,raw};
});
const failureFile=path.join(__dirname,'results/nanite-local-hierarchy/failure-all-memory-barrier.json');
const failure=read(failureFile);assert(failure.error.includes('control barrier requires workgroup memory scope'));
const failureSources=['log','usf'].map(ext=>{
  const file=path.join(__dirname,`results/nanite-local-hierarchy/failure-all-memory-barrier.${ext}`);
  return {file:audit(file),text:fs.readFileSync(file,'utf8')};
});
const payload={hierarchy,shader,runs,regressions,profiles,provenance,failure,failureSources};
const compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const images=[];
for(const mode of ['packed','scalar'])for(const step of [4,5,6,7,8,9]){
  const target=path.join(__dirname,`evidence/nanite-local-hierarchy-20261110-${mode}-${step}.png`);
  fs.copyFileSync(path.join(__dirname,`results/nanite-local-hierarchy/${mode}-${step}.png`),target);images.push(audit(target));
}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),
  packages:Object.fromEntries(Object.entries(packages).map(([n,p])=>[n,audit(p.file)])),build:build.fullEngineBuild,images,
  historicalEvidence:audit(historicalFile),
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,entries:t.entries,
    levels:t.hierarchyDispatchLevels,localEntries:t.localHierarchyEntries,performance:t.performance,comparison:t.hierarchyComparison}))})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,frames:r.run.frames??r.run.budgets.reduce((n,b)=>n+b.frames,0),
    steps:r.run.tests?.length??r.run.budgets.reduce((n,b)=>n+b.tests.length,0)})),
  profiles:profiles.map(p=>({file:p.file,samples:p.run.samples.map(s=>({baseline:s.baseline,callsPerFrame:s.callsPerFrame,
    rhiMsPerFrame:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))})),
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Small rigid hierarchies use a bounded single-workgroup queue; larger resources retain ordered per-level dispatches. Paired full-scene GPU states/depth and five streaming budgets are verified for both atomic paths. Full performance, deformation, remaining material/view permutations and native full-scene acceptance remain open.'};
const file=path.join(__dirname,'evidence/nanite-local-hierarchy-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames),regressions:report.regressions,profiles:report.profiles}));
