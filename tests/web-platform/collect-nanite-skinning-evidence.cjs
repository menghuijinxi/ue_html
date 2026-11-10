'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(packageFile);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,pkg.skinningShaders,
 pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
validateCook(read(pkg.sceneCook.cook.file),false,{});
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
const native=read(pkg.skinningShaders.file);assert(native.pass);
[...native.sources,native.binary,native.builder,native.builderBuild,...native.logs,...native.assets,...native.sourceGeometry].forEach(verify);
const builder=read(native.builderBuild.file);assert(builder.pass&&builder.installedInputsUnmodified);
[...builder.sourceFiles,...builder.products,...builder.installedInputs].forEach(verify);
const weld=read(path.join(__dirname,'results/nanite-skinning/weld.json'));
assert(weld.pass&&weld.checks.length===15&&weld.checks.every(c=>c.pass)&&weld.nearestQueries===2048);
const weldBrowser=read(path.join(__dirname,'results/nanite-skinning/weld-browser.json'));
assert(weldBrowser.pass&&weldBrowser.rebuilt.length===3&&weldBrowser.rebuilt.every(s=>s.duplicateWeights.length===0&&s.missing.length===0&&s.extra.length===0));
[weldBrowser.source,weldBrowser.decoder,weldBrowser.package,...weldBrowser.inputs].forEach(verify);
assert.equal(weldBrowser.package.sha256,audit(packageFile).sha256);
assert.equal(native.materials.cases.length,20);assert.equal(native.basepass.cases.length,10);assert.equal(native.fixtures.length,4);
assert([...native.materials.cases,...native.basepass.cases].every(c=>c.preprocessed&&c.compiled&&c.errors.length===0));
const payload={},summaries=[];
function archive(name,value){const json=JSON.stringify(value),compressed=zlib.gzipSync(json,{level:9});
 assert.equal(zlib.gunzipSync(compressed).toString(),json);payload[name]=compressed.toString('base64');
 console.log({section:name,rawBytes:Buffer.byteLength(json),compressedBytes:compressed.length});}
function check(r,scalar,steps){
 assert(r.pass);assert.equal(r.scalar??r.scalarVisibility,scalar);verify(r.source);verify(r.package);
 assert.equal(r.package.sha256,pkgHash);assert.equal(r.tests.length,steps);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
 assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);assert(!r.legacyResetOrder);
 for(const t of r.tests){assert(t.validation);if(t.image)verify(t.image);}
 for(const name of ['geometry','geometryDecoder','geometryReference'])if(r[name])verify(r[name]);
 if(r.rhi){assert.equal(r.rhi.asyncPrecacheCompleted,r.rhi.asyncPrecacheRequested);assert.equal(r.rhi.asyncPrecacheFailed||0,0);}
 if(r.validationFailures)assert.deepEqual(r.validationFailures,[]);
}
const pkgHash=audit(packageFile).sha256;
for(const scalar of [false,true]){
 const suffix=scalar?'-scalar':'';
 for(const [suite,steps] of [['skinning',32],['skinning-streaming',9],['gpu-instances',29],['gpu-streaming',9],['distance',33],
  ['spline',38],['spline-streaming',9],['wpo',36],['wpo-streaming',9],['programmable',52],['materials',10],
  ['composition',9],['composition-unmerged',9],['streaming',9]]){
  const file=path.join(__dirname,`results/nanite-${suite.replace('-unmerged','')}/browser${suffix}${suite.endsWith('-unmerged')?'-unmerged':''}.json`);
  const r=read(file);check(r,scalar,steps);
  if(suite==='skinning')for(const t of r.tests){assert(t.entries.every(e=>e.skinning));assert(t.validation.compared>200&&t.validation.normalSamples>200);
   assert(t.validation.maxNormalCosineError<.003);assert(t.validation.maxDepthResidual<(t.perspective?1e-7:1.2e-7));}
  if(suite==='skinning-streaming'){assert(r.skinning);assert.equal(r.comparisons.length,6);assert.equal(r.ioFailure.failures,1);assert(r.ioFailure.retries>=1);}
  if(suite==='gpu-instances')assert(!r.writerBarrier&&!r.writerFinal&&!r.validateBindings&&!r.legacyWriter&&!r.diagnosticWrapper);
  if(suite.endsWith('-unmerged'))assert(r.unmerged);
  archive(suite+suffix,r);summaries.push({suite,scalar,steps,frames:r.frames,checks:r.tests.map(t=>({step:t.step,...t.validation}))});
 }
 for(const [kind,budgets] of [['skinning',[1,2,4,8,24]],['spline',[1,2,4,8,12]]]){
  const r=read(path.join(__dirname,`results/nanite-${kind}-budget/browser${suffix}.json`));assert(r.pass&&r[kind]);
  assert.equal(r.scalarVisibility,scalar);assert.deepEqual(r.errors,[]);verify(r.source);verify(r.package);assert.equal(r.package.sha256,pkgHash);
  if(kind==='skinning')verify(r.verifier);
  assert.deepEqual(r.budgets.map(b=>b.budget),budgets);
  for(const b of r.budgets){assert.equal(b.tests.length,9);assert.deepEqual(b.gpu.errors,[]);assert.equal(b.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
   assert.equal(b.tests.filter(t=>t.comparison).length,6);for(const t of b.tests.filter(t=>t.comparison))assert.equal(t.comparison.missingCore,0);}
  archive(kind+'-budget'+suffix,r);summaries.push({suite:kind+'-budget',scalar,steps:45,frames:r.budgets.reduce((n,b)=>n+b.frames,0)});
 }
}
const oracle=read(path.join(__dirname,'results/nanite-skinning/oracle-rejection.json'));
assert(oracle.pass);assert.equal(oracle.checks.length,12);assert.equal(oracle.streamingChecks.length,3);
[oracle.source,oracle.verifier,oracle.input,oracle.streamingVerifier,oracle.streamingInput,oracle.geometryDecoder].forEach(verify);
const hierarchy=read(pkg.hierarchyShaders.file);assert(hierarchy.pass);[...hierarchy.sources,hierarchy.binary,...hierarchy.logs].forEach(verify);
const materialTiles=read(path.join(__dirname,'results/nanite-skinning/material-tiles.json'));
assert(materialTiles.pass);assert.equal(materialTiles.cases.length,14);assert.deepEqual(materialTiles.failures,[]);assert.deepEqual(materialTiles.gpu.errors,[]);
[materialTiles.source,materialTiles.shader,materialTiles.wgsl,materialTiles.uploader,materialTiles.page].forEach(verify);
const rejectedTiles=read(path.join(__dirname,'results/nanite-skinning/failure-material-tiles/material-tiles.json'));
assert(!rejectedTiles.pass);assert.equal(rejectedTiles.failures.length,7);
assert.equal(rejectedTiles.gpu.output.find(r=>r.name==='skinned-cluster').args[1],0);
const rejectedTileSources=['source','shader','wgsl'].map(name=>{
 const original=rejectedTiles[name],saved=audit(path.join(__dirname,'results/nanite-skinning/failure-material-tiles',path.basename(original.file)));
 assert.equal(saved.sha256,original.sha256);return {...saved,originalPath:original.file};
});
archive('native',{native,builder,weld,weldBrowser,hierarchy,oracle,materialTiles,rejectedTiles,rejectedTileSources});
const skeletalRHI=read(path.join(__dirname,'results/nanite-skinning/rhi-typed-srv/nanite-rhi-results.json'));
assert(skeletalRHI.pass);assert.equal(skeletalRHI.modes.length,2);
for(const mode of skeletalRHI.modes){assert(mode.pass);assert.deepEqual(mode.errors,[]);assert.equal(mode.checks.length,19);assert(mode.checks.every(c=>c.pass));}
const rejectedScene=read(path.join(__dirname,'results/nanite-skinning/failure-first-scene/browser.json'));
assert(!rejectedScene.pass);assert.equal(rejectedScene.tests.length,32);assert.equal(rejectedScene.validationFailures.length,8);
const rejectedSRV=read(path.join(__dirname,'results/nanite-skinning/failure-typed-srv/browser.json'));
assert(!rejectedSRV.pass);assert(rejectedSRV.errors.some(s=>s.includes('Unsupported typed buffer SRV')));
archive('runtime-failures',{skeletalRHI,rejectedScene,rejectedSRV,
 nativeSemantics:read(path.join(__dirname,'results/nanite-skinning/failure-first-scene/native-inputs.json')),
 sources:['../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
 '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUNaniteVisibilityProbe.h',
 '../ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll'].map(f=>audit(path.resolve(__dirname,f)))});
const budgetFailureDirectory=path.join(__dirname,'results/nanite-skinning/failure-budget-cracks');
const rejectedBudget=read(path.join(budgetFailureDirectory,'browser.json'));
assert(!rejectedBudget.pass&&rejectedBudget.failure.includes('31 !== 0'));
const rejectedBudgetSource=audit(path.join(budgetFailureDirectory,'probe-nanite-skinning-budget.cjs'));
assert.equal(rejectedBudgetSource.sha256,rejectedBudget.source.sha256);
const budgetDiagnostic=read(path.join(budgetFailureDirectory,'budget-diagnostic.json'));
assert.equal(budgetDiagnostic.length,3);
for(const step of budgetDiagnostic){assert.deepEqual(step.missing,[]);assert.deepEqual(step.extra,[]);assert.equal(step.expected,step.covered);}
assert(budgetDiagnostic.some(step=>step.duplicateWeights.length>0));
const budgetBaseline=read(path.join(budgetFailureDirectory,'baseline-audit.json'));
const crypto=require('node:crypto');
const budgetBaselineMetadata=budgetBaseline.slice(0,2).map(item=>{
 const saved={...item.saved,file:path.resolve(__dirname,item.saved.file)};
 verify(saved);const bytes=zlib.gunzipSync(fs.readFileSync(saved.file));
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),item.original.sha256);
 return {audit:item,value:JSON.parse(bytes.toString().replace(/^\uFEFF/,''))};
});
assert.equal(rejectedBudget.package.sha256,budgetBaselineMetadata[0].audit.original.sha256);
archive('skinning-weld-failure',{rejectedBudget,rejectedBudgetSource,budgetDiagnostic,budgetBaselineMetadata,
 fixture:read(path.join(budgetFailureDirectory,'verified-before.json')),
 sources:['diagnose-budget.cjs','probe-nanite-skinning-budget.cjs','installed-Cluster.cpp','installed-MeshSimplify.cpp'].map(name=>{
  const file=path.join(budgetFailureDirectory,name);return {audit:audit(file),text:fs.readFileSync(file,'utf8')};
 }),diagnosis:'Independent CPU projection reproduces the selected native triangles with no missing or extra GPU pixels. Coincident simplified positions carry different bone bindings; the page-budget failure is a native simplification crack.'});
archive('cook-host-refresh-failure',{
 sources:['prepare-weld-host.log','weld-refresh-console.log','prepare-nanite-cook-host.cjs','builder-manifest.log','prepare-before-manifest-fix.cjs'].map(name=>{
  const file=path.join(__dirname,'results/nanite-skinning/failure-stale-host',name);return {audit:audit(file),text:fs.readFileSync(file,'utf8')};
 }),fixedSource:audit(path.join(__dirname,'prepare-nanite-cook-host.cjs'))});
const budgetOracle=read(path.join(__dirname,'results/nanite-skinning/budget-oracle.json'));
assert(budgetOracle.pass&&budgetOracle.checks.length===11&&budgetOracle.checks.filter(c=>c.rejected).length===9&&budgetOracle.checks.every(c=>c.pass));
[budgetOracle.source,budgetOracle.verifier,...budgetOracle.inputs].forEach(verify);
const silhouetteFailure=read(path.join(__dirname,'results/nanite-skinning/failure-weld-silhouette/browser.json'));
assert(!silhouetteFailure.pass&&silhouetteFailure.failure.includes('differentCoverage<=50'));
archive('budget-silhouette-oracle',{budgetOracle,silhouetteFailure,
 comparison:read(path.join(__dirname,'results/nanite-skinning/failure-weld-silhouette/comparison.json'))});
const signedZeroFailure=read(path.join(__dirname,'results/nanite-skinning/failure-signed-zero/weld.json'));
assert(!signedZeroFailure.pass&&signedZeroFailure.checks.length===15);
assert.deepEqual(signedZeroFailure.checks.filter(c=>!c.pass).map(c=>c.name),['signed zero coordinates retain intentional skin seams']);
archive('signed-zero-weld-failure',{signedZeroFailure,sources:['NaniteSkinningWeld-before.h','native.log','console.log'].map(name=>{
 const file=path.join(__dirname,'results/nanite-skinning/failure-signed-zero',name);return {audit:audit(file),text:fs.readFileSync(file,'utf8')};
})});
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
 summaries,shaderChecks:30,materialTileChecks:14,rhiChecks:38,weldChecks:15,weldNearestQueries:2048,oracleRejections:15,budgetOracleRejections:9,payloadEncoding:'gzip-base64-json-sections',payload,
 boundary:'Native skeletal component registration, bone bounds, material position/normal/velocity, resident and streamed resources are validated. UE 5.8 native skeletal Nanite omits vertex colors and ordinary skeletal proxies ignore the default animation-size threshold; those native semantics are retained. Instanced skeletal size policies, assemblies, curves, displacement, remaining material/view policies and complete-scene temporal reconstruction/performance remain open.'};
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const file=path.join(__dirname,`evidence/nanite-skinning-${stamp}.json`);fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
console.log({pass:true,file,steps:summaries.reduce((n,r)=>n+r.steps,0),frames:summaries.reduce((n,r)=>n+r.frames,0)});
