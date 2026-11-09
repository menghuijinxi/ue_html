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
const browserFile = path.join(__dirname, 'results/nanite-browser/results.json');
const browser = read(browserFile);
assert(browser.pass && browser.errors.length === 0);
assert.deepEqual(verifyStoragePrecache(browser.storagePrecache), browser.storagePrecache.validation);
assert.deepEqual(verifyStoragePrecache(browser.defaultDisabled.storagePrecache, false), browser.defaultDisabled.storagePrecache.validation);
verify(browser.storagePrecache.source);
const storageBaselineFile = path.join(__dirname, 'evidence/nanite-browser-resource-lifetime-20261109.json');
const storageBaseline = read(storageBaselineFile);
const pipelineFailures = lines => ({total:lines.length, compute:lines.filter(l=>l.includes('compute pipeline')).length,
  graphics:lines.filter(l=>l.includes('graphics pipeline')).length});
const storageComparison = {baseline:audit(storageBaselineFile),
  before:pipelineFailures(storageBaseline.browser.startupPipelineFailures),
  after:pipelineFailures(browser.startupPipelineFailures),
  defaultDisabled:pipelineFailures(browser.defaultDisabled.startupPipelineFailures)};
assert(storageComparison.after.compute < storageComparison.before.compute);
const storageFailureFile = path.join(__dirname, 'results/nanite-storage-precache-failure/verified.json');
const storageFailure = read(storageFailureFile);
assert(storageFailure.pass && storageFailure.frames >= 20 && storageFailure.errors.length === 0);
[storageFailure.baseline, storageFailure.package, ...storageFailure.sources].forEach(verify);
assert.equal(storageFailure.baseline.sha256, audit(browserFile).sha256);
assert.equal(storageFailure.observation.failures.length, 1);
assert.equal(storageFailure.observation.rhi.asyncPrecacheFailed, 1);
assert(storageFailure.fallback.some(p => !p.asynchronous && p.dispatches > 0 && p.entry === storageFailure.target.entry));
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
assert.equal(browser.cullDispatches, 100);
assert.equal(browser.sceneCulling.length, 19);
assert.deepEqual(browser.sceneCulling.map(c => c.entries.length), [2,2,2,2,2,1,0,2,0,2,...Array(9).fill(2)]);
assert(browser.sceneCulling.every(c => c.pass && c.rejected === 0 && c.dispatches === c.entries.length));
assert(browser.sceneCulling.every(c => c.raster.pass && c.rasterDraws === c.entries.length));
assert.equal(browser.sceneCulling[0].rasterInputRejections, 8);
browser.sceneCulling.forEach(c=>verify(c.visibilityProduct));
const fixturePage=fs.readFileSync(browser.scene[0].products[0].file);
for(const test of browser.sceneCulling) {
  verify(test.materialProduct);
  const words=p=>{const b=fs.readFileSync(p.file);return Array.from({length:b.length/4},(_,i)=>b.readUInt32LE(i*4));};
  const raw={...test,visibility:words(test.visibilityProduct),materialInputs:words(test.materialProduct)};
  assert.deepEqual(verifyMaterialInputs(raw,fixturePage),test.materialValidation);
}
assert.equal(browser.rasterDraws.length, 33);
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
assert(browser.depthDraws>=20&&browser.totalCullDispatches>100&&browser.totalRasterDraws>33);
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
assert.equal([...browser.residency, ...browser.scene].flatMap(c => c.culling || []).length, 62);
assert.equal([...browser.residency, ...browser.scene].reduce((n, c) => n + (c.cullInputRejections || 0), 0), 88);
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
const supplementFile = path.join(__dirname, 'results/nanite-runtime-shader-supplement/verified.json');
const shaderSupplement = read(supplementFile);
assert(shaderSupplement.pass && shaderSupplement.explicitTypes.length === 28 && shaderSupplement.types.length > 28);
const supplementKeys=new Set(shaderSupplement.permutations.map(p=>p.type+':'+p.permutation));
assert.equal(supplementKeys.size,shaderSupplement.permutations.length);
const missingPermutations=[...fs.readFileSync(shaderSupplement.logs.find(l=>l.file.endsWith('compiler.log')).file,'utf8')
  .matchAll(/WEB_SHADER_MISSING type=(.+) permutation=(\d+)/g)].map(m=>({type:m[1],permutation:Number(m[2])}));
assert.equal(missingPermutations.length,395);
assert(missingPermutations.every(p=>supplementKeys.has(p.type+':'+p.permutation)));
[...shaderSupplement.sources, ...shaderSupplement.shaderInputs, ...shaderSupplement.binaries,
  shaderSupplement.archive, ...shaderSupplement.logs].forEach(verify);
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
const report = {date:new Date().toISOString(), pass:true,
  storagePrecacheComparison:storageComparison,
  storagePrecacheFailure:{report:audit(storageFailureFile),...storageFailure},
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
  historicalShaderAudit:{report:audit(supplementFile), ...shaderSupplement,missingPermutations},
  sceneCook:{...packaged.sceneCook,products:sceneCook.products.length,bytes:sceneCook.totalBytes,
    shaderFailures:sceneCook.shaderFailures,stagedFiles:sceneStage.files.length,stagedBytes:sceneStage.totalBytes,
    map:sceneCook.map,sourceFiles:sceneCook.sourceFiles,hostProducts:sceneCook.hostProducts,
    log:sceneCook.log,skyLightLog:sceneCook.skyLightLog,skyLightCapture:sceneCook.skyLightCapture},
  sources:[__filename, path.join(__dirname, 'build-web-engine.ps1'),
    path.join(__dirname, '../../UE58_WEBGPU_NANITE_IMPLEMENTATION.md')].map(audit),
  boundary:browser.boundary};
const destination = path.join(__dirname, 'evidence/nanite-browser-storage-precache-20261109.json');
const previewDestination = destination.replace(/\.json$/, '.png');
fs.copyFileSync(browser.gbufferPreview.file, previewDestination);
report.gbufferPreview = audit(previewDestination);
for(const test of browser.sceneGBuffer.filter(t=>t.screenshot)) {
  const file=destination.replace(/\.json$/,`-scene-${test.step}.png`);fs.copyFileSync(test.screenshot.file,file);
  (report.sceneScreenshots ||= []).push(audit(file));
}
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({pass:true, destination}));
