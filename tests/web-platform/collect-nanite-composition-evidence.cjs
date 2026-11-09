'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-composition');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const files=['browser.json','browser-scalar.json'].map(f=>path.join(dir,f)),runs=files.map(read);
const packagedFile=path.join(__dirname,'build/nanite-browser/package.json'),packaged=read(packagedFile);
assert(packaged.pass);[...packaged.sources,...packaged.products,packaged.build,packaged.sceneCook.stage,packaged.sceneCook.cook,packaged.sceneCook.inventory].forEach(verify);
const build=read(packaged.build.file);assert(build.pass&&build.fullTargetBuild);build.sources.forEach(verify);build.products.forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
const regressionFile=path.join(__dirname,'results/nanite-browser/results.json'),regression=read(regressionFile);
assert(regression.pass);verify(regression.source);verify(regression.package);
assert.equal(regression.package.sha256,audit(packagedFile).sha256);assert.deepEqual(regression.errors,[]);assert.deepEqual(regression.startupPipelineFailures,[]);
assert.equal(regression.sceneMicroRepeats.length,128);assert.equal(regression.sceneViews.length,10);
for(const p of [regression.storagePrecache,regression.defaultDisabled.storagePrecache]) {
 assert(p.validation.pass);assert.equal(p.rhi.asyncPrecacheFailed,0);assert.equal(p.rhi.asyncPrecacheCompleted,p.rhi.asyncPrecacheRequested);
}
for(const name of ['NaniteWebComposition.cpp','NaniteWebComposition.h','NaniteWebMaterialPass.cpp','NaniteWebScene.cpp','WebNaniteCompositionTest.cpp','WebGPUTransitions.cpp'])
 assert(full.sourceFiles.some(f=>f.file.endsWith(name)),name+' must be included in full build provenance');
for(const [index,r] of runs.entries()) {
 assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packagedFile).sha256);
 assert.equal(r.scalarVisibility,index===1);assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),index===0);
 assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);assert(new Set(r.gpu.shaders).size>=3);
 assert.deepEqual(r.tests.map(t=>t.step),[1,2,3,4,5,6,7,8,9]);
 for(const t of r.tests) {
  assert(t.hasVelocity&&t.validation);assert(t.validation.maxVelocityDepthError<1e-7);
  if(t.step>=6)assert(t.hasLightingChannels);if(t.step===9)assert(t.cameraCut);
 }
}
const summary=r=>({scalarVisibility:r.scalarVisibility,frames:r.frames,shaderPrograms:new Set(r.gpu.shaders).size,
 features:r.gpu.features,steps:r.tests.map(t=>({step:t.step,frame:t.frame,cameraCut:t.cameraCut,hasLightingChannels:t.hasLightingChannels,entries:t.entries,validation:t.validation})),errors:r.errors});
// Preserve all pixel words, compiled WGSL and logs without committing millions
// of repeated zero-valued JSON lines. The payload is lossless and self-contained.
const failures=['failure-stencil-transition-20261110.json'].map(f=>{
 const file=path.join(dir,f),r=read(file);assert(!r.pass);return {artifact:audit(file),failure:r.failure,errors:r.errors};
});
const stencilFile=path.join(__dirname,'results/nanite-canvas-transitions.json'),stencil=read(stencilFile);
assert(stencil.pass&&stencil.checks.length===14&&stencil.checks.every(c=>c.pass));
[...stencil.sources,...stencil.products,stencil.runtime,stencil.log].forEach(verify);
const compilationFile=path.join(__dirname,'results/nanite-composition-shaders/verified.json'),compilation=read(compilationFile);
assert(compilation.pass);[...compilation.sources,compilation.binary,compilation.archive,...compilation.logs].forEach(verify);
const materialFiles=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-materials',f));
const materials=materialFiles.map(read);for(const m of materials){assert(m.pass&&m.tests.length===10);verify(m.source);verify(m.package);assert.deepEqual(m.errors,[]);assert.deepEqual(m.gpu.errors,[]);}
const payloadData={composition:runs,materials};
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(payloadData)),{level:9});
assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),payloadData);
const report={pass:true,date:new Date().toISOString(),sources:[audit(__filename),...files.map(audit)],package:audit(packagedFile),
 build:build.fullEngineBuild,cook:packaged.sceneCook.cook,compilation:audit(compilationFile),stencilTransitions:{artifact:audit(stencilFile),checks:stencil.checks},materials:materialFiles.map(audit),runs:runs.map(summary),failures,
 regression:{artifact:audit(regressionFile),source:regression.source,frames:regression.framesAfter,errors:regression.errors,
  enabledPipelines:regression.storagePrecache.rhi,disabledPipelines:regression.defaultDisabled.storagePrecache.rhi,
  groups:Object.fromEntries(['cases','residency','scene','sceneCulling','sceneDepth','sceneGBuffer','sceneLOD','sceneHZB','sceneInstances','sceneMicroRepeats','sceneViews'].map(k=>[k,regression[k].length]))},
 payloadEncoding:'gzip-base64-json',payloadSchema:'{composition: browser reports, materials: browser reports}',payload:payload.toString('base64'),
 boundary:'Resident rigid opaque native velocity XYZ, real GPUScene history, shading masks, stencil flags and native lighting-channel consumer. Both atomic capabilities, ordinary occlusion, orthographic/mirrored transforms and exact camera-cut frame verified. Deforming geometry, streaming and whole-scene acceptance remain open.'};
const output=path.join(__dirname,'evidence/nanite-native-composition-20261110.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,bytes:fs.statSync(output).size,runs:report.runs.map(r=>({scalarVisibility:r.scalarVisibility,frames:r.frames,shaderPrograms:r.shaderPrograms}))}));
