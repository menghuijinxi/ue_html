'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const {profile,settings}=require('./web-accepted-defaults.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const result=f=>path.join(__dirname,'results',f);
const packages={};
for(const name of ['nanite-browser','nanite-default-scene','nanite-full-scene']){
  const file=path.join(__dirname,'build',name,'package.json'),pkg=read(file);assert(pkg.pass);assert.equal(pkg.performanceProfile,profile);
  [...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,
    pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
  validateCook(read(pkg.sceneCook.cook.file),false,{});packages[name]={file,pkg};
  const configs=read(path.join(__dirname,'build',name,'config-files.json'));
  const config=Buffer.from(configs.find(c=>c.path==='/Engine/Platforms/Web/Config/WebEngine.ini').data,'base64').toString();
  const section=config.slice(config.lastIndexOf('[SystemSettings]'));
  for(const [key,value] of Object.entries(settings))assert(section.split(/\r?\n/).includes(`${key}=${value}`));
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
const kernels=['nanite-occlusion.json','nanite-local-occlusion-kernel.json'].map((f,i)=>{
  const run=read(result(f));assert(run.pass);assert.equal(run.local,!!i);assert.deepEqual(run.errors,[]);
  [run.source,...run.inputs,...run.sources].forEach(verify);assert.equal(run.results.length,22);
  for(const t of run.results)assert(t.pass);return run;
});
for(let i=0;i<kernels[0].results.length;i++){
  const a=kernels[0].results[i],b=kernels[1].results[i];assert.equal(a.name,b.name);assert.deepEqual(a.state,b.state);
  assert.deepEqual([...a.keys].sort((x,y)=>x-y),[...b.keys].sort((x,y)=>x-y));
}
function check(run,pkg,scalar,steps){
  assert(run.pass);assert.equal(run.scalar??run.scalarVisibility,scalar);verify(run.source);verify(run.package);
  assert.equal(run.package.sha256,audit(packages[pkg].file).sha256);assert.deepEqual(run.errors,[]);
  if(steps!==undefined){
    assert.equal(run.tests.length,steps);assert.deepEqual(run.gpu.errors,[]);
    assert.equal(run.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
    for(const t of run.tests){assert(t.validation);if(t.image)verify(t.image);if(t.rhi){
      assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
    }}
  }
}
const runs=[],regressions=[],comparisons=[];
const verifyHZB=require('./verify-nanite-scene-hzb.cjs');
for(const scalar of [false,true]){
  const mode=scalar?'scalar':'packed';
  const run=read(result(`nanite-local-occlusion/${mode}.json`));
  check(run,'nanite-full-scene',scalar,9);assert.equal(run.acceptedProfile,profile);runs.push(run);
  for(const t of run.tests){
    assert(t.performance.frames>=120);assert.equal(t.rejected,0);
    const p=t.runtimeProfile;assert(p.bindings.bindingPlanEnabled&&p.bindings.dynamicGlobalsGroupReuse);
    assert.equal(p.bindings.groupAccessRevalidation,2);assert(p.uploads.enabled&&p.uploads.pooled>0&&p.readbacks.enabled);
  }
  for(const step of [5,7,9]){
    const before=run.tests[step-2],after=run.tests[step-1],comparison=after.occlusionComparison;
    assert.equal(before.localOcclusion,false);assert.equal(before.localOcclusionEntries,0);
    assert.equal(after.localOcclusion,true);assert.equal(after.localOcclusionEntries,after.entries);
    assert.equal(after.entries,before.entries);assert.equal(after.materialDraws,before.materialDraws);
    assert.deepEqual(after.entryInstanceIDs,before.entryInstanceIDs);assert.deepEqual(after.cullStates,before.cullStates);
    assert(comparison.compared>1000);assert.equal(comparison.maxDepthDifference,0);
    assert(comparison.maxSpecularDifference<=1/255+1e-7);
    assert(after.performance.fps>before.performance.fps,'Local HZB must improve each paired full-scene view');
    comparisons.push({scalar,step,entries:after.entries,comparison,before:before.performance,after:after.performance});
  }
  for(const legacy of [false,true]){
    const hzb=read(result(`nanite-scene-hzb/verified${scalar?'-scalar':''}${legacy?'-legacy':''}.json`));
    check(hzb,'nanite-browser',scalar,9);assert.equal(hzb.legacy,legacy);
    for(const t of hzb.tests)assert.deepEqual(t.validation,verifyHZB(t));
    regressions.push({suite:legacy?'scene-hzb-legacy':'scene-hzb-local',mode,run:hzb});
  }
  const automatic=read(result(`nanite-automatic-scene/${mode}.json`));
  check(automatic,'nanite-default-scene',scalar,8);regressions.push({suite:'automatic',mode,run:automatic});
  const programmable=read(result(`nanite-programmable/browser${scalar?'-scalar':''}.json`));
  check(programmable,'nanite-browser',scalar,52);
  for(const t of programmable.tests){assert(t.complete&&t.rejected===0);assert(t.validation.maxDepthError<(t.perspective?3e-8:1.2e-7));}
  regressions.push({suite:'programmable',mode,run:programmable});
  const streaming=read(result(`nanite-streaming-budget/browser${scalar?'-scalar':''}.json`));
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
const historicalFile=path.join(__dirname,'evidence/nanite-runtime-profile-20261110.json'),historical=read(historicalFile);assert(historical.pass);
const old=JSON.parse(zlib.gunzipSync(Buffer.from(historical.payload,'base64')));
const cpuFile=result('cpu-nanite-local-occlusion.json'),cpu=read(cpuFile);assert(cpu.pass);assert.deepEqual(cpu.errors,[]);
assert.equal(cpu.folder,'nanite-full-scene');assert.equal(cpu.cameraMode,'fixed-room-wall');assert.deepEqual(cpu.settingsOverrides,[]);
assert.equal(cpu.samples.length,2);const rawProfiles=[];
for(const [i,s] of cpu.samples.entries()){
  assert.equal(s.profileThread,'rhi-worker');assert.equal(s.frameSource,'rhi-present');
  assert(s.after.occlusion.bindingPlanEnabled&&s.after.occlusion.dynamicGlobalsGroupReuse);
  assert.equal(s.after.occlusion.groupAccessRevalidation,2);
  assert(s.callsPerFrame.createBuffer<old.cpu.samples[i].callsPerFrame.createBuffer);
  const rawFile=result(`cpu-nanite-local-occlusion-${i}.cpuprofile`);rawProfiles.push({file:audit(rawFile),data:read(rawFile)});
}
const failure=read(result('nanite-local-occlusion-kernel-missing-owner-failure.json'));assert.equal(failure.pass,false);
assert(failure.logText.includes('Required member is undefined'));
const uploaderLog=result('nanite-uploader/20261110-102926/rhi.log');
const invocationFailure={file:audit(uploaderLog),text:fs.readFileSync(uploaderLog,'utf8')};
assert(invocationFailure.text.includes('resources.cooked.bin/pages.bin'));
const payload={packages,hierarchy,shader,kernels,runs,regressions,comparisons,cpu,rawProfiles,failure,invocationFailure};
const compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const images=[];
for(const mode of ['packed','scalar'])for(const step of [4,5,6,7,8,9]){
  const target=path.join(__dirname,`evidence/nanite-local-occlusion-20261110-${mode}-${step}.png`);
  fs.copyFileSync(result(`nanite-local-occlusion/${mode}-${step}.png`),target);images.push(audit(target));
}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),profile,
  verifier:audit(path.join(__dirname,'verify-nanite-scene-hzb.cjs')),
  packages:Object.fromEntries(Object.entries(packages).map(([n,p])=>[n,audit(p.file)])),build:build.fullEngineBuild,images,
  historicalEvidence:audit(historicalFile),comparisons,kernelCases:kernels.map(k=>({local:k.local,cases:k.results.length})),
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.length})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,frames:r.run.frames??r.run.budgets.reduce((n,b)=>n+b.frames,0),
    steps:r.run.tests?.length??r.run.budgets.reduce((n,b)=>n+b.tests.length,0)})),
  cpu:{file:audit(cpuFile),samples:cpu.samples.map(s=>({baseline:s.baseline,callsPerFrame:s.callsPerFrame,
    rhiMsPerFrame:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))},
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'HZB lists up to 16384 clusters initialize and cull in one workgroup; larger lists retain separate clears and parallel dispatch. Kernel guards, actual two-pass occlusion recovery, paired full-scene GBuffer/depth, default scene, masked/PDO and five page budgets are verified for both device atomic paths. Full performance, native full-scene acceptance and remaining compatibility requirements stay open.'};
const file=path.join(__dirname,'evidence/nanite-local-occlusion-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,comparisons:comparisons.map(c=>({scalar:c.scalar,step:c.step,before:c.before.fps,after:c.after.fps})),runs:report.runs,regressions:report.regressions,cpu:report.cpu}));
