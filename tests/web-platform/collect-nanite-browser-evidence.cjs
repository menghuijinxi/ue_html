'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const assert = require('node:assert/strict');
const {audit} = require('./content-file-metadata.cjs');
const verifyDepth = require('./verify-nanite-depth-output.cjs');
const verifyMaterialInputs = require('./verify-nanite-material-inputs.cjs');
const verifyGBuffer = require('./verify-nanite-gbuffer-output.cjs');
const verifyTiles = require('./verify-nanite-material-tiles.cjs');
const verifyMultiAsset = require('./verify-nanite-multimaterial-asset.cjs');
const {verifyStoragePrecache} = require('./observe-storage-precache.cjs');
const {validateCook} = require('./cached-cook-validation.cjs');
const read = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const verify = i => assert.equal(audit(i.file).sha256, i.sha256, `Stale file: ${i.file}`);
const scalarVisibility = process.argv.includes('--scalar-visibility');
const rasterPhases = scalarVisibility ? 2 : 1;
const packedBrowserFile = path.join(__dirname, 'results/nanite-browser/results.json');
const browserFile = scalarVisibility ? path.join(__dirname, 'results/nanite-browser-scalar/results.json') : packedBrowserFile;
const browser = read(browserFile);
assert(browser.pass && browser.errors.length === 0);
assert.equal(browser.scalarVisibility,scalarVisibility);assert.equal(browser.rasterPhases,rasterPhases);
assert.equal(browser.features.includes('atomic-vec2u-min-max'),!scalarVisibility);
const scalarFile=path.join(__dirname,'results/nanite-scalar-visibility/verified.json'),scalar=read(scalarFile);
assert(scalar.pass&&scalar.candidates===8199&&scalar.results.length===9&&scalar.results.every(r=>r.pass&&r.guards));
assert.deepEqual(scalar.errors,[]);assert(!scalar.features.includes('atomic-vec2u-min-max'));
[scalar.source,...scalar.sources,...scalar.tools,...scalar.products].forEach(verify);
const scalarInitFailureFile=path.join(__dirname,'results/nanite-scalar-initialization-failure.json');
const scalarInitFailure=read(scalarInitFailureFile);
assert(!scalarInitFailure.pass);[scalarInitFailure.log,scalarInitFailure.build,scalarInitFailure.source].forEach(verify);
assert(read(scalarInitFailure.build.file).inputs.some(i=>i.sha256===scalarInitFailure.source.sha256));
assert.deepEqual(verifyStoragePrecache(browser.storagePrecache), browser.storagePrecache.validation);
assert.deepEqual(verifyStoragePrecache(browser.defaultDisabled.storagePrecache, false), browser.defaultDisabled.storagePrecache.validation);
verify(browser.storagePrecache.source);
const storageBaselineFile = path.join(__dirname, 'evidence/nanite-browser-storage-precache-20261109.json');
const storageBaseline = read(storageBaselineFile);
const pipelineFailures = lines => ({total:lines.length, compute:lines.filter(l=>l.includes('compute pipeline')).length,
  graphics:lines.filter(l=>l.includes('graphics pipeline')).length});
const storageComparison = {baseline:audit(storageBaselineFile),
  before:pipelineFailures(storageBaseline.browser.startupPipelineFailures),
  after:pipelineFailures(browser.startupPipelineFailures),
  defaultDisabled:pipelineFailures(browser.defaultDisabled.startupPipelineFailures)};
assert.equal(storageComparison.after.total, 0);
assert.equal(storageComparison.defaultDisabled.total, 0);
for (const observation of [browser.storagePrecache, browser.defaultDisabled.storagePrecache]) {
  assert.equal(observation.rhi.asyncPrecacheRequested, observation.rhi.asyncPrecacheCompleted);
  assert(observation.rhi.asyncPrecacheRequested > 2000 && observation.rhi.precachedGraphicsPipelines > 0);
  assert.equal(observation.rhi.asyncPrecacheFailed, 0);
  assert.equal(observation.rhi.unsupportedPrecacheRequests, 0);
}
const storageFailureFile = path.join(__dirname, 'results/nanite-storage-precache-failure/verified.json');
const storageFailure = read(storageFailureFile);
assert(storageFailure.pass && storageFailure.frames >= 20 && storageFailure.errors.length === 0);
[storageFailure.baseline, storageFailure.package, ...storageFailure.sources].forEach(verify);
assert.equal(storageFailure.baseline.sha256, audit(packedBrowserFile).sha256);
assert.equal(storageFailure.package.sha256,browser.package.sha256);
assert.equal(storageFailure.observation.failures.length, 1);
assert.equal(storageFailure.observation.rhi.asyncPrecacheFailed, 1);
assert(storageFailure.fallback.some(p => !p.asynchronous && p.dispatches > 0 && p.entry === storageFailure.target.entry));
const lateFile = path.join(__dirname, 'results/nanite-storage-precache-late/verified.json'), late = read(lateFile);
assert(late.pass && late.frames >= 60 && late.errors.length === 0);
[late.baseline, late.package, ...late.sources].forEach(verify);
assert.equal(late.baseline.sha256, audit(packedBrowserFile).sha256);
assert.equal(late.package.sha256,browser.package.sha256);
assert.equal(late.observation.injected, 1);
assert.deepEqual(late.observation.failures, []);
assert(late.runtimeFirst.length > 0 && late.precachedAfter.length > 0);
const lateFailureFile = path.join(__dirname, 'results/nanite-browser/failure-late-storage-precache-20261109.json');
const lateFailure = read(lateFailureFile);
assert(!lateFailure.pass && lateFailure.storagePrecache.rhi.storageFormatPrecachedUsed === 0);
const lateFailurePackageFile=path.join(__dirname,'results/nanite-browser/failure-late-storage-precache-package-20261109.json');
const lateFailureBuildFile=path.join(__dirname,'results/nanite-browser/failure-late-storage-precache-build-20261109.json');
assert.equal(audit(lateFailurePackageFile).sha256,lateFailure.package.sha256);
assert.equal(audit(lateFailureBuildFile).sha256,read(lateFailurePackageFile).build.sha256);
const placeholderFile = path.join(__dirname, 'results/nanite-browser/failure-placeholder-precache-20261109.json');
const placeholder = read(placeholderFile);
assert(!placeholder.pass && placeholder.failure.includes('must reuse a completed format variant'));
assert.equal(placeholder.storagePrecache.rhi.storageFormatPrecached, 9);
assert.equal(placeholder.storagePrecache.rhi.storageFormatPrecachedUsed, 0);
const placeholderPackageFile = path.join(__dirname,'results/nanite-browser/failure-placeholder-precache-package-20261109.json');
const placeholderBuildFile = path.join(__dirname,'results/nanite-browser/failure-placeholder-precache-build-20261109.json');
assert.equal(audit(placeholderPackageFile).sha256, placeholder.package.sha256);
assert.equal(audit(placeholderBuildFile).sha256, read(placeholderPackageFile).build.sha256);
assert.deepEqual(browser.cases.map(c => c.dispatches), [2,2,3,4]);
for (const test of browser.cases) {assert(test.pass && test.guards); test.pages.forEach(verify);}
assert.deepEqual(browser.residency.map(c => c.dispatches), [2,2,2,0]);
assert.deepEqual(browser.residency.map(c => c.active.length), [1,2,2,0]);
assert(browser.residency[0].rejectedStreaming && browser.residency[2].rejectedBudget && browser.residency[3].cancelledPending);
for (const test of browser.residency) {assert(test.pass); test.products.forEach(verify);}
assert.deepEqual(browser.scene.map(c => c.dispatches), [2,0,0,2,0]);
assert.deepEqual(browser.scene.map(c => c.proxies), [2,1,0,2,0]);
assert(browser.defaultDisabled.pass && browser.defaultDisabled.transcodeDispatches === 0);
for (const test of browser.scene) {assert(test.pass); test.products.forEach(verify);}
assert.equal(browser.cullDispatches, 114);
assert.equal(browser.sceneCulling.length, 19);
assert.deepEqual(browser.sceneCulling.map(c => c.entries.length), [2,2,2,2,2,1,0,2,0,2,...Array(9).fill(2)]);
assert(browser.sceneCulling.every(c => c.pass && c.rejected === 0 && c.dispatches === c.entries.length));
assert(browser.sceneCulling.every(c => c.raster.pass && c.rasterDraws === c.entries.length*rasterPhases));
assert.equal(browser.sceneCulling[0].rasterInputRejections, 8);
browser.sceneCulling.forEach(c=>verify(c.visibilityProduct));
const fixturePage=fs.readFileSync(browser.scene[0].products[0].file);
for(const test of browser.sceneCulling) {
  verify(test.materialProduct);
  const words=p=>{const b=fs.readFileSync(p.file);return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
  const raw={...test,visibility:words(test.visibilityProduct),materialInputs:words(test.materialProduct)};
  assert.deepEqual(verifyMaterialInputs(raw,fixturePage),test.materialValidation);
}
const verifyLOD = require('./verify-nanite-scene-lod.cjs');
const verifyHZB = require('./verify-nanite-scene-hzb.cjs');
assert.equal(browser.sceneHZB.length,9);verify(browser.hzbOracle);
assert(browser.sceneHZBCleanup.pass&&browser.sceneHZBCleanup.framesObserved>=4);
for(const test of browser.sceneHZB) {
  const raw={...test};for(const [key,p] of Object.entries(test.products)) {
    verify(p);const b=fs.readFileSync(p.file);raw[key]=Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
  }
  assert.deepEqual(verifyHZB(raw),test.validation);
}
const hzbKernelFile=path.join(__dirname,'results/nanite-hzb/verified.json'),hzbKernel=read(hzbKernelFile);
assert(hzbKernel.pass&&hzbKernel.cases===12005&&hzbKernel.mips===9&&hzbKernel.rejected>1000);
assert.deepEqual(hzbKernel.errors,[]);[...hzbKernel.sources,...hzbKernel.tools,...hzbKernel.products].forEach(verify);
const hzbBindingsFile=path.join(__dirname,'results/nanite-hzb-bindings.json'),hzbBindings=read(hzbBindingsFile);
assert(hzbBindings.pass&&hzbBindings.cases.length===3&&hzbBindings.cases.every(c=>c.pass&&c.maxError<=1/16777215));
[hzbBindings.source,...hzbBindings.sources,...hzbBindings.inputs].forEach(verify);
const occlusionFile=path.join(__dirname,'results/nanite-occlusion.json'),occlusion=read(occlusionFile);
assert(occlusion.pass&&occlusion.results.length===10&&occlusion.results.every(c=>c.pass));
assert.deepEqual(occlusion.errors,[]);assert(!occlusion.features.includes('atomic-vec2u-min-max'));
[occlusion.source,...occlusion.sources,...occlusion.inputs].forEach(verify);
const hzbFailureFile=path.join(__dirname,'results/nanite-scene-hzb/failure-depth-sample-type-20261109.json');
const hzbFailure=read(hzbFailureFile),hzbFailurePackage=hzbFailureFile.replace('.json','-package.json'),hzbFailureBuild=hzbFailureFile.replace('.json','-build.json');
assert(!hzbFailure.pass&&hzbFailure.engineFailure.failure.includes('UnfilterableFloat|Depth'));
assert.equal(audit(hzbFailurePackage).sha256,hzbFailure.package.sha256);
assert.equal(audit(hzbFailureBuild).sha256,read(hzbFailurePackage).build.sha256);
assert(browser.sceneLOD.length === 10 && browser.sceneLODCleanup.pass && browser.sceneLODCleanup.framesObserved >= 4);
[browser.lodOracle,browser.lodReference].forEach(verify);
const lodHierarchy=fs.readFileSync(browser.scene[0].products.find(p=>path.basename(p.file).startsWith('scene-hierarchy-')).file);
const lodFixture=read(path.dirname(browser.package.file)+'/package.json');
const lodPrecision=read(lodFixture.browserOracle.file).asset.positionPrecision;
for(const test of browser.sceneLOD) {
  assert(test.pass);const raw={...test};
  for(const [key,p] of Object.entries(test.products)) {verify(p);const b=fs.readFileSync(p.file);raw[key]=Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));}
  assert.deepEqual(verifyLOD(raw,fixturePage,lodHierarchy,browser.sceneCulling,lodPrecision),test.validation);
  assert.deepEqual(verifyMaterialInputs(raw,fixturePage),test.materialValidation);
}
assert.equal(browser.sceneInstances.length,13);verify(browser.instancesOracle);
assert(browser.sceneInstancesCleanup.pass&&browser.sceneInstancesCleanup.framesObserved>=4);
const instanceTriangles=fs.readFileSync(lodFixture.sourceTriangles.file);
for(const test of browser.sceneInstances) {
  const raw={...test};for(const [key,p] of Object.entries(test.products)) {
    verify(p);const b=fs.readFileSync(p.file);raw[key]=Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
  }
  assert.deepEqual(require('./verify-nanite-instances.cjs')(raw,fixturePage,instanceTriangles,lodPrecision),test.validation);
}
assert.equal(browser.sceneViews.length,10);verify(browser.viewsOracle);
assert(browser.sceneViewsCleanup.pass&&browser.sceneViewsCleanup.framesObserved>=4);
for(const test of browser.sceneViews) {
  const raw={...test};for(const [key,p] of Object.entries(test.products)) {
    verify(p);const b=fs.readFileSync(p.file);raw[key]=Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));
  }
  assert.deepEqual(require('./verify-nanite-views.cjs')(raw,fixturePage,instanceTriangles,lodPrecision),test.validation);
}
const lodProjectionFile=path.join(__dirname,'results/nanite-lod-projection/verified.json'),lodProjection=read(lodProjectionFile);
assert(lodProjection.pass && lodProjection.cases === 3255);
[lodProjection.source, ...lodProjection.sources, ...lodProjection.tools, ...lodProjection.products].forEach(verify);
assert.deepEqual(lodProjection.errors, []);
assert.equal(browser.rasterDraws.length, 33*rasterPhases);
assert.equal(browser.rasterShaders.length, scalarVisibility ? 3 : 2);
if(scalarVisibility) browser.rasterShaders.forEach(shader=>assert(!fs.readFileSync(shader.file,'utf8').includes('atomic<vec2<u32>>')));
assert.equal(browser.recordDispatches,33);assert.equal(browser.materialDispatches,33);
assert.equal(browser.defaultDisabled.rasterDraws, 0);
assert.equal(browser.defaultDisabled.cullDispatches, 0);
assert.equal(browser.defaultDisabled.depthDraws,0);
assert.equal(browser.defaultDisabled.recordDispatches,0);assert.equal(browser.defaultDisabled.materialDispatches,0);
assert.equal(browser.sceneDepth.length,5);
assert.deepEqual(browser.sceneDepth.map(c=>c.step),[20,21,22,23,24]);
for(const test of browser.sceneDepth) {
  assert(test.pass&&test.validation.pass&&test.depthDraws>=4&&test.sharedVisibilityRecords);
  const raw={...test};
  test.products.forEach((p,i)=>{verify(p);const b=fs.readFileSync(p.file);raw[i?'after':'before']=Array.from({length:b.length/4},(_,j)=>b.readUInt32LE(j*4));});
  assert.deepEqual(verifyDepth(raw),test.validation);
}
assert(browser.depthDraws>=20&&browser.totalCullDispatches>114&&browser.totalRasterDraws>33);
assert(browser.sceneDepthCleanup.pass&&browser.sceneDepthCleanup.framesObserved>=4);
assert.equal(browser.sceneGBuffer.length,26);assert.equal(browser.defaultDisabled.gbufferDraws,0);
assert.equal(browser.defaultDisabled.gbufferIndirectDraws,0);assert.equal(browser.defaultDisabled.tileDispatches,0);
assert(browser.sceneGBufferCleanup.pass&&browser.sceneGBufferCleanup.framesObserved>=4);
assert.equal(browser.sceneGBufferCleanup.gbuffer,browser.sceneGBufferCleanup.indirect);
assert.equal(browser.sceneGBufferCleanup.tiles,browser.sceneGBufferCleanup.indirect+2);
assert.equal(browser.gbufferShaders.length,4);
assert.deepEqual([...new Set(browser.gbufferShaderCreations)].sort(),browser.gbufferShaders.map(s=>s.sha256).sort());
const packaged = read(browser.package.file);
const multi=packaged.multiMaterial;Object.values(multi).forEach(verify);
const multiPage=fs.readFileSync(multi.gpuPage.file);
assert.deepEqual(verifyMultiAsset(multiPage,fs.readFileSync(multi.sourceTriangles.file),fs.readFileSync(multi.sourceMaterials.file)),browser.multiAssetValidation);
const multiFixture=read(multi.fixture.file),multiNative=read(multi.native.file),multiBrowser=read(multi.browserOracle.file);
assert(multiFixture.pass&&multiNative.pass&&multiBrowser.pass);
assert.equal(multiNative.policyChecks,21);assert.equal(multiNative.products.length,12);
assert(multiNative.products.every(p=>p.sha256===multi.gpuPage.sha256));
[...multiFixture.sources,...multiFixture.products,multiFixture.binary,...multiNative.sources,...multiNative.products,
  ...multiNative.build.inputs,multiNative.build.binary,multiNative.build.log,multiNative.runtimeShaderArchive,
  ...multiNative.generated.sources,...multiNative.generated.generated,...multiBrowser.sources].forEach(verify);
assert(multiBrowser.browsers.every(b=>b.gpuPageSha256===multi.gpuPage.sha256));
for(const test of browser.sceneGBuffer) {
  assert(test.pass&&test.validation.pass);const raw={...test,materialTiles:structuredClone(test.materialTiles)};
  for(const [key,p] of Object.entries(test.products)) {verify(p);const b=fs.readFileSync(p.file);raw[key]=Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));}
  if(test.screenshot) verify(test.screenshot);
  raw.materialTiles.forEach((bin,index)=>{bin.tiles=raw[`tiles${index}`];if(bin.offsetRect)bin.offsetTiles=raw[`offsetTiles${index}`];});
  assert.deepEqual(verifyGBuffer(raw,test.step>=13?multiPage:fixturePage),test.validation);
  assert.deepEqual(verifyTiles(raw,test.step>=13?multiPage:fixturePage),test.tileValidation);
  if(test.step>=7&&test.step<=10) assert.equal(verifyGBuffer.verifyTextureMutations(raw,fixturePage),test.textureReferenceRejections);
}
assert.equal([...browser.residency, ...browser.scene].flatMap(c => c.culling || []).length, 76);
assert.equal([...browser.residency, ...browser.scene].reduce((n, c) => n + (c.cullInputRejections || 0), 0), 152);
[browser.source, browser.cullOracle, browser.sceneCullOracle, browser.rasterOracle, browser.depthOracle, browser.materialOracle, browser.gbufferOracle,browser.tilesOracle,browser.multiAssetOracle,browser.package,
  ...browser.shaders, ...browser.cullShaders, ...browser.rasterShaders, ...browser.depthShaders, ...browser.materialShaders,
  ...browser.gbufferShaders,browser.visibilityPreview, browser.depthPreview, browser.materialPreview,browser.gbufferPreview].forEach(verify);
assert(packaged.pass);
const packageInputs = [...packaged.sources, ...packaged.products, ...packaged.baseline,
  packaged.build, packaged.native, packaged.archive, packaged.hierarchyShaders, packaged.browserOracle, packaged.cookedResource, packaged.sourceTriangles];
packageInputs.forEach(verify);
assert.equal(packaged.sceneCook.supplementApplied, false);
assert.equal(packaged.sceneCook.hierarchyArchiveApplied, false);
[packaged.sceneCook.stage, packaged.sceneCook.cook, packaged.sceneCook.inventory].forEach(verify);
const sceneStage = read(packaged.sceneCook.stage.file), sceneCook = read(packaged.sceneCook.cook.file);
assert(sceneStage.pass && sceneStage.useProjectSettings && sceneCook.exitCode === 0 && !sceneCook.disabledSkyLight);
assert.deepEqual(sceneCook.shaderFailures, []);
[...sceneStage.sourceFiles, sceneStage.pack, sceneStage.manifest, sceneStage.configBundle,
  sceneCook.log, sceneCook.skyLightLog, sceneCook.skyLightCapture].forEach(verify);
validateCook(sceneCook, false, {});
const hierarchyShaders = read(packaged.hierarchyShaders.file);
assert(hierarchyShaders.pass);
[...hierarchyShaders.sources, ...hierarchyShaders.shaderInputs, ...hierarchyShaders.compiler,
  hierarchyShaders.archive, hierarchyShaders.binary, ...hierarchyShaders.logs].forEach(verify);
// Retain the old missing-permutation investigation as historical evidence.
// It was not applied to this package. Current Cook/shader provenance is checked
// above; the historical source and DLL hashes belong to the archived revision.
const historicalSupplement = storageBaseline.historicalShaderAudit;
const shaderSupplement = historicalSupplement;
assert(shaderSupplement.pass && shaderSupplement.explicitTypes.length === 28 && shaderSupplement.types.length > 28);
const supplementKeys=new Set(shaderSupplement.permutations.map(p=>p.type+':'+p.permutation));
assert.equal(supplementKeys.size,shaderSupplement.permutations.length);
const missingPermutations = historicalSupplement.missingPermutations;
assert.equal(missingPermutations.length,395);
assert(missingPermutations.every(p=>supplementKeys.has(p.type+':'+p.permutation)));
const build = read(packaged.build.file);
let fullTargetValidation = null;
assert(build.pass && (build.incrementalDiagnostic || build.fullTargetBuild) && !build.fullRebuild);
[...build.sources, ...build.linkInputs, ...build.products, build.log,
  ...build.compiled.flatMap(c => [...c.inputs, c.object, c.log])].forEach(verify);
if(build.fullTargetBuild) {
  verify(build.fullEngineBuild);const full=read(build.fullEngineBuild.file);
  assert(full.pass&&full.fullLinkVerified);
  [...full.sourceFiles,...full.products,full.linkResponse,full.log,...full.objects.flatMap(o=>[o.object,o.response,o.definitions,o.source]),
    ...full.platformCopies.flatMap(c=>[c.source,c.copied])].forEach(verify);
  [full.compileExecution,full.exportedActions].forEach(verify);
  const execution=read(full.compileExecution.file),actions=read(full.exportedActions.file);
  assert(execution.pass&&execution.results.every(r=>r.code===0));
  const normalize=f=>path.resolve(f).toLowerCase();
  const rebuilt=new Set(actions.Actions.filter(a=>a.Type==='Compile'&&execution.results.some(r=>r.id===a.Id&&r.code===0))
    .flatMap(a=>a.ProducedItems).map(normalize));
  // This new test object did not exist during the original RHI header rebuild.
  const hzbTestBuildFile=path.join(__dirname,'results/web-engine-nanite-hzb-test-build-results.json');
  const hzbTestBuild=read(hzbTestBuildFile);assert(hzbTestBuild.pass&&hzbTestBuild.fullLinkVerified);
  [hzbTestBuild.compileExecution,hzbTestBuild.exportedActions,hzbTestBuild.log].forEach(verify);
  const hzbTestSources=hzbTestBuild.sourceFiles.filter(i=>/[\\/]WebNaniteHZBTest\.cpp$|[\\/]RHIResources\.h$|[\\/]NaniteWeb(?:Hierarchy|Scene)\.h$/.test(i.file));
  assert(hzbTestSources.some(i=>i.file.endsWith('WebNaniteHZBTest.cpp')));hzbTestSources.forEach(verify);
  const hzbTestExecution=read(hzbTestBuild.compileExecution.file),hzbTestActions=read(hzbTestBuild.exportedActions.file);
  assert(hzbTestExecution.pass&&hzbTestExecution.results.every(r=>r.code===0));
  const hzbTestObjects=hzbTestBuild.objects.filter(o=>o.source.file.endsWith('WebNaniteHZBTest.cpp'));
  assert.equal(hzbTestObjects.length,1);hzbTestObjects.forEach(o=>verify(o.object));
  for(const a of hzbTestActions.Actions.filter(a=>a.Type==='Compile'&&hzbTestExecution.results.some(r=>r.id===a.Id&&r.code===0)))
    a.ProducedItems.forEach(f=>rebuilt.add(normalize(f)));
  assert(rebuilt.has(normalize(hzbTestObjects[0].object.file)));
  const instancesBuildFile=path.join(__dirname,'results/web-engine-nanite-instances-build-results.json');
  const instancesBuild=read(instancesBuildFile);assert(instancesBuild.pass&&instancesBuild.fullLinkVerified);
  [instancesBuild.compileExecution,instancesBuild.exportedActions,instancesBuild.log].forEach(verify);
  const instancesSources=instancesBuild.sourceFiles.filter(i=>/[\\/]WebNaniteInstancesTest\.cpp$|[\\/]RHIResources\.h$|[\\/]NaniteWeb(?:Hierarchy|Scene)\.h$/.test(i.file));
  assert(instancesSources.some(i=>i.file.endsWith('WebNaniteInstancesTest.cpp')));instancesSources.forEach(verify);
  const instancesExecution=read(instancesBuild.compileExecution.file),instancesActions=read(instancesBuild.exportedActions.file);
  assert(instancesExecution.pass&&instancesExecution.results.every(r=>r.code===0));
  const instancesObjects=instancesBuild.objects.filter(o=>o.source.file.endsWith('WebNaniteInstancesTest.cpp'));
  assert.equal(instancesObjects.length,1);instancesObjects.forEach(o=>verify(o.object));
  for(const a of instancesActions.Actions.filter(a=>a.Type==='Compile'&&instancesExecution.results.some(r=>r.id===a.Id&&r.code===0)))
    a.ProducedItems.forEach(f=>rebuilt.add(normalize(f)));
  assert(rebuilt.has(normalize(instancesObjects[0].object.file)));
  const viewsBuildFile=path.join(__dirname,'results/web-engine-nanite-views-build-results.json');
  const viewsBuild=read(viewsBuildFile);assert(viewsBuild.pass&&viewsBuild.fullLinkVerified);
  [viewsBuild.compileExecution,viewsBuild.exportedActions,viewsBuild.log].forEach(verify);
  const viewsSources=viewsBuild.sourceFiles.filter(i=>/[\\/]WebNaniteViewsTest\.cpp$|[\\/]RHIResources\.h$|[\\/]NaniteWeb(?:Hierarchy|Scene)\.h$/.test(i.file));
  assert(viewsSources.some(i=>i.file.endsWith('WebNaniteViewsTest.cpp')));viewsSources.forEach(verify);
  const viewsExecution=read(viewsBuild.compileExecution.file),viewsActions=read(viewsBuild.exportedActions.file);
  assert(viewsExecution.pass&&viewsExecution.results.every(r=>r.code===0));
  const viewsObjects=viewsBuild.objects.filter(o=>o.source.file.endsWith('WebNaniteViewsTest.cpp'));
  assert.equal(viewsObjects.length,1);viewsObjects.forEach(o=>verify(o.object));
  for(const a of viewsActions.Actions.filter(a=>a.Type==='Compile'&&viewsExecution.results.some(r=>r.id===a.Id&&r.code===0)))
    a.ProducedItems.forEach(f=>rebuilt.add(normalize(f)));
  assert(rebuilt.has(normalize(viewsObjects[0].object.file)));


  const lodLayoutFile=path.join(__dirname,'results/web-engine-nanite-lod-layout-build-results.json'),lodLayout=read(lodLayoutFile);
  assert(lodLayout.pass && lodLayout.fullLinkVerified);
  [lodLayout.compileExecution,lodLayout.exportedActions,lodLayout.log].forEach(verify);
  const lodHeaders=lodLayout.sourceFiles.filter(i=>/[\\/]NaniteWeb(?:Hierarchy|Scene)\.h$/.test(i.file));
  assert.equal(lodHeaders.length,4);lodHeaders.forEach(verify);
  const lodExecution=read(lodLayout.compileExecution.file),lodActions=read(lodLayout.exportedActions.file);
  assert(lodExecution.pass && lodExecution.results.every(r=>r.code===0));
  const lodRebuilt=new Set(rebuilt);
  for(const action of lodActions.Actions.filter(a=>a.Type==='Compile' && lodExecution.results.some(r=>r.id===a.Id&&r.code===0)))
    action.ProducedItems.forEach(f=>lodRebuilt.add(normalize(f)));
  const lodDependents = full.objects.filter(o=>fs.existsSync(o.object.file+'.d') &&
    /\/Rendering\/NaniteWeb(?:Hierarchy|Scene)\.h/.test(fs.readFileSync(o.object.file+'.d','utf8').replaceAll('\\','/')));
  assert(lodDependents.length > 0 && lodDependents.every(o=>lodRebuilt.has(normalize(o.object.file))),
    'LOD layout changes require every dependent object to be rebuilt');
  // Later full-target builds may only recompile a driver fix. Retain the initial
  // header rebuild's action proof and require the identical RHI protocol.
  const headerFile=path.join(__dirname,'results/web-engine-rhi-lifetime-full-build-results.json');
  const headerBuild=read(headerFile);
  assert(headerBuild.pass&&headerBuild.fullLinkVerified);
  [headerBuild.compileExecution,headerBuild.exportedActions,headerBuild.log].forEach(verify);
  const headerSources=headerBuild.sourceFiles.filter(i=>/[\\/]RHIResources\.(h|cpp)$/.test(i.file));
  assert.equal(headerSources.length,4);headerSources.forEach(verify);
  const headerExecution=read(headerBuild.compileExecution.file),headerActions=read(headerBuild.exportedActions.file);
  assert(headerExecution.pass&&headerExecution.results.every(r=>r.code===0));
  for(const action of headerActions.Actions.filter(a=>a.Type==='Compile'&&headerExecution.results.some(r=>r.id===a.Id&&r.code===0)))
    action.ProducedItems.forEach(f=>rebuilt.add(normalize(f)));
  const dependentInputs=full.objects.filter(o=>fs.existsSync(o.object.file+'.d')&&
    fs.readFileSync(o.object.file+'.d','utf8').replaceAll('\\','/').includes('/RHIResources.h'));
  assert(dependentInputs.length>0&&dependentInputs.every(o=>rebuilt.has(normalize(o.object.file))),
    'this RHI header regression must use rebuilt dependent objects');
  fullTargetValidation={compileExecution:full.compileExecution,exportedActions:full.exportedActions,
    compiledActions:execution.results.length,linkedObjects:full.objects.length,
    hzbTestBuild:{report:audit(hzbTestBuildFile),compileExecution:hzbTestBuild.compileExecution,
      exportedActions:hzbTestBuild.exportedActions,sources:hzbTestSources,objects:hzbTestObjects.map(o=>o.object)},
    lodLayoutRebuild:{report:audit(lodLayoutFile),compileExecution:lodLayout.compileExecution,
      exportedActions:lodLayout.exportedActions,sourceFiles:lodHeaders,dependentObjects:lodDependents.length,
      compileLogs:lodExecution.results.flatMap(r=>r.attempts.map(a=>audit(a.log)))},
    headerRebuild:{report:audit(headerFile),compileExecution:headerBuild.compileExecution,exportedActions:headerBuild.exportedActions,
      compiledActions:headerExecution.results.length,sourceFiles:headerSources,
      compileLogs:headerExecution.results.flatMap(r=>r.attempts.map(a=>audit(a.log)))},
    rhiDependentObjects:dependentInputs.length,dependencies:dependentInputs.map(o=>audit(o.object.file+'.d')),
    compileLogs:execution.results.flatMap(r=>r.attempts.map(a=>audit(a.log)))};
}
const native = read(packaged.native.file);
assert(native.pass && native.policyChecks === 21 && native.products.length === 12);
[...native.sources, ...native.products, ...native.build.inputs, native.build.binary,
  native.build.log, native.runtimeShaderArchive, native.browserOracle,
  ...native.generated.sources, ...native.generated.generated].forEach(verify);
assert.equal(native.runtimeShaderArchive.sha256, packaged.archive.sha256);
const oracle = read(packaged.browserOracle.file);
assert(oracle.pass && oracle.asset.webCookEnabled); oracle.sources.forEach(verify);
for (const b of oracle.browsers) for (const test of browser.cases)
  for (const page of test.pages) assert.equal(page.sha256, b.gpuPageSha256);
const {logs, ...browserSummary} = browser;
const canvasFile=path.join(__dirname,'results/nanite-canvas-transitions.json'),canvas=read(canvasFile);
assert(canvas.pass&&canvas.checks.length===8&&canvas.checks.every(c=>c.pass));
[canvas.runtime,canvas.log,...canvas.sources,...canvas.products].forEach(verify);
const interruptedFile=path.join(__dirname,'evidence/nanite-browser-uniform-buffer-failure-20261109.json');
const interrupted=read(interruptedFile);assert.equal(interrupted.pass,false);
verify(interrupted.rawReport);
const previousFile=path.join(__dirname,'evidence/nanite-browser-material-bins-20261109.json'),previous=read(previousFile);
assert(interrupted.runtime.every(r=>previous.package.products.some(p=>p.sha256===r.sha256)),'historical failed runtime must match its archived evidence');
const shadowFailureFile=path.join(__dirname,'results/nanite-browser/failure-shadow-dummy-20261109.json');
const shadowPackageFile=path.join(__dirname,'results/nanite-browser/failure-shadow-dummy-package-20261109.json');
const shadowBuildFile=path.join(__dirname,'results/nanite-browser/failure-shadow-dummy-build-20261109.json');
const shadowFailure=read(shadowFailureFile),shadowPackage=read(shadowPackageFile),shadowBuild=read(shadowBuildFile);
assert.equal(shadowFailure.pass,false);
assert(shadowFailure.errors.some(e=>e.includes('texture=Dummy-OutDepthBuffer')&&e.includes('atomicMips=0')));
assert.equal(audit(shadowPackageFile).sha256,shadowFailure.package.sha256);
assert.equal(audit(shadowBuildFile).sha256,shadowPackage.build.sha256);
const shadowDummyCreation=browser.logs.find(l=>l.includes('P3_TEXTURE_CREATE name=Dummy-OutDepthBuffer'));
assert(shadowDummyCreation && (BigInt(/flags=(0x[0-9a-f]+)/i.exec(shadowDummyCreation)[1]) & (1n<<33n)),
  'the successful browser must allocate the shadow dummy with AtomicCompatible');
const lifetimeFile=path.join(__dirname,'results/rhi-resource-lifetime/verified.json'),lifetime=read(lifetimeFile);
assert(lifetime.pass&&lifetime.variants.length===4);lifetime.sources.forEach(verify);
for(const variant of lifetime.variants) {
  [...variant.inputs,variant.generated,variant.compileLog,variant.runLog,...variant.products].forEach(verify);
  assert.equal(variant.fixed,variant.variant.startsWith('web-fixed'));
  for(const key of ['releaseTouchedDeleted','lostDelete','deletedLive'])assert.equal(variant[key],!variant.fixed);
}
const motionFile=path.join(__dirname,'results/nanite-motion-blur-shaders/verified.json'),motion=read(motionFile);
assert(motion.pass&&motion.cases.length===4&&motion.cases.every(c=>c.pass));
[...motion.sources,motion.compiler,motion.log,motion.archive,...motion.compiled.flatMap(c=>[c.input,c.wgsl])].forEach(verify);
assert.deepEqual([...new Set(motion.cases.map(c=>c.format))].sort(),['rg11b10ufloat','rgba32float']);
const motionFailureFile=path.join(__dirname,'results/nanite-browser/failure-orthographic-motion-blur-20261109.json');
const motionFailure=read(motionFailureFile);
assert.equal(motionFailure.pass,false);
assert(motionFailure.errors.some(e=>e.includes('OutVelocityFlatTexture')&&e.includes('shaderFormat=8 textureFormat=1')));
const coverageFile=path.join(__dirname,'results/nanite-browser/failure-gbuffer-sample-coverage-20261109.json');
const coverageFailure=read(coverageFile),coverageStep=coverageFailure.sceneGBuffer.find(s=>s.step===23);
assert(!coverageFailure.pass&&coverageFailure.errors.length===0&&coverageStep.validationFailure.includes('assert(count>5)'));
const coveragePackageFile=path.join(__dirname,'results/nanite-browser/failure-gbuffer-sample-package-20261109.json');
const coverageBuildFile=path.join(__dirname,'results/nanite-browser/failure-gbuffer-sample-build-20261109.json');
assert.equal(audit(coveragePackageFile).sha256,coverageFailure.package.sha256);
assert.equal(audit(coverageBuildFile).sha256,read(coveragePackageFile).build.sha256);
const coverageRaw={...coverageStep,materialTiles:structuredClone(coverageStep.materialTiles)},coverageInputs=[];
for(const [key,p] of Object.entries(coverageStep.products)) {
  const archived=path.join(__dirname,'results/nanite-browser/failure-gbuffer-sample-coverage',path.basename(p.file));
  const input=audit(archived);assert.equal(input.sha256,p.sha256);coverageInputs.push(input);
  const bytes=fs.readFileSync(archived);coverageRaw[key]=Array.from({length:bytes.length/4},(_,i)=>bytes.readUInt32LE(i*4));
}
coverageRaw.materialTiles.forEach((bin,i)=>bin.tiles=coverageRaw['tiles'+i]);
const coverageTiles=verifyTiles(coverageRaw,multiPage),coverageCounts={};
for(let i=0;i<coverageRaw.before.length/28;++i) {
  const id=coverageRaw.before[i*28];if(!id||coverageRaw.before[i*28+1]!==coverageRaw.before[i*28+2])continue;
  const slot=(id>>>8)-1,entry=coverageRaw.entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);
  const key=entry.component+'/'+coverageRaw.materialInputs[i*16+2];coverageCounts[key]=(coverageCounts[key]||0)+1;
}
assert.equal(coverageCounts['1/63'],5);
const precisionFile=path.join(__dirname,'results/nanite-material-precision/verified.json'),precision=read(precisionFile);
assert(precision.pass&&precision.oldBitExact&&precision.validation.pass&&precision.validation.covered===105);
[...precision.inputs,...precision.sources,...precision.products,precision.hierarchy].forEach(verify);
assert.deepEqual(precision.tolerances,{position:1/512,normal:1/25600,uv:.000008,color:.000001});
const startupFile = path.join(__dirname, 'results/nanite-pipeline-startup/results.json'), startup = read(startupFile);
assert(startup.pass && !startup.oldCookDiagnostic && startup.errors.length === 0);
[startup.source, startup.package].forEach(verify);
assert.equal(startup.package.sha256, browser.package.sha256);
assert.deepEqual(startup.failures, []);
assert.deepEqual(startup.rejections, []);
assert.equal(startup.state.rhi.asyncPrecacheRequested, startup.state.rhi.asyncPrecacheCompleted);
assert(startup.state.rhi.asyncPrecacheRequested > 2000 && startup.state.rhi.precachedGraphicsPipelines > 0);
assert.equal(startup.state.rhi.asyncPrecacheFailed, 0);
assert.equal(startup.state.rhi.unsupportedPrecacheRequests, 0);
assert.equal(startup.distanceFieldAtlas.format, 'PF_R32_FLOAT');
assert(startup.distanceFieldAtlas.bytes > 0);
const topologyFile = path.join(__dirname, 'results/nanite-topology/verified.json'), topology = read(topologyFile);
assert(topology.pass && topology.cases.length === 24 && topology.cases.every(c => c.pass));
assert(topology.vertexFormats.length === 7 && topology.vertexFormats.every(c => c.pass));
assert(topology.bundlesCreated >= 8 && topology.bundleHits >= 8);
[topology.source, topology.build, topology.runtime, topology.log].forEach(verify);
const topologyBuild = read(topology.build.file);
[...topologyBuild.inputs, topologyBuild.binary, topologyBuild.log].forEach(verify);
const colorSpaceFile=path.join(__dirname,'results/nanite-color-space/verified.json'),colorSpace=read(colorSpaceFile);
assert(colorSpace.pass&&colorSpace.cases.length===60&&colorSpace.cases.every(c=>c.pass));
[colorSpace.source,colorSpace.build,colorSpace.runtime,colorSpace.log].forEach(verify);
assert.equal(colorSpace.build.sha256,topology.build.sha256);
const gatherFile = path.join(__dirname, 'results/nanite-depth-gather/verified.json'), gather = read(gatherFile);
assert(gather.pass && gather.cases.length === 2 && gather.cases.every(c => c.maxError < 1e-6));
[gather.source, ...gather.shaderSources].forEach(verify);
const quantizationFile = path.join(__dirname, 'results/nanite-distance-field-quantization/verified.json'), quantization = read(quantizationFile);
assert(quantization.pass && quantization.samples === 4096 && quantization.levelMismatches === 0);
assert(quantization.maxError <= 1/255 + 1e-7 && quantization.maxUpdateError < 1e-6);
[quantization.source, ...quantization.sources].forEach(verify);
const storageCompatFile = path.join(__dirname, 'results/nanite-storage-compat-shaders/verified.json'), storageCompat = read(storageCompatFile);
assert(storageCompat.pass && storageCompat.cases.length === 70 && storageCompat.cases.every(c => c.pass));
[storageCompat.source, ...storageCompat.inputs, ...storageCompat.sources].forEach(verify);
const registrationFailureFile = path.join(__dirname, 'results/nanite-browser/failure-reregister-20261109.json');
const registrationFailure = read(registrationFailureFile);
const failedRegistration = registrationFailure.sceneCulling.find(c => c.step === 8);
const restoredRegistration = browser.sceneCulling.find(c => c.step === 8);
assert(!registrationFailure.pass && failedRegistration.entries.length === 1 && failedRegistration.validationFailure);
assert(restoredRegistration.pass && restoredRegistration.entries.length === 2 && restoredRegistration.pendingPSOsAtCapture === 0);
const staleLODFile=path.join(__dirname,'results/nanite-browser/failure-lod-stale-object-20261109.json');
const staleLOD=read(staleLODFile);
const staleLODPackage=path.join(__dirname,'results/nanite-browser/failure-lod-stale-object-package-20261109.json');
const staleLODBuild=path.join(__dirname,'results/nanite-browser/failure-lod-stale-object-build-20261109.json');
assert(!staleLOD.pass && staleLOD.failure.includes('BadView'));
assert.equal(audit(staleLODPackage).sha256,staleLOD.package.sha256);
assert.equal(audit(staleLODBuild).sha256,read(staleLODPackage).build.sha256);
const instanceFailureFile=path.join(__dirname,'results/nanite-instances/failure-ownerless-reregister-20261109.json');
const instanceFailure=read(instanceFailureFile),instanceFailurePackage=instanceFailureFile.replace('.json','-package.json'),instanceFailureBuild=instanceFailureFile.replace('.json','-build.json');
assert(!instanceFailure.pass&&instanceFailure.tests.length===5&&instanceFailure.logs.some(l=>l.includes('Ensure condition failed: MyOwnerWorld')));
assert.equal(audit(instanceFailurePackage).sha256,instanceFailure.package.sha256);
assert.equal(audit(instanceFailureBuild).sha256,read(instanceFailurePackage).build.sha256);
const captureFailureFile=path.join(__dirname,'results/nanite-views/failure-capture-rpc-20261109.json');
const captureFailure=read(captureFailureFile),captureFailurePackage=captureFailureFile.replace('.json','-package.json'),captureFailureBuild=captureFailureFile.replace('.json','-build.json');
assert(!captureFailure.pass&&captureFailure.tests.length===0&&captureFailure.logs.some(l=>l.includes('ValidateTextureInitialization')));
assert.equal(audit(captureFailurePackage).sha256,captureFailure.package.sha256);
assert.equal(audit(captureFailureBuild).sha256,read(captureFailurePackage).build.sha256);
const orthoFailureFile=path.join(__dirname,'results/nanite-views/failure-ortho-cull-20261109.json');
const orthoFailure=read(orthoFailureFile),orthoFailurePackage=orthoFailureFile.replace('.json','-package.json'),orthoFailureBuild=orthoFailureFile.replace('.json','-build.json');
assert(!orthoFailure.pass&&orthoFailure.tests.length===6&&orthoFailure.tests.at(-1).entries.every(e=>e.state[0]===8));
assert.equal(audit(orthoFailurePackage).sha256,orthoFailure.package.sha256);
assert.equal(audit(orthoFailureBuild).sha256,read(orthoFailurePackage).build.sha256);
const report = {date:new Date().toISOString(), pass:true,
  orthographicPlanes:{failureReport:audit(orthoFailureFile),failurePackage:audit(orthoFailurePackage),failureBuild:audit(orthoFailureBuild),
    verifiedSteps:browser.sceneViews.length},
  captureColorSpace:{report:audit(colorSpaceFile),...colorSpace,
    failureReport:audit(captureFailureFile),failurePackage:audit(captureFailurePackage),failureBuild:audit(captureFailureBuild)},
  instanceReregistration:{failureReport:audit(instanceFailureFile),failurePackage:audit(instanceFailurePackage),failureBuild:audit(instanceFailureBuild),
    failedAtStep:6,verifiedSteps:browser.sceneInstances.length,componentLifecycleFixed:true},
  residentHZB:{kernel:{report:audit(hzbKernelFile),...hzbKernel},bindings:{report:audit(hzbBindingsFile),...hzbBindings},
    occlusion:{report:audit(occlusionFile),...occlusion},
    depthBindingFailure:{report:audit(hzbFailureFile),package:audit(hzbFailurePackage),build:audit(hzbFailureBuild),...hzbFailure.engineFailure}},
  scalarVisibility:{selected:scalarVisibility,phases:rasterPhases,helperReport:audit(scalarFile),...scalar,
    initializationFailure:{report:audit(scalarInitFailureFile),...scalarInitFailure}},
  residentLOD:{projectionReport:audit(lodProjectionFile),...lodProjection,
    staleObjectFailure:{report:audit(staleLODFile),package:audit(staleLODPackage),build:audit(staleLODBuild),failure:staleLOD.failure}},
  componentPrecacheSynchronization:{failedRun:audit(registrationFailureFile), historicalPackage:registrationFailure.package,
    before:{registered:failedRegistration.registered, components:failedRegistration.entries.map(e=>e.component), failure:failedRegistration.validationFailure},
    after:{registered:restoredRegistration.registered, pendingPSOsAtCapture:restoredRegistration.pendingPSOsAtCapture,
      pendingPSOFrames:restoredRegistration.pendingPSOFrames, maximumPendingPSOs:restoredRegistration.maximumPendingPSOs},
    source:audit(path.join(__dirname,'../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteSceneCullTest.cpp'))},
  startupPipelines:{report:audit(startupFile), state:startup.state, failures:startup.failures, rejections:startup.rejections,
    distanceFieldAtlas:startup.distanceFieldAtlas},
  vertexTopology:{report:audit(topologyFile), ...topology},
  depthGather:{report:audit(gatherFile), ...gather},
  distanceFieldQuantization:{report:audit(quantizationFile), ...quantization},
  storageCompatibility:{report:audit(storageCompatFile), ...storageCompat},
  storagePrecacheComparison:storageComparison,
  storagePrecacheFailure:{report:audit(storageFailureFile),...storageFailure},
  storagePrecacheLate:{report:audit(lateFile),...late,failedRun:audit(lateFailureFile),
    failedPackage:audit(lateFailurePackageFile),failedBuild:audit(lateFailureBuildFile)},
  storagePlaceholderFailure:{report:audit(placeholderFile),package:audit(placeholderPackageFile),build:audit(placeholderBuildFile),
    rhi:placeholder.storagePrecache.rhi, failure:placeholder.failure,
    motionVariants:placeholder.storagePrecache.pipelines.filter(p=>p.formats.some(f=>f.name==='OutVelocityFlatTexture'))},
  resourceLifetime:{report:audit(lifetimeFile),...lifetime},
  motionBlurStorage:{report:audit(motionFile),...motion,failedRun:audit(motionFailureFile),failure:motionFailure.errors},
  materialPrecision:{report:audit(precisionFile),...precision},
  sampleCoverage:{failedRun:audit(coverageFile),failedPackage:audit(coveragePackageFile),failedBuild:audit(coverageBuildFile),
    inputs:coverageInputs,bySlot:coverageCounts,fullResolutionTiles:coverageTiles,
    fixture:audit(path.join(__dirname,'../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteGBufferTest.cpp')),
    boundary:'Moved the rear fixture laterally from 70 to 90 while retaining partial overlap and the original per-slot sample threshold. Pixel and tile acceptance tolerances are unchanged.'},
  fullTargetValidation,
  interruptedRun:{report:audit(interruptedFile),historicalEvidence:audit(previousFile),...interrupted},
  shadowDummy:{failedRun:audit(shadowFailureFile),failedPackage:audit(shadowPackageFile),failedBuild:audit(shadowBuildFile),
    errors:shadowFailure.errors,failedRuntime:shadowBuild.products,successfulCreation:shadowDummyCreation},
  canvasTransitions:{report:audit(canvasFile),...canvas},
  multiMaterial:{fixture:multiFixture,native:multiNative,browser:multiBrowser,validation:browser.multiAssetValidation},
  referenceCommit:cp.execFileSync('git', ['-C', path.join(__dirname, '../../reference-engine'), 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  browser:{...browserSummary, logReport:audit(browserFile)},
  package:packaged, build:{report:packaged.build, incrementalDiagnostic:build.incrementalDiagnostic,fullTargetBuild:!!build.fullTargetBuild,fullRebuild:false,
    ...(build.fullEngineBuild?{fullEngineBuild:build.fullEngineBuild}:{}),
    compiled:build.compiled, sources:build.sources, products:build.products, log:build.log,
    preservedLinkInputs:build.linkInputs.length},
  native:{report:packaged.native, policyChecks:native.policyChecks, modes:native.modes,
    products:native.products, runtimeShaderArchive:native.runtimeShaderArchive},
  hierarchyShaders:{report:packaged.hierarchyShaders, ...hierarchyShaders},
  historicalShaderAudit:{...shaderSupplement, archivedEvidence:audit(storageBaselineFile), missingPermutations},
  sceneCook:{...packaged.sceneCook,products:sceneCook.products.length,bytes:sceneCook.totalBytes,
    shaderFailures:sceneCook.shaderFailures,stagedFiles:sceneStage.files.length,stagedBytes:sceneStage.totalBytes,
    map:sceneCook.map,sourceFiles:sceneCook.sourceFiles,hostProducts:sceneCook.hostProducts,
    log:sceneCook.log,skyLightLog:sceneCook.skyLightLog,skyLightCapture:sceneCook.skyLightCapture},
  sources:[__filename, path.join(__dirname, 'build-web-engine.ps1'),
    path.join(__dirname, '../../UE58_WEBGPU_NANITE_IMPLEMENTATION.md')].map(audit),
  boundary:browser.boundary};
const destination = path.join(__dirname, `evidence/nanite-browser-instances-${scalarVisibility?'fallback':'packed'}-20261109.json`);
const previewDestination = destination.replace(/\.json$/, '.png');
fs.copyFileSync(browser.gbufferPreview.file, previewDestination);
report.gbufferPreview = audit(previewDestination);
for(const test of browser.sceneGBuffer.filter(t=>t.screenshot)) {
  const file=destination.replace(/\.json$/,`-scene-${test.step}.png`);fs.copyFileSync(test.screenshot.file,file);
  (report.sceneScreenshots ||= []).push(audit(file));
}
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, destination}));
