'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const root=path.resolve(__dirname,'../..'),dir=path.join(__dirname,'results/nanite-streaming');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),packaged=read(packageFile);assert(packaged.pass);
[...packaged.sources,...packaged.products,packaged.build,packaged.native,packaged.hierarchyShaders,packaged.streamingShaders,
 packaged.multiMaterial.native,packaged.multiMaterial.fixture,packaged.sceneCook.stage,packaged.sceneCook.cook,packaged.sceneCook.inventory].forEach(verify);
const build=read(packaged.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
for(const name of ['NaniteStreamingManager.cpp','NaniteWebHierarchy.cpp','NaniteWebRaster.cpp','NaniteWebGBuffer.cpp','NaniteWebComposition.cpp','NaniteWebScene.cpp','WebNaniteStreamingTest.cpp','WebGPUDynamicRHI.cpp'])
 assert(full.sourceFiles.some(f=>f.file.endsWith(name)),name+' full-build provenance');
const cook=read(packaged.sceneCook.cook.file);validateCook(cook,false,{});assert(cook.naniteCookData);
const compile=read(packaged.streamingShaders.file);assert(compile.pass);[...compile.sources,compile.binary,compile.archive,...compile.logs].forEach(verify);
const hierarchy=read(packaged.hierarchyShaders.file);assert(hierarchy.pass);[...hierarchy.sources,...hierarchy.shaderInputs,...hierarchy.compiler,hierarchy.archive,hierarchy.binary,...hierarchy.logs].forEach(verify);
const files=['browser.json','browser-scalar.json'].map(f=>path.join(dir,f)),runs=files.map(read);
for(const [i,r] of runs.entries()){
 assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
 assert.equal(r.scalarVisibility,i===1);assert.equal(r.gpu.features.includes('atomic-vec2u-min-max'),i===0);
 assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);assert.deepEqual(r.tests.map(t=>t.step),[1,2,3,4,5,6,7,8,9]);
 for(const k of ['clear','requests','fixup'])assert(r.gpu.dispatches[k]>0);
 assert.equal(r.ioFailure.failures,1);assert(r.ioFailure.retries>=1);
 assert(r.logs.some(s=>s.includes('Nanite IO request retry succeeded')));
 for(const t of r.tests){assert.equal(t.cullState[1],0);assert.equal(t.poolPages,12);assert(t.validation.covered>30);
  if(t.asset!==1&&t.step>1){assert.equal(t.residentClusters,t.totalClusters);assert.equal(t.validation.ownedPages,11);assert(t.foreignPageState[1]&2);}}
 for(const c of r.comparisons){assert.equal(c.differentCoverage,0);assert.equal(c.maxDepthError,0);}
 assert.notEqual(r.tests[4].runtimeID,r.tests[5].runtimeID);
}
const transitionsFile=path.join(__dirname,'results/nanite-canvas-transitions.json'),transitions=read(transitionsFile);
assert(transitions.pass);[...transitions.sources,...transitions.products,transitions.runtime,transitions.log].forEach(verify);
const nullChecks=read(transitions.runtime.file).checks.filter(c=>c.name.startsWith('null-buffer-'));assert.equal(nullChecks.length,2);assert(nullChecks.every(c=>c.pass));
const regressionFiles=['nanite-browser','nanite-browser-scalar'].map(d=>path.join(__dirname,'results',d,'results.json'));
const regressions=regressionFiles.map(read);
for(const [i,r] of regressions.entries()){
 assert(r.pass&&r.scalarVisibility===(i===1));verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
 assert.deepEqual(r.errors,[]);assert.deepEqual(r.startupPipelineFailures,[]);assert.equal(r.sceneMicroRepeats.length,128);assert.equal(r.sceneViews.length,10);
 for(const p of [r.storagePrecache,r.defaultDisabled.storagePrecache]){assert(p.validation.pass);assert.equal(p.rhi.asyncPrecacheFailed,0);assert.equal(p.rhi.asyncPrecacheCompleted,p.rhi.asyncPrecacheRequested);}
}
const materialFiles=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-materials',f));
const compositionFiles=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-composition',f));
const materials=materialFiles.map(read),composition=compositionFiles.map(read);
for(const r of [...materials,...composition]){assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);}
const fixture=read(path.join(dir,'assets.json'));assert(fixture.pass&&fixture.assets.length===3);
for(const a of fixture.assets){assert.equal(a.triangles,65024);assert.equal(a.clusters,1059);assert(a.dependencies>0);assert.equal(a.pages-a.roots,a.resident?0:11);}
const payloadData={streaming:runs,materials,composition};
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(payloadData)),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),payloadData);
const failed=read(path.join(dir,'failure-reinitialize-index-20261110.json'));assert(!failed.pass&&failed.errors.some(e=>e.includes('Array index out of bounds')));
const report={pass:true,date:new Date().toISOString(),sources:[audit(__filename),...files.map(audit)],package:audit(packageFile),build:build.fullEngineBuild,
 cook:packaged.sceneCook.cook,compilation:packaged.streamingShaders,fixture:{report:audit(path.join(dir,'assets.json')),assets:fixture.assets.map(a=>({...a,source:audit(a.file)})),
  producer:['tests/ue-shader-host/Source/UEShaderHost/Private/WebNaniteStreamingProbe.cpp','tests/web-platform/build-nanite-streaming-fixture.ps1'].map(f=>audit(path.join(root,f)))},
 nullBuffer:{proof:audit(transitionsFile),checks:nullChecks},
 runs:runs.map(r=>({scalarVisibility:r.scalarVisibility,frames:r.frames,features:r.gpu.features,dispatches:r.gpu.dispatches,ioFailure:r.ioFailure,comparisons:r.comparisons,
  tests:r.tests.map(t=>({step:t.step,runtimeID:t.runtimeID,bulkBytes:t.bulkBytes,rootPages:t.rootPages,totalPages:t.totalPages,owners:t.owners,cullState:t.cullState,foreignPageState:t.foreignPageState,history:t.history,io:t.io,validation:t.validation}))})),
 regressions:regressions.map((r,i)=>({artifact:audit(regressionFiles[i]),scalarVisibility:r.scalarVisibility,frames:r.framesAfter,errors:r.errors,enabledPipelines:r.storagePrecache.rhi,disabledPipelines:r.defaultDisabled.storagePrecache.rhi,
  groups:Object.fromEntries(['cases','residency','scene','sceneCulling','sceneDepth','sceneGBuffer','sceneLOD','sceneHZB','sceneInstances','sceneMicroRepeats','sceneViews'].map(k=>[k,r[k].length]))})),
 failure:{artifact:audit(path.join(dir,'failure-reinitialize-index-20261110.json')),failure:failed.failure,errors:failed.errors},
 payloadEncoding:'gzip-base64-json',payloadSchema:'{streaming: browser reports, materials: browser reports, composition: browser reports}',payload:payload.toString('base64'),
 boundary:'Bounded rigid opaque Web Nanite streaming: real cooked bulk IO, GPU feedback, native dependencies/relative-page transcode, LRU eviction, cold/hot CPU cache, retry, resource versioning, pool reset, HZB and page-owner rejection. Both atomic capabilities. Full device recovery, remaining materials/instances and complete-scene acceptance remain open.'};
const output=path.join(__dirname,'evidence/nanite-native-streaming-20261110.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,bytes:fs.statSync(output).size,runs:report.runs.map(r=>({scalarVisibility:r.scalarVisibility,frames:r.frames,dispatches:r.dispatches})),regressions:report.regressions.map(r=>({scalarVisibility:r.scalarVisibility,frames:r.frames}))}));
