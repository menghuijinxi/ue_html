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
const shader=read(packages['nanite-browser'].pkg.programmableShaders.file);assert(shader.pass);
[...shader.sources,shader.binary,...shader.logs].forEach(verify);assert.equal(shader.cases.length,12);
for(const c of shader.cases)assert(c.compiled&&c.preprocessed&&c.errors.length===0);
const conversion=read(packages['nanite-full-scene'].pkg.sceneConversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
const runs=[],regressions=[];
function check(run,pkg,scalar,steps){
  assert(run.pass);assert.equal(run.scalar??run.scalarVisibility,scalar);verify(run.source);verify(run.package);
  assert.equal(run.package.sha256,audit(packages[pkg].file).sha256);assert.equal(run.tests.length,steps);
  assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
  assert.equal(run.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  for(const t of run.tests){assert(t.validation);if(t.image)verify(t.image);if(t.rhi){
    assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
  }}
}
for(const scalar of [false,true]){
  const mode=scalar?'scalar':'packed',suffix=scalar?'-scalar':'';
  const run=read(path.join(__dirname,`results/nanite-programmable/browser${suffix}.json`));
  check(run,'nanite-browser',scalar,52);runs.push(run);
  for(const t of run.tests){assert(t.complete&&t.rejected===0);assert(t.validation.maxDepthError<(t.perspective?3e-8:1.2e-7));}
  for(const [suite,pkg,steps,file] of [
    ['materials','nanite-browser',10,`nanite-materials/browser${suffix}.json`],
    ['sidedness','nanite-browser',22,`nanite-sidedness/browser${suffix}.json`],
    ['streaming','nanite-browser',9,`nanite-streaming/browser${suffix}.json`],
    ['automatic','nanite-default-scene',8,`nanite-automatic-scene/${mode}.json`],
    ['full-scene','nanite-full-scene',6,`nanite-full-scene/${mode}.json`]]){
    const r=read(path.join(__dirname,'results',file));check(r,pkg,scalar,steps);
    if(suite==='full-scene')for(const t of r.tests)if(t.enabled)assert(t.registered>1254&&t.validation.suppressed>1254);
    regressions.push({suite,mode,run:r});
  }
}
const failures=['failure-resolve-view.json','failure-fixture-page-budget.json','failure-pending-material-pipelines.json','failure-one-sided-baseline.json']
  .map(f=>read(path.join(__dirname,'results/nanite-programmable',f)));
for(const f of failures)assert(!f.pass);
const buildFailureFile=path.join(__dirname,'results/web-engine-full-thread-20261110-083304.log.actions.json.3.log');
const buildFailure={file:audit(buildFailureFile),text:fs.readFileSync(buildFailureFile,'utf8')};
assert(buildFailure.text.includes('error:')&&buildFailure.text.includes('FWebNaniteProgrammablePS'));
const payload={shader,runs,regressions,failures,buildFailure},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});
assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const images=[];
for(const mode of ['packed','scalar'])for(const step of [4,6,11,28,44,48,52]){
  const target=path.join(__dirname,`evidence/nanite-programmable-20261110-${mode}-${step}.png`);
  fs.copyFileSync(path.join(__dirname,`results/nanite-programmable/${mode}-${step}.png`),target);images.push(audit(target));
}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),
  packages:Object.fromEntries(Object.entries(packages).map(([n,p])=>[n,audit(p.file)])),build:build.fullEngineBuild,images,
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,...t.validation}))})),
  regressions:regressions.map(r=>({suite:r.suite,mode:r.mode,frames:r.run.frames,steps:r.run.tests.length,
    views:r.suite==='full-scene'?r.run.tests.map(t=>({step:t.step,registered:t.registered,entries:t.entries,materialDraws:t.materialDraws,
      validation:t.validation,performance:t.performance})):undefined})),
  payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Rigid masked and PDO materials execute actual cooked native material graphs before visibility competition, including both device paths, sidedness, mirrors, reverse culling and orthographic projection. Programmable vertices, deformation, other material and view permutations, native full-scene visual/performance and remaining tracker requirements are still open.'};
const file=path.join(__dirname,'evidence/nanite-programmable-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames),regressions:report.regressions}));
