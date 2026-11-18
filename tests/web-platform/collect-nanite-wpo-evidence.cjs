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
assert.equal(shader.cases.length,32);assert.equal(shader.cases.filter(c=>c.frequency==='vertex').length,8);
for(const c of shader.cases)assert(c.preprocessed&&c.compiled&&c.errors.length===0);
const runs=[],regressions=[];
function check(run,scalar,steps){
  assert(run.pass);assert.equal(run.scalar??run.scalarVisibility,scalar);verify(run.source);verify(run.package);
  assert.equal(run.package.sha256,audit(packageFile).sha256);assert.equal(run.tests.length,steps);
  assert.deepEqual(run.errors,[]);assert.deepEqual(run.gpu.errors,[]);
  assert.equal(run.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  for(const t of run.tests){assert(t.validation);if(t.image)verify(t.image);}
  if(run.rhi){assert.equal(run.rhi.asyncPrecacheCompleted,run.rhi.asyncPrecacheRequested);assert.equal(run.rhi.asyncPrecacheFailed||0,0);}
}
for(const scalar of [false,true]){
  const suffix=scalar?'-scalar':'',run=read(path.join(__dirname,`results/nanite-wpo/browser${suffix}.json`));
  check(run,scalar,36);verify(run.geometry);assert.deepEqual(run.validationFailures,[]);
  for(const t of run.tests){
    assert.equal(t.rejected,0);assert(t.validation.compared>200);
    assert(t.validation.maxDepthResidual<(t.perspective?1e-7:1.2e-7));
    assert(t.validation.subpixelChecks<t.validation.compared*.05);
    if(t.step===3||t.step>=30){
      assert(t.validation.moving>20);assert(t.validation.maxVelocityDepthTolerance<=3*2**-24);
      assert(t.validation.maxVelocityDepthError<t.validation.maxVelocityDepthTolerance);
    }
  }
  runs.push(run);
  for(const [suite,steps] of [['wpo-streaming',9],['programmable',52],['materials',10],['composition',9],['composition-unmerged',9],['streaming',9]]){
    const r=read(path.join(__dirname,`results/nanite-${suite.replace('-unmerged','')}/browser${suffix}${suite.endsWith('-unmerged')?'-unmerged':''}.json`));check(r,scalar,steps);
    if(suite.startsWith('composition'))assert.equal(r.unmerged,suite.endsWith('-unmerged'));
    if(suite==='wpo-streaming'){
      verify(r.geometryDecoder);
      assert(r.wpo);assert.equal(r.comparisons.length,6);assert.equal(r.ioFailure.failures,1);assert(r.ioFailure.retries>=1);
      for(const t of r.tests){assert(t.evaluateWPO&&t.hasVelocity);if(!t.cameraCut)assert(t.validation.velocity.samples>30);}
    }
    regressions.push({suite,scalar,run:r});
  }
}
const kernels=['nanite-occlusion.json','nanite-local-occlusion-kernel.json'].map(f=>read(path.join(__dirname,'results',f)));
for(const r of kernels){assert(r.pass);assert.equal(r.results.length,26);assert.deepEqual(r.errors,[]);[r.source,...r.sources,...r.inputs].forEach(verify);}
const oracle=read(path.join(__dirname,'results/nanite-wpo/oracle-rejection.json'));
assert(oracle.pass);assert.equal(oracle.checks.length,9);[oracle.source,oracle.verifier,oracle.input].forEach(verify);
assert.equal(oracle.streamingChecks.length,3);[oracle.streamingVerifier,oracle.streamingInput,oracle.geometryDecoder].forEach(verify);
const failures=[];
const binsDirectory=path.join(__dirname,'results/nanite-wpo/failure-composition-bins');
const binsFailure=read(path.join(binsDirectory,'browser.json'));
assert(!binsFailure.pass&&binsFailure.tests.length===1&&/1 !== 3/.test(binsFailure.failure));
failures.push({name:'composition-obsolete-bin-uniqueness',run:binsFailure,
  verifier:fs.readFileSync(path.join(binsDirectory,'probe-nanite-composition.cjs'),'utf8'),
  package:read(path.join(binsDirectory,'package.json'))});
const quotaDirectory=path.join(__dirname,'results/nanite-wpo/failure-storage-quota');
const quotaFailure=read(path.join(quotaDirectory,'browser.json'));
assert(!quotaFailure.pass&&quotaFailure.tests.length===0&&/storage quota/.test(quotaFailure.failure));
failures.push({name:'startup-storage-quota',run:quotaFailure,
  worker:fs.readFileSync(path.join(quotaDirectory,'web-content-worker.js'),'utf8'),
  package:read(path.join(quotaDirectory,'package.json'))});
const localIO=read(path.join(__dirname,'results/web-local-io-edge-results.json'));
assert(localIO.pass);localIO.sourceFiles.forEach(verify);
const quota=read(path.join(__dirname,'results/web-local-quota-edge.json'));
assert(quota.pass);assert.equal(quota.cases.length,6);quota.sources.forEach(verify);verify(quota.fixture);
const storage={localIO,quota};
for(const name of ['failure-material-tile-flags','failure-distance-always-ortho','failure-stale-test-object','failure-motion-depth','failure-edgeon-samples']){
  const directory=path.join(__dirname,'results/nanite-wpo',name),run=read(path.join(directory,'browser.json'));assert(!run.pass);
  failures.push({name,run,source:fs.readFileSync(path.join(directory,'probe-nanite-wpo.cjs'),'utf8'),
    package:read(path.join(directory,'package.json')),build:read(path.join(directory,'build.json'))});
}
const rotated=read(path.join(__dirname,'results/nanite-wpo/failure-rotated-bounds.json'));
assert(!rotated.pass);assert(rotated.checks.some(c=>c.failures.length>0));failures.push(rotated);
const vectorFile=path.join(__dirname,'results/web-engine-full-thread-20261110-132125.log');
const vectorLog=fs.readFileSync(vectorFile,'utf8');assert(vectorLog.includes('error:')&&vectorLog.includes('NaniteWebScene'));
failures.push({name:'vector-conversion',file:audit(vectorFile),log:vectorLog});
const includeFile=path.join(__dirname,'results/nanite-wpo/failure-streaming-package-include/web-engine-full-thread-20261110-140152.log');
const includeLog=fs.readFileSync(includeFile,'utf8');assert(includeLog.includes('error:')&&includeLog.includes('UPackage'));
failures.push({name:'streaming-package-include',file:audit(includeFile),log:includeLog});
const optionDirectory=path.join(__dirname,'results/nanite-wpo/failure-streaming-option');
const optionFailure=read(path.join(optionDirectory,'browser.json'));assert(!optionFailure.pass&&optionFailure.wpo&&!optionFailure.tests[0].wpo);
failures.push({name:'streaming-option',run:optionFailure,source:fs.readFileSync(path.join(optionDirectory,'probe-nanite-streaming.cjs'),'utf8'),
  package:read(path.join(optionDirectory,'package.json')),build:read(path.join(optionDirectory,'build.json'))});
const velocityDirectory=path.join(__dirname,'results/nanite-wpo/failure-streaming-velocity');
const velocityFailure=read(path.join(velocityDirectory,'browser.json'));assert(!velocityFailure.pass&&velocityFailure.tests[0].wpo);
failures.push({name:'streaming-velocity-oracle',run:velocityFailure,source:fs.readFileSync(path.join(velocityDirectory,'probe-nanite-streaming.cjs'),'utf8'),
  package:read(path.join(velocityDirectory,'package.json')),build:read(path.join(velocityDirectory,'build.json'))});
const pixelDirectory=path.join(__dirname,'results/nanite-wpo/failure-streaming-pixel-precision');
const pixelFailure=read(path.join(pixelDirectory,'browser.json'));assert(!pixelFailure.pass&&pixelFailure.tests.length===2);
failures.push({name:'streaming-pixel-precision',run:pixelFailure,source:fs.readFileSync(path.join(pixelDirectory,'probe-nanite-streaming.cjs'),'utf8'),
  package:read(path.join(pixelDirectory,'package.json')),build:read(path.join(pixelDirectory,'build.json'))});
const rigidDirectory=path.join(__dirname,'results/nanite-wpo/failure-rigid-projection');
const rigidFailure=read(path.join(rigidDirectory,'browser.json'));assert(!rigidFailure.pass&&rigidFailure.tests.length===43);
failures.push({name:'rigid-projection-regression',run:rigidFailure,source:fs.readFileSync(path.join(rigidDirectory,'probe-nanite-programmable.cjs'),'utf8'),
  shader:fs.readFileSync(path.join(rigidDirectory,'WebNaniteProgrammableRaster.usf'),'utf8'),
  renderer:fs.readFileSync(path.join(rigidDirectory,'NaniteWebProgrammableRaster.cpp'),'utf8'),
  package:read(path.join(rigidDirectory,'package.json')),build:read(path.join(rigidDirectory,'build.json'))});
const unormRun=read(path.join(__dirname,'results/nanite-wpo/failure-streaming-analytic-xy/browser-with-velocity-shaders.json'));
const floatRun=read(path.join(__dirname,'results/nanite-wpo-streaming-float/browser.json'));
assert(!unormRun.pass&&/streamed WPO XY velocity/.test(unormRun.failure));
assert.equal(floatRun.failure.split('\n')[0],'Error: float-target capture complete');assert.deepEqual(floatRun.errors,[]);
verify(floatRun.source);
assert.equal(floatRun.package.sha256,audit(path.join(__dirname,'results/nanite-wpo/failure-streaming-analytic-xy/package.json')).sha256);
assert.equal(floatRun.tests.length,1);
assert(floatRun.tests[0].validation.velocity.maxXY<2e-6);
const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const unorm=unormRun.tests[0].pixels,floats=floatRun.tests[0].pixels;
let minULP=1,maxULP=-1,quantizationSamples=0,aboveHalfULP=0;
assert.equal(unorm.length,floats.length);
for(let i=0;i<unorm.length;i+=12)if(unorm[i]){
  assert.equal(unorm[i],floats[i]);assert.equal(unorm[i+1],floats[i+1]);
  for(const j of [4,5]){
    const difference=(asFloat(unorm[i+j])-asFloat(floats[i+j]))*65535;
    assert(Math.abs(difference)<.6);minULP=Math.min(minULP,difference);maxULP=Math.max(maxULP,difference);
    quantizationSamples++;if(Math.abs(difference)>.5)aboveHalfULP++;
  }
}
assert(quantizationSamples>1000&&aboveHalfULP>0);
const quantization={samples:quantizationSamples,aboveHalfULP,minULP,maxULP,allowedULP:.6,
  specification:'https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm#3.2.3.6%20FLOAT%20-%3E%20UNORM',
  unormRun,floatRun,diagnosticSource:fs.readFileSync(floatRun.source.file,'utf8'),
  viewFailure:read(path.join(__dirname,'results/nanite-wpo/float-diagnostic-view-failure.json'))};
// Archive each section separately so the full raw pixel history never needs
// one V8 string (whose maximum length is smaller than the combined evidence).
const payload=Object.fromEntries(Object.entries({shader,runs,regressions,kernels,oracle,failures,quantization,storage}).map(([name,value])=>{
  const json=JSON.stringify(value),compressed=zlib.gzipSync(json,{level:9});
  assert.equal(zlib.gunzipSync(compressed).toString(),json);
  console.log({section:name,rawBytes:Buffer.byteLength(json),compressedBytes:compressed.length});
  return [name,compressed.toString('base64')];
}));
const images=[];
for(const mode of ['packed','scalar'])for(const step of [3,7,14,15,21,26,33,35]){
  const file=path.join(__dirname,`evidence/nanite-wpo-20261110-${mode}-${step}.png`);
  fs.copyFileSync(path.join(__dirname,`results/nanite-wpo/${mode}-${step}.png`),file);images.push(audit(file));
}
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,images,
  runs:runs.map(r=>({scalar:r.scalar,frames:r.frames,steps:r.tests.map(t=>({step:t.step,...t.validation}))})),
  regressions:regressions.map(r=>({suite:r.suite,scalar:r.scalar,frames:r.run.frames,steps:r.run.tests.length})),
  kernelChecks:kernels.reduce((n,r)=>n+r.results.length,0),payloadEncoding:'gzip-base64-json-sections',payload,
  boundary:'Cooked WPO vertex graphs, current/previous deformation, component/distance/always-evaluate policy, mixed slots, conservative rotated bounds and streaming are covered by this evidence. Spline, skinning, assemblies, curves, remaining materials/views, full-scene temporal reconstruction and performance remain subject to the completion tracker.'};
const file=path.join(__dirname,'evidence/nanite-wpo-20261110.json');fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');
console.log({pass:true,file,frames:runs.map(r=>r.frames),regressions:result.regressions,kernelChecks:result.kernelChecks});
