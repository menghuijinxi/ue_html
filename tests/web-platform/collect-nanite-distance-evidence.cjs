'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(packageFile);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,
 pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
validateCook(read(pkg.sceneCook.cook.file),false,{});
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
const shader=read(pkg.programmableShaders.file);assert(shader.pass);
[...shader.sources,shader.binary,...shader.logs].forEach(verify);
assert.equal(shader.cases.length,44);assert.equal(shader.cases.filter(c=>c.frequency==='vertex').length,11);
for(const c of shader.cases)assert(c.preprocessed&&c.compiled&&c.errors.length===0);
const payload={},summaries=[];
function archive(name,value){
 const json=JSON.stringify(value),compressed=zlib.gzipSync(json,{level:9});
 assert.equal(zlib.gunzipSync(compressed).toString(),json);payload[name]=compressed.toString('base64');
 console.log({section:name,rawBytes:Buffer.byteLength(json),compressedBytes:compressed.length});
}
function check(r,scalar,steps){
 assert(r.pass);assert.equal(r.scalar??r.scalarVisibility,scalar);verify(r.source);verify(r.package);
 assert.equal(r.package.sha256,audit(packageFile).sha256);assert.equal(r.tests.length,steps);
 assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
 assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
 for(const t of r.tests){assert(t.validation);if(t.image)verify(t.image);}
 if(r.rhi){assert.equal(r.rhi.asyncPrecacheCompleted,r.rhi.asyncPrecacheRequested);assert.equal(r.rhi.asyncPrecacheFailed||0,0);}
}
for(const scalar of [false,true]){
 const suffix=scalar?'-scalar':'';
 for(const [suite,steps] of [['distance',33],['spline',38],['spline-streaming',9],['wpo',36],['wpo-streaming',9],['programmable',52],['materials',10],['composition',9],['composition-unmerged',9],['streaming',9]]){
  const r=read(path.join(__dirname,`results/nanite-${suite.replace('-unmerged','')}/browser${suffix}${suite.endsWith('-unmerged')?'-unmerged':''}.json`));check(r,scalar,steps);
  if(r.geometry)verify(r.geometry);if(r.geometryReference)verify(r.geometryReference);if(r.geometryDecoder)verify(r.geometryDecoder);
  if(suite==='spline'){
   assert.deepEqual(r.validationFailures,[]);
   for(const t of r.tests){assert(t.validation.compared>200&&t.validation.normalSamples>200);
    assert(t.validation.maxNormalCosineError<.003);assert(t.validation.maxDepthResidual<(t.perspective?1e-7:1.2e-7));}
   assert(r.tests[23].validation.cameraReconstructed>100);
  }
  if(suite==='spline-streaming'){assert(r.spline&&r.wpo);assert.equal(r.comparisons.length,6);assert.equal(r.ioFailure.failures,1);assert(r.ioFailure.retries>=1);}
  if(suite.startsWith('composition'))assert.equal(r.unmerged,suite.endsWith('-unmerged'));
  archive(suite+suffix,r);summaries.push({suite,scalar,frames:r.frames,steps:r.tests.length,
   ...(suite==='spline'?{checks:r.tests.map(t=>({step:t.step,...t.validation}))}:{})});
 }
 const budgets=read(path.join(__dirname,`results/nanite-spline-budget/browser${suffix}.json`));
 assert(budgets.pass&&budgets.spline);assert.equal(budgets.scalarVisibility,scalar);assert.deepEqual(budgets.errors,[]);
 verify(budgets.source);verify(budgets.package);assert.equal(budgets.package.sha256,audit(packageFile).sha256);
 assert.deepEqual(budgets.budgets.map(b=>b.budget),[1,2,4,8,12]);
 for(const b of budgets.budgets){assert.equal(b.tests.length,9);assert.deepEqual(b.gpu.errors,[]);
  assert.equal(b.tests.filter(t=>t.comparison).length,6);for(const t of b.tests.filter(t=>t.comparison))assert.equal(t.comparison.missingCore,0);}
 archive('budgets'+suffix,budgets);summaries.push({suite:'spline-budget',scalar,steps:45,frames:budgets.budgets.reduce((n,b)=>n+b.frames,0)});
}
const kernels=['nanite-occlusion.json','nanite-local-occlusion-kernel.json'].map(f=>read(path.join(__dirname,'results',f)));
for(const r of kernels){assert(r.pass);assert.equal(r.results.length,30);assert.deepEqual(r.errors,[]);[r.source,...r.sources,...r.inputs].forEach(verify);}
const reference=read(path.join(__dirname,'results/nanite-spline/reference/verified.json'));
assert(reference.pass&&reference.cases===3096);[reference.source,...reference.sources,...reference.tools,...reference.products].forEach(verify);
const oracle=read(path.join(__dirname,'results/nanite-spline/oracle-rejection.json'));
assert(oracle.pass);assert.equal(oracle.checks.length,12);assert.equal(oracle.streamingChecks.length,3);
[oracle.source,oracle.verifier,oracle.input,oracle.streamingVerifier,oracle.streamingInput,oracle.geometryReference].forEach(verify);
const wpoOracle=read(path.join(__dirname,'results/nanite-wpo/oracle-rejection.json'));
assert(wpoOracle.pass);assert.equal(wpoOracle.checks.length,10);assert.equal(wpoOracle.streamingChecks.length,3);
[wpoOracle.source,wpoOracle.verifier,wpoOracle.input,wpoOracle.streamingVerifier,wpoOracle.streamingInput,wpoOracle.geometryDecoder].forEach(verify);
const failures=[];
for(const name of ['failure-uploader-argument','failure-vector-readback','failure-console-reference','failure-spline-fixture-occlusion','superseded-near-boundary']){
 const directory=path.join(__dirname,'results/nanite-distance',name),files=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);
  else if(/\.(json|log|txt|cjs|cpp|ush|h|hlsl)$/.test(f))files.push({file:audit(f),content:fs.readFileSync(f,'utf8')});}}
 walk(directory);assert(files.length);
 archive(name,{files});failures.push({name,files:files.map(f=>f.file)});
}
const distanceOracle=read(path.join(__dirname,'results/nanite-distance/oracle-rejection.json'));
assert(distanceOracle.pass&&distanceOracle.checks.length>=4);
[distanceOracle.source,distanceOracle.verifier,distanceOracle.input].forEach(verify);
archive('native',{shader,kernels,reference,oracle,wpoOracle,distanceOracle});archive('failures',failures);
const images=[];
for(const mode of ['packed','scalar'])for(const step of [2,3,10,13,20,23,25,30]){
 const file=path.join(__dirname,`evidence/nanite-distance-20261110-${mode}-${step}.png`);
 fs.copyFileSync(path.join(__dirname,`results/nanite-distance/${mode}-${step}.png`),file);images.push(audit(file));
}
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
 images,summaries,kernelChecks:60,referenceChecks:3096,oracleRejections:28+distanceOracle.checks.length,payloadEncoding:'gzip-base64-json-sections',payload,
 boundary:'Native pixel programmable distance and WPO distance debug control are covered for ordinary, CPU instanced and spline components. Pixel fallback disables mask/PDO while preserving vertex deformation and final material shading. Skinning, GPU-only instances, assemblies, curves, displacement, remaining materials/views, full-scene temporal reconstruction and performance remain open in the completion tracker.'};
const file=path.join(__dirname,'evidence/nanite-distance-20261110.json');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
console.log({pass:true,file,steps:summaries.reduce((n,r)=>n+r.steps,0),frames:summaries.reduce((n,r)=>n+r.frames,0)});
