'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {PNG}=require('pngjs');
const {audit}=require('./content-file-metadata.cjs'),{validateCook}=require('./cached-cook-validation.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const result=f=>path.join(__dirname,'results',f),dir=result('nanite-full-scene-native');
const packageFile=path.join(__dirname,'build/nanite-full-scene/package.json'),pkg=read(packageFile);assert(pkg.pass&&pkg.fullScene);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.programmableShaders,
  pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory,pkg.sceneConversion].forEach(verify);
validateCook(read(pkg.sceneCook.cook.file),false,{});
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);
[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const compiled=read(build.fullEngineBuild.file);assert(compiled.pass&&compiled.fullLinkVerified);compiled.sourceFiles.forEach(verify);
const historicalFile=path.join(__dirname,'evidence/nanite-local-occlusion-20261110.json'),historical=read(historicalFile);
assert(historical.pass);
const historicalPackage=JSON.parse(zlib.gunzipSync(Buffer.from(historical.payload,'base64'))).packages['nanite-full-scene'].pkg;
for(const key of ['native','hierarchyShaders','streamingShaders','programmableShaders','sceneConversion'])assert.equal(pkg[key].sha256,historicalPackage[key].sha256);
assert.equal(pkg.sceneCook.cook.sha256,historicalPackage.sceneCook.cook.sha256);
for(const item of historicalPackage.sources){if(path.basename(item.file)==='web-engine-worker.js')continue;verify(item);}
assert(compiled.sourceFiles.some(i=>i.file.endsWith('WebNaniteNativeCaptureTest.cpp')),'Capture instrumentation must be in the verified full target');
const nativeFile=path.join(dir,'native-results.json'),native=read(nativeFile);assert(native.pass);
[native.source,native.producer,native.binary,native.input,native.project,native.host,native.hostManifest,native.log,native.build,native.conversion,native.browserSettings,
  ...native.captures.flatMap(c=>[c.image,c.metadata,...c.phases.map(p=>p.image)])].forEach(verify);
const nativeBuild=read(native.build.file);assert(nativeBuild.pass);
[nativeBuild.source,nativeBuild.preparation,nativeBuild.log,nativeBuild.binary,nativeBuild.manifest,nativeBuild.engineManifest].forEach(verify);
assert.equal(read(nativeBuild.manifest.file).BuildId,read(native.hostManifest.file).BuildId);
assert.equal(read(nativeBuild.manifest.file).Modules.NativeNaniteCapture,path.basename(native.binary.file));
const prepared=read(nativeBuild.preparation.file);assert(prepared.pass);
[...prepared.sources,...prepared.generated,...prepared.configs].forEach(verify);
assert.equal(native.binary.sha256,nativeBuild.binary.sha256);
assert.equal(fs.realpathSync(path.join(path.dirname(prepared.project),'Content')),prepared.content);
const conversion=read(native.conversion.file);assert(conversion.pass);
[...conversion.sources,...conversion.originalFiles,...conversion.convertedFiles,conversion.report,conversion.log].forEach(verify);
assert(native.arguments.includes('-sm6')&&native.arguments.includes('-WebNativeNaniteComparison'));
assert(native.arguments.includes('-ini:Engine:[SystemSettings]:r.ScreenPercentage=100'));
assert(native.arguments.includes('-ini:Engine:[SystemSettings]:r.TemporalAA.Debug.OverrideTemporalIndex=0'));
assert(native.arguments.includes('-ini:Engine:[SystemSettings]:r.Test.FreezeTemporalSequences=1'));
assert(native.arguments.includes('-ini:Engine:[SystemSettings]:Slate.bAllowThrottling=0'));
const browserSettings=read(native.browserSettings.file);assert(browserSettings.pass);verify(browserSettings.source);verify(browserSettings.package);
assert(native.arguments.includes('-ini:Engine:[SystemSettings]:r.AntiAliasingMethod='+browserSettings.settings.lighting.antiAliasing));
for(const c of native.captures){assert(c.values.temporalSequencesFrozen&&!c.values.renderTimeFrozen);assert.equal(c.values.materialTime,0);assert.equal(c.phases.length,4);
  for(let phase=0;phase<4;phase++){const last=c.values.stability.filter(s=>s.phase===phase).at(-1);assert(last&&last.stableSamples>=3&&last.meanDifference<.05&&last.pendingTextures===0);
    assert.equal(last.antiAliasingMethod,browserSettings.settings.lighting.antiAliasing);assert(last.realtime&&last.temporalAA);}}
const nativeLog=fs.readFileSync(native.log.file,'utf8');assert(!/Fatal error:|Assertion failed:|Ensure condition failed:/.test(nativeLog));
const runs=[],comparisons=[],images=[];
for(const mode of ['packed','scalar']){
  const run=read(path.join(dir,mode+'.json')),comparison=read(path.join(dir,mode+'-comparison.json'));
  assert(run.pass&&comparison.pass&&run.visualClock.materialTimeFrozen&&!run.visualClock.renderTimeFrozen&&run.visualClock.materialTime===0);assert.equal(run.scalar,mode==='scalar');
  verify(run.source);verify(run.package);assert.equal(run.package.sha256,audit(packageFile).sha256);
  verify(comparison.source);comparison.inputs.forEach(verify);assert.deepEqual(comparison.failures,[]);
  assert.equal(comparison.comparisons.length,156);assert.equal(comparison.contactSheets.length,3);
  assert.equal(run.configs.length,3);for(const config of run.configs){assert(config.text.endsWith('\n[SystemSettings]\nr.Test.FreezeTemporalSequences=1\n'));}
  for(const c of comparison.comparisons)for(const key of ['naniteEffectDifference','webRecreationDifference','nativeRecreationDifference'])
    assert(c[key].mean<5&&c[key].p95<18);
  assert.deepEqual(run.errors,[]);assert.equal(run.views.length,3);
  for(const view of run.views){
    assert.deepEqual(view.gpu.errors,[]);assert.equal(view.gpu.features.includes('atomic-vec2u-min-max'),mode==='packed');
    assert.equal(view.tests.length,3);assert.deepEqual(view.tests[0].view,view.tests[1].view);assert.deepEqual(view.tests[0].view,view.tests[2].view);
    for(const t of view.tests){
      verify(t.image);assert.equal(t.rejected,0);assert.equal(t.rhi.asyncPrecacheFailed||0,0);
      assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);assert(t.performance.frames>=240);
      assert(t.captureWarmupFrames>=600);assert.equal(t.phases.length,4);
      assert.equal(t.streaming.pending,0);assert.equal(t.streaming.residentMips,t.streaming.requestedMips);
      for(let phase=0;phase<4;phase++){const capture=t.phases.find(c=>c.phase===phase);assert(capture);verify(capture.image);
        const last=t.captureChecks.filter(c=>c.phase===phase).at(-1);assert(last&&last.stable>=2&&last.meanDifference<.05);assert(capture.worldTime>0);}
      t.captureChecks.forEach(c=>verify(c.image));
      assert.equal(t.enabled,t.step!==2);if(t.enabled)assert(t.registered>1254&&t.entries>0&&t.materialComplete);else assert.equal(t.entries,0);
    }
  }
  for(const [i,sheet] of comparison.contactSheets.entries()){
    verify(sheet);const file=path.join(__dirname,`evidence/nanite-full-scene-native-20261110-${mode}-${i}.png`);
    fs.copyFileSync(sheet.file,file);images.push(audit(file));
  }
  runs.push(run);comparisons.push(comparison);
}
const failureDir=path.join(dir,'failure-temporal-index'),failure=read(path.join(failureDir,'packed.json'));
assert.equal(failure.pass,false);assert(failure.failure.includes('jitterX'));
const failureSources=[path.join(failureDir,'probe-nanite-full-scene-native.cjs'),path.join(failureDir,'nanite-full-native-packed-driver.log'),
  result('nanite-native-capture-prepare-failure.cjs'),result('nanite-native-capture-prepare-failure.log'),
  result('nanite-native-capture-pointer-failure.cpp'),result('nanite-native-capture-pointer-failure.log')].map(file=>({file:audit(file),text:fs.readFileSync(file,'utf8')}));
const missingManifestDir=path.join(dir,'failure-missing-module-manifest');
const missingManifestFailure=fs.readdirSync(missingManifestDir).map(name=>{const file=path.join(missingManifestDir,name);return {file:audit(file),text:fs.readFileSync(file,'utf8')};});
assert(missingManifestFailure.some(f=>f.text.includes("The game module 'NativeNaniteCapture' could not be found")));
const unstableDir=path.join(dir,'failure-image-stability');
const unstable={};for(const file of ['packed.json','scalar.json','native-results.json','packed-comparison.json','scalar-comparison.json'])unstable[file]=read(path.join(unstableDir,file));
assert(!unstable['packed-comparison.json'].pass&&!unstable['scalar-comparison.json'].pass);
// These reports intentionally describe the failed capture, whose original output paths
// are reused by the corrected run. Verify the preserved copies against their old hashes.
const unstableImages=[];
for(const mode of ['packed','scalar']){
  for(const view of unstable[mode+'.json'].views)for(const test of view.tests){
    const archived=audit(path.join(unstableDir,path.basename(test.image.file)));
    assert.equal(archived.sha256,test.image.sha256);unstableImages.push(archived);
  }
}
for(const capture of unstable['native-results.json'].captures){
  for(const original of [capture.image,capture.metadata]){
    const archived=audit(path.join(unstableDir,path.basename(original.file)));
    assert.equal(archived.sha256,original.sha256);unstableImages.push(archived);
  }
}
for(const mode of ['packed','scalar'])for(const sheet of unstable[mode+'-comparison.json'].contactSheets){
  const archived=audit(path.join(unstableDir,path.basename(sheet.file)));
  assert.equal(archived.sha256,sheet.sha256);unstableImages.push(archived);
}
const stabilityDiagnostics=[];
for(const mode of ['normal','frozen-sequences','no-ao-jitter','no-ao']){
  const diagnosticDir=result('nanite-full-scene-stability/'+mode),report=read(path.join(diagnosticDir,'report.json'));
  assert(report.pass);assert.deepEqual(report.errors,[]);report.samples.forEach(s=>verify(s.image));
  const source=path.join(diagnosticDir,'probe-source.cjs');assert.equal(audit(source).sha256,report.source.sha256);
  stabilityDiagnostics.push({mode,report,source:{file:audit(source),text:fs.readFileSync(source,'utf8')}});
}
const phaseFailureDir=path.join(dir,'failure-phase-aligned'),phaseFailures={};
for(const file of ['packed-comparison.json','scalar-comparison.json']){
  const item=read(path.join(phaseFailureDir,file));assert(!item.pass&&item.failures.length===35);phaseFailures[file]=item;
}
const fxaaFailureDir=path.join(dir,'failure-native-fxaa'),fxaaFailure=read(path.join(fxaaFailureDir,'native-results.json'));
assert(fxaaFailure.captures.every(c=>c.values.stability.every(s=>s.antiAliasingMethod===1&&s.jitterX===0&&s.jitterY===0)));
const archivedFXAASource=path.join(fxaaFailureDir,'WebNativeComparison.cpp');assert.equal(audit(archivedFXAASource).sha256,fxaaFailure.producer.sha256);
const fxaaSources=['WebNativeComparison.cpp','capture-nanite-full-scene-native.ps1','probe-nanite-native-settings.cjs'].map(name=>{
  const file=path.join(fxaaFailureDir,name);return {file:audit(file),text:fs.readFileSync(file,'utf8')};});
const slateFailureDir=path.join(dir,'failure-slate-throttling');
const slateFailure=['native.log','native-results.json','native-0-1.png.json','capture-nanite-full-scene-native.ps1','nanite-native-tsr-capture-driver.log'].map(name=>{
  const file=path.join(slateFailureDir,name);return {file:audit(file),text:fs.readFileSync(file,'utf8')};});
assert(slateFailure.some(f=>f.text.includes('actual native anti-aliasing method and projection')));
const nonRealtimeDir=path.join(dir,'failure-non-realtime-view');
const nonRealtimeFailure=['native.log','native-results.json','native-0-1.png.json','WebNativeComparison.cpp','capture-nanite-full-scene-native.ps1','nanite-native-tsr-flags-capture-driver.log'].map(name=>{
  const file=path.join(nonRealtimeDir,name);return {file:audit(file),text:fs.readFileSync(file,'utf8')};});
const nonRealtimeMetadata=read(path.join(nonRealtimeDir,'native-0-1.png.json'));
assert(nonRealtimeMetadata.stability.every(s=>s.antiAliasingMethod===1&&!s.realtime&&s.temporalAA&&s.antiAliasingCVar===4));
const textureFailureDir=path.join(dir,'failure-tsr-texture'),textureFailures={};
for(const mode of ['packed','scalar']){
  const comparison=read(path.join(textureFailureDir,mode+'-comparison.json'));
  assert(!comparison.pass&&comparison.failures.length===11);textureFailures[mode]=comparison;
  for(const item of comparison.inputs){
    const file=path.join(textureFailureDir,path.basename(item.file));
    assert.equal(audit(file).sha256,item.sha256,'Preserved failed comparison input: '+file);
  }
}
const textureDiagnostics=[];
for(const mode of ['1','0.5','fine','coarse','bias-minus-one','no-pom','streaming','hidden-scale']){
  const directory=result('nanite-texture-derivatives/'+mode),run=read(path.join(directory,'packed.json'));
  assert(run.pass);assert.deepEqual(run.errors,[]);assert.equal(run.views.length,1);
  const source=path.join(directory,'source.cjs');assert.equal(audit(source).sha256,run.source.sha256);
  for(const t of run.views[0].tests){verify(t.image);t.captureChecks.forEach(c=>verify(c.image));}
  run.shaders.forEach(s=>verify(s.source));
  textureDiagnostics.push({mode,run,source:{file:audit(source),text:fs.readFileSync(source,'utf8')}});
}
const nativeTextureDirectory=result('nanite-native-material-diagnostic');
const nativeTextureDiagnostic=read(path.join(nativeTextureDirectory,'native-results.json'));assert(nativeTextureDiagnostic.pass);
nativeTextureDiagnostic.captures.forEach(c=>[c.image,c.metadata,...c.phases.map(p=>p.image)].forEach(verify));
assert.equal(audit(path.join(nativeTextureDirectory,'WebNativeComparison-textures.cpp')).sha256,nativeTextureDiagnostic.producer.sha256);
const baselineTexture=textureDiagnostics.find(d=>d.mode==='1').run;
const hiddenTexture=textureDiagnostics.find(d=>d.mode==='hidden-scale').run;
const textureSheet=new PNG({width:640,height:480});
const textureFiles=[baselineTexture.views[0].tests[0].image.file,hiddenTexture.views[0].tests[0].image.file,
  path.join(textureFailureDir,'native-1-1-phase0.png'),path.join(textureFailureDir,'native-1-2-phase0.png')];
textureFiles.forEach((file,i)=>PNG.bitblt(PNG.sync.read(fs.readFileSync(file)),textureSheet,0,480,320,240,i%2*320,Math.floor(i/2)*240));
const textureSheetFile=path.join(__dirname,'evidence/nanite-full-scene-native-20261110-texture-diagnostic.png');
fs.writeFileSync(textureSheetFile,PNG.sync.write(textureSheet));images.push(audit(textureSheetFile));
const payload={package:pkg,native,nativeBuild,prepared,conversion,runs,comparisons,failure,failureSources,missingManifestFailure,unstable,unstableImages,
  stabilityDiagnostics,phaseFailures,fxaaFailure,fxaaSources,slateFailure,nonRealtimeFailure,browserSettings,
  textureFailures,textureDiagnostics,nativeTextureDiagnostic,
  textureDiagnosticOrder:['Frozen family time: Web Nanite','Diagnostic hidden mip reduction disabled: Web Nanite','Native Nanite','Native fallback']};
const compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
  historicalEvidence:audit(historicalFile),nativeBuild:native.build,images,
  native:native.captures.map(c=>({view:c.values.view,assets:c.values.naniteAssetComponents,naniteProxies:c.values.naniteSceneProxies,
    projectionX:c.values.projectionX,projectionY:c.values.projectionY})),
  runs:runs.map((r,i)=>({scalar:r.scalar,frames:r.views.reduce((n,v)=>n+v.frames,0),steps:r.views.reduce((n,v)=>n+v.tests.length,0),
    comparisons:comparisons[i].comparisons})),payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Native SM6 and both Web atomic paths use the original converted Villa scene, three effective projections, frozen material expressions/general sampling and temporal AA index zero. Actual TSR, projection jitter and material mip bias match. World/render clocks continue, preserving texture visibility and streaming. All four independently recorded AO phases retain AO jitter and active histories. Nanite on/off/restoration differences satisfy the existing mean 5/P95 18 thresholds across the whole image and all 12 tiles for every phase; absolute platform differences remain separately reported. Native capture is an editor viewport, not standalone performance acceptance. Deformation and the other tracker requirements remain open.'};
const file=path.join(__dirname,'evidence/nanite-full-scene-native-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,runs:report.runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.steps})),native:report.native}));
