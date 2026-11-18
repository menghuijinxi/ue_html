'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>{assert(i?.file&&i.sha256);assert.equal(audit(i.file).sha256,i.sha256,i.file);};
const file=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(file);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,pkg.skinningShaders,pkg.assemblyShaders,
 pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
validateCook(read(pkg.sceneCook.cook.file),false,{});
const runtime=read(pkg.build.file);assert(runtime.pass&&runtime.fullTargetBuild);
[...runtime.sources,...runtime.products,runtime.fullEngineBuild].forEach(verify);
const build=read(runtime.fullEngineBuild.file);assert(build.pass&&build.fullLinkVerified);build.sourceFiles.forEach(verify);
const native=read(pkg.assemblyShaders.file);assert(native.pass&&native.fixtures.length===8);
[...native.sources,native.binary,native.builder,native.builderBuild,...native.logs,...native.assets,...native.sourceGeometry].forEach(verify);
assert.equal(native.materials.cases.length,40);assert.equal(native.basepass.cases.length,20);
assert([...native.materials.cases,...native.basepass.cases].every(c=>c.preprocessed&&c.compiled&&c.errors.length===0));
assert.equal(native.assets.length,21);
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const archiveRoot=path.join(__dirname,`evidence/nanite-assembly-${stamp}`);fs.mkdirSync(archiveRoot,{recursive:true});
const payload={},summaries=[],packageHash=audit(file).sha256;
function archive(name,value){const json=JSON.stringify(value),bytes=zlib.gzipSync(json,{level:9});
 assert.equal(zlib.gunzipSync(bytes).toString(),json);
 // Keep the verified sections as binary gzip files. Combining all base64
 // payloads into one JSON exceeded V8's maximum string length.
 const target=path.join(archiveRoot,name+'.json.gz');fs.writeFileSync(target,bytes);
 payload[name]={...audit(target),rawBytes:Buffer.byteLength(json),compressedBytes:bytes.length};
 console.log({section:name,rawBytes:Buffer.byteLength(json),compressedBytes:bytes.length});}
for(const kind of ['static','skin']){
 for(const scalar of [false,true]){
  const suffix=scalar?'-scalar':'';
  for(const [suite,steps]of [['scene',34],['streaming',9]]){
   const r=read(path.join(__dirname,`results/nanite-assembly/${kind}-${suite}/browser${suffix}.json`));
   assert(r.pass);assert.equal(r.scalar??r.scalarVisibility,scalar);assert.equal(r.tests.length,steps);
   for(const name of ['source','package','fixture','geometry','geometryDecoder','geometryReference'])if(r[name])verify(r[name]);
   for(const source of r.partSources||[])verify(source);
   assert.equal(r.package.sha256,packageHash);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
   assert(!(r.logs||[]).some(s=>/P3_WEB_COMPUTE_PIPELINE_REJECT|Failed to create (?:compute|graphics) pipeline/.test(s)),'assembly runtime pipeline failure');
   assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
   for(const t of r.tests){assert(t.validation);if(t.image)verify(t.image);}
   if(suite==='scene'){
    assert.equal(r.staticAssembly,kind==='static');assert.deepEqual(r.validationFailures,[]);
    assert.equal(r.rhi.asyncPrecacheRequested,r.rhi.asyncPrecacheCompleted);assert.equal(r.rhi.asyncPrecacheFailed||0,0);
    for(const t of r.tests){assert(t.validation.compared>200&&t.validation.normalSamples>200);
     assert(t.entries.every(e=>e.assemblyCount===4));assert(t.validation.maxNormalCosineError<.003);
     assert(t.validation.maxDepthResidual<(t.perspective?1e-7:1.2e-7));}
   }else{
    assert(r.assembly);assert.equal(r.skinning,kind==='skin');assert.equal(r.comparisons.length,6);
    assert.equal(r.ioFailure.failures,1);assert(r.ioFailure.retries>=1);
   }
   archive(`${kind}-${suite}${suffix}`,r);summaries.push({kind,suite,scalar,steps,frames:r.frames});
  }
  const r=read(path.join(__dirname,`results/nanite-assembly/${kind}-budget/browser${suffix}.json`));
  assert(r.pass);assert.equal(r.scalarVisibility,scalar);assert.equal(r.skinning,kind==='skin');assert.deepEqual(r.errors,[]);
  verify(r.source);verify(r.verifier);verify(r.geometryDecoder);verify(r.geometryReference);verify(r.package);assert.equal(r.package.sha256,packageHash);
  assert.deepEqual(r.budgets.map(b=>b.budget),[1,2,4,8,48]);
  for(const b of r.budgets){assert.equal(b.tests.length,9);assert.deepEqual(b.gpu.errors,[]);
   assert(!(b.logs||[]).some(s=>/P3_WEB_COMPUTE_PIPELINE_REJECT|Failed to create (?:compute|graphics) pipeline/.test(s)),'assembly budget runtime pipeline failure');
   assert.equal(b.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
   assert.equal(b.tests.filter(t=>t.comparison).length,6);
   for(const t of b.tests){const v=t.comparison||t.geometryValidation;assert(v);assert.equal(v.missingCore,0);assert.equal(v.extraCore,0);assert(v.maxDepthResidual<1e-7);}}
  archive(`${kind}-budget${suffix}`,r);summaries.push({kind,suite:'budget',scalar,steps:45,frames:r.budgets.reduce((n,b)=>n+b.frames,0)});
 }
 const oracle=read(path.join(__dirname,`results/nanite-assembly/${kind}-oracle-rejection.json`));
 assert(oracle.pass&&oracle.checks.length===15&&oracle.streamingChecks.length===3&&oracle.budgetChecks.length===9);
 for(const name of ['source','verifier','input','streamingVerifier','streamingInput','geometryDecoder','budgetInput','budgetVerifier'])verify(oracle[name]);
 archive(kind+'-oracle',oracle);
}
// The ordinary component suites must have completed against this exact package
// after the visible-record stride and native vertex factory changes.
const regressionName=fs.readdirSync(path.join(__dirname,'evidence')).filter(f=>/^nanite-skinning-\d+\.json$/.test(f)).sort().at(-1);
assert(regressionName);const regressionFile=path.join(__dirname,'evidence',regressionName),regression=read(regressionFile);
assert(regression.pass&&regression.oracleRejections===15&&regression.materialTileChecks===14);
assert.equal(regression.package.sha256,packageHash);verify(regression.source);verify(regression.package);
const hierarchy=read(pkg.hierarchyShaders.file);assert(hierarchy.pass);[...hierarchy.sources,hierarchy.binary,...hierarchy.logs].forEach(verify);
const materialTiles=read(path.join(__dirname,'results/nanite-assembly/material-tiles.json'));
assert(materialTiles.pass&&materialTiles.assembly&&materialTiles.cases.length===14);
assert.equal(read(materialTiles.shader.file).shaderName,'FWebNaniteGBufferTilesCS');
assert(path.resolve(materialTiles.shader.file).startsWith(path.resolve(__dirname,'results/nanite-hierarchy-shaders/conversion')+path.sep));
assert.deepEqual(materialTiles.failures,[]);assert.deepEqual(materialTiles.gpu.errors,[]);
for(const name of ['source','shader','wgsl','uploader','page'])verify(materialTiles[name]);
archive('native',{native,hierarchy,materialTiles});
const kernels=[];
for(const name of ['transform','hierarchy','occlusion'])for(const local of name==='transform'?[false]:[false,true]){
 const r=read(path.join(__dirname,`results/nanite-assembly/${name}-kernel-production${local?'-local':''}.json`));
 assert(r.pass);verify(r.source);r.inputs.forEach(verify);(r.sources||[]).forEach(verify);
 if(name==='transform'){assert.equal(r.cases,13);assert.deepEqual(r.gpu.errors,[]);}
 else {assert.equal(r.local,local);assert.equal(r.results.length,name==='hierarchy'?10:44);assert.deepEqual(r.errors,[]);assert(r.results.every(c=>c.pass));}
 kernels.push({name,local,result:r});
}
archive('production-kernels',kernels);
const bindings=read(path.join(__dirname,'results/nanite-assembly/hierarchy-bindings.json'));
assert(bindings.pass&&!bindings.baseline&&bindings.limit===16&&bindings.results.length===4);
verify(bindings.source);bindings.inputs.forEach(verify);assert.deepEqual(bindings.errors,[]);
assert(bindings.results.every(r=>r.storageBuffers<=16&&!r.pipelineError&&!r.scopeError));archive('hierarchy-bindings',bindings);
const baselineBindings=read(path.join(__dirname,'results/nanite-assembly/hierarchy-bindings-baseline.json'));
assert(baselineBindings.pass&&baselineBindings.baseline&&baselineBindings.results[0].storageBuffers===17);
verify(baselineBindings.source);baselineBindings.inputs.forEach(verify);archive('hierarchy-bindings-baseline',baselineBindings);
const failureFiles=[];
for(const directory of fs.readdirSync(path.join(__dirname,'results/nanite-assembly')).filter(n=>n.startsWith('failure-'))){
 const folder=path.join(__dirname,'results/nanite-assembly',directory);
 for(const name of fs.readdirSync(folder)){
  const file=path.join(folder,name);if(!fs.statSync(file).isFile())continue;
  const bytes=fs.readFileSync(file),compressed=zlib.gzipSync(bytes,{level:9});
  assert(zlib.gunzipSync(compressed).equals(bytes));
  const target=path.join(archiveRoot,directory,name+'.gz');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed);
  failureFiles.push({directory,name,...audit(file),encoding:'gzip-file',bytes:bytes.length,archive:audit(target)});
 }
}
assert(failureFiles.some(f=>f.directory==='failure-static-transforms')&&failureFiles.some(f=>f.directory==='failure-hierarchy-bindings-and-io'));
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(file),build:runtime.fullEngineBuild,
 regression:audit(regressionFile),summaries,shaderChecks:60,materialTileChecks:14,kernelChecks:121,hierarchyPipelineChecks:4,oracleRejections:54,
 payloadEncoding:'gzip-json-files',payload,failureFiles,
 boundary:'Ordinary static and skeletal assemblies, repeated shared subtrees, authored bone attachments, material remaps, mirrored parts, current/previous motion, page IO and budget recovery are checked. Remaining curves, displacement, material/view policies and complete-scene temporal/performance acceptance remain open.'};
const output=path.join(__dirname,`evidence/nanite-assembly-${stamp}.json`);fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log({pass:true,output,steps:summaries.reduce((n,r)=>n+r.steps,0),frames:summaries.reduce((n,r)=>n+r.frames,0)});
