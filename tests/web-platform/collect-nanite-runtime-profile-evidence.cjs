'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const {profile,settings}=require('./web-accepted-defaults.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
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
const historicalFile=path.join(__dirname,'evidence/nanite-local-hierarchy-20261110.json'),historical=read(historicalFile);assert(historical.pass);
assert.equal(build.fullEngineBuild.sha256,historical.build.sha256,'The runtime-profile comparison must use the identical linked runtime');
const historicalPayload=JSON.parse(zlib.gunzipSync(Buffer.from(historical.payload,'base64')));
const conversion=read(packages['nanite-full-scene'].pkg.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
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
const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
for(const scalar of [false,true]){
  const mode=scalar?'scalar':'packed';
  const run=read(path.join(__dirname,`results/nanite-runtime-profile/${mode}.json`));
  check(run,'nanite-full-scene',scalar,9);assert.equal(run.acceptedProfile,profile);runs.push(run);
  for(const t of run.tests){
    assert(t.performance.frames>=120);assert.equal(t.rejected,0);
    const p=t.runtimeProfile;assert(p.bindings.bindingPlanEnabled&&p.bindings.dynamicGlobalsGroupReuse);
    assert.equal(p.bindings.groupAccessRevalidation,2);assert(p.uploads.enabled&&p.uploads.pooled>0&&p.readbacks.enabled);
  }
  const old=historicalPayload.runs.find(r=>r.scalar===scalar);assert(old);
  for(const step of [5,7,9]){
    const before=old.tests[step-1],after=run.tests[step-1];
    assert.deepEqual(after.view,before.view);assert.equal(after.entries,before.entries);
    assert.equal(after.materialDraws,before.materialDraws);assert.equal(after.registered,before.registered);
    assert.equal(after.pixels.length,before.pixels.length);
    let covered=0,maxDepthDifference=0,maxSpecularDifference=0;
    for(let p=0;p<after.pixels.length;p+=28){
      assert.equal(!!after.pixels[p],!!before.pixels[p],'Runtime settings changed Nanite coverage');
      if(!after.pixels[p])continue;
      assert.equal(after.pixels[p+1]===after.pixels[p+2],before.pixels[p+1]===before.pixels[p+2]);
      for(let j=1;j<3;j++)maxDepthDifference=Math.max(maxDepthDifference,Math.abs(asFloat(after.pixels[p+j])-asFloat(before.pixels[p+j])));
      if(after.pixels[p+1]!==after.pixels[p+2])continue;
      for(let j=8;j<28;j++){
        if(j===13)maxSpecularDifference=Math.max(maxSpecularDifference,Math.abs(asFloat(after.pixels[p+j])-asFloat(before.pixels[p+j])));
        else assert.equal(after.pixels[p+j],before.pixels[p+j],`${mode} step ${step} pixel ${p/28} channel ${j}`);
      }
      covered++;
    }
    assert(covered>1000);assert.equal(maxDepthDifference,0);assert(maxSpecularDifference<=1/255+1e-7);
    assert(after.performance.fps>before.performance.fps,'Applying accepted settings must improve each full-scene view');
    comparisons.push({scalar,step,covered,maxDepthDifference,maxSpecularDifference,before:before.performance,after:after.performance});
  }
  const programmable=read(path.join(__dirname,`results/nanite-programmable/browser${scalar?'-scalar':''}.json`));
  check(programmable,'nanite-browser',scalar,52);
  for(const t of programmable.tests){assert(t.complete&&t.rejected===0);assert(t.validation.maxDepthError<(t.perspective?3e-8:1.2e-7));}
  regressions.push({suite:'programmable',mode,run:programmable});
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
const cpuFile=path.join(__dirname,'results/cpu-nanite-runtime-profile.json'),cpu=read(cpuFile);assert(cpu.pass);assert.deepEqual(cpu.errors,[]);
assert.equal(cpu.samples.length,2);const rawProfiles=[];
for(const [i,s] of cpu.samples.entries()){
  assert.equal(s.profileThread,'rhi-worker');assert.equal(s.frameSource,'rhi-present');
  assert(s.after.occlusion.bindingPlanEnabled&&s.after.occlusion.dynamicGlobalsGroupReuse);
  assert.equal(s.after.occlusion.groupAccessRevalidation,2);
  const rawFile=path.join(__dirname,`results/cpu-nanite-runtime-profile-${i}.cpuprofile`);rawProfiles.push({file:audit(rawFile),data:read(rawFile)});
}
const payload={packages,runs,regressions,comparisons,cpu,rawProfiles};
const compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const images=[];
for(const mode of ['packed','scalar'])for(const step of [2,5,7,9]){
  const target=path.join(__dirname,`evidence/nanite-runtime-profile-20261110-${mode}-${step}.png`);
  fs.copyFileSync(path.join(__dirname,`results/nanite-runtime-profile/${mode}-${step}.png`),target);images.push(audit(target));
}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),profile,
  packages:Object.fromEntries(Object.entries(packages).map(([n,p])=>[n,audit(p.file)])),build:build.fullEngineBuild,images,
  historicalEvidence:audit(historicalFile),comparisons,
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.length})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,frames:r.run.frames??r.run.budgets.reduce((n,b)=>n+b.frames,0),
    steps:r.run.tests?.length??r.run.budgets.reduce((n,b)=>n+b.tests.length,0)})),
  cpu:{file:audit(cpuFile),samples:cpu.samples.map(s=>({baseline:s.baseline,callsPerFrame:s.callsPerFrame,
    rhiMsPerFrame:(s.after.stages.rhiWorkMilliseconds-s.before.stages.rhiWorkMilliseconds)/(s.after.presented-s.before.presented)}))},
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'All desktop Nanite packages apply the already accepted desktop runtime settings after staging. Actual active cache/upload modes, paired full-scene GBuffer/depth, masked/PDO and streaming budgets are verified. Native full-scene acceptance, deformation and other tracker requirements remain open.'};
const file=path.join(__dirname,'evidence/nanite-runtime-profile-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,comparisons:comparisons.map(c=>({scalar:c.scalar,step:c.step,before:c.before.fps,after:c.after.fps})),runs:report.runs,regressions:report.regressions,cpu:report.cpu}));
