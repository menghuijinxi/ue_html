'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const dir=path.join(__dirname,'results/nanite-automatic-scene'),pkgFile=path.join(__dirname,'build/nanite-default-scene/package.json'),pkg=read(pkgFile);
assert(pkg.pass&&pkg.defaultScene);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
const cook=read(pkg.sceneCook.cook.file);assert(cook.pass&&cook.naniteCookData);cook.sourceFiles.forEach(verify);verify(cook.defaultSamples);verify(cook.templateMap);
const native=read(path.join(dir,'native-results.json'));assert(native.pass);
[native.source,native.producer,native.binary,native.input,native.profile,native.host,native.log,...native.captures.flatMap(c=>[c.image,c.metadata])].forEach(verify);
assert.deepEqual(native.captures.map(c=>c.values.naniteSamples),[8,0]);
const runs=[],comparisons=[],images=[];
for(const mode of ['packed','scalar']){
  const run=read(path.join(dir,mode+'.json')),comparison=read(path.join(dir,mode+'-native-comparison-results.json'));
  assert(run.pass&&comparison.pass&&run.visualClock.renderTimeFrozen);verify(run.source);verify(run.package);assert.equal(run.package.sha256,audit(pkgFile).sha256);
  verify(comparison.source);comparison.inputs.forEach(verify);verify(comparison.contactSheet);assert.equal(comparison.comparisons.length,9);
  assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);assert.equal(run.tests.length,8);
  for(const t of run.tests){verify(t.image);assert.equal(t.rejected,0);assert.equal(t.rhi.asyncPrecacheFailed,0);assert.equal(t.rhi.asyncPrecacheCompleted,t.rhi.asyncPrecacheRequested);}
  runs.push(run);comparisons.push(comparison);
  const file=path.join(__dirname,'evidence',`nanite-default-native-20261110-${mode}.png`);fs.copyFileSync(comparison.contactSheet.file,file);images.push(audit(file));
}
const failures=['failure-projection-comparison.json','failure-projection-native.json','failure-uninitialized-projection.json'].map(f=>({artifact:audit(path.join(dir,f)),value:read(path.join(dir,f))}));
assert.equal(failures[0].value.pass,false);assert.equal(failures[2].value.projectionX,1);
const payload={runs,comparisons,native,failures},compressed=zlib.gzipSync(JSON.stringify(payload),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(compressed)),payload);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(pkgFile),build:build.fullEngineBuild,cook:pkg.sceneCook.cook,
  projection:runs[0].tests[0].view,requestedCamera:runs[0].samples.camera,
  native:{source:native.producer,binary:native.binary,arguments:native.arguments,samples:native.captures.map(c=>({nanite:c.values.naniteSamples,projectionX:c.values.projectionX,projectionY:c.values.projectionY}))},
  runs:runs.map((r,i)=>({scalar:r.scalar,frames:r.frames,steps:r.tests.length,comparisons:comparisons[i].comparisons})),images,
  resolvedFailures:failures.map(f=>f.artifact),payloadEncoding:'gzip-base64-json',payload:compressed.toString('base64'),
  boundary:'Original default-template lights and sky, eight real materials, verified native SM6 Nanite proxies, matching effective projection. Nanite-induced changes are tested against thresholds; absolute platform shading and sky differences are explicitly recorded. This is not full-scene performance or remaining material/instance acceptance.'};
const file=path.join(__dirname,'evidence/nanite-default-native-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,file,frames:runs.map(r=>r.frames)}));
