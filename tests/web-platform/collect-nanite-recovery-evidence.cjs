'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib'),cp=require('node:child_process');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(packageFile);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
const files=['browser.json','browser-scalar.json','browser-repeated.json','browser-scalar-repeated.json'].map(f=>path.join(__dirname,'results/nanite-device-recovery',f));
const runs=files.map(read);
const ordinaryFile=path.join(__dirname,'results/nanite-device-recovery/ordinary-errors.json'),ordinary=read(ordinaryFile);
assert(ordinary.pass);verify(ordinary.source);verify(ordinary.package);assert.equal(ordinary.package.sha256,audit(packageFile).sha256);
assert.deepEqual(ordinary.pageErrors,[]);assert.equal(ordinary.tests.length,2);
for(const t of ordinary.tests){assert.equal(t.recovery.phase,'failed');assert.equal(t.recovery.attempts,0);assert.equal(t.huds,0);}
for(const [i,r] of runs.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.equal(r.scalarVisibility,i%2===1);assert.equal(r.repeatCrashes,i>=2);assert.deepEqual(r.errors,[]);
  assert.equal(r.runs.length,r.repeatCrashes?3:2);
  for(const run of r.runs){assert.equal(run.gpu.devices,1);assert.deepEqual(run.gpu.errors,[]);assert.equal(run.gpu.features.includes('atomic-vec2u-min-max'),!r.scalarVisibility);
    assert.equal(run.test.step,3);assert.equal(run.test.residentClusters,1059);assert.equal(run.test.cullState[1],0);
    if(run.generation>1){assert.equal(run.comparison.covered,964);assert.equal(run.comparison.depthDifferences,0);assert.equal(run.comparison.maskDifferences,0);
      assert.equal(run.oldWorkerCount,run.newWorkerCount);assert(run.oldWorkerCount>1);
      assert(run.input.after.sent>=run.input.before+2);assert.equal(run.resized.width,944);
      assert.equal(run.ui.state.events.filter(e=>e.kind==='recovered').length,run.generation-1);
    }}
  assert.equal(r.limit.state.phase,'failed');assert.equal(r.limit.state.attempts,2);assert.equal(r.limit.huds,0);
}
const regressionFiles=['nanite-browser','nanite-browser-scalar'].map(d=>path.join(__dirname,'results',d,'results.json'));
const regressions=regressionFiles.map(read);
for(const [i,r] of regressions.entries()){
  assert(r.pass&&r.scalarVisibility===(i===1));verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.deepEqual(r.errors,[]);assert.deepEqual(r.startupPipelineFailures,[]);assert.equal(r.sceneMicroRepeats.length,128);assert.equal(r.sceneViews.length,10);
  for(const p of [r.storagePrecache,r.defaultDisabled.storagePrecache]){assert(p.validation.pass);assert.equal(p.rhi.asyncPrecacheFailed,0);assert.equal(p.rhi.asyncPrecacheCompleted,p.rhi.asyncPrecacheRequested);}
}
const scripts=['verify-web-device-recovery.cjs','verify-web-input-bridge.cjs'];
const unit=scripts.map(f=>({source:audit(path.join(__dirname,f)),output:cp.execFileSync(process.execPath,[path.join(__dirname,f)],{encoding:'utf8',timeout:30000})}));
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(runs)),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),runs);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,unit,ordinaryErrors:{artifact:audit(ordinaryFile),...ordinary},
  runs:runs.map((r,i)=>({artifact:audit(files[i]),scalarVisibility:r.scalarVisibility,repeatCrashes:r.repeatCrashes,
    generations:r.runs.map(s=>({generation:s.generation,comparison:s.comparison,restore:s.restore,gpu:s.gpu,input:s.input,resized:s.resized,oldWorkerCount:s.oldWorkerCount,newWorkerCount:s.newWorkerCount})),limit:r.limit})),
  regressions:regressions.map((r,i)=>({artifact:audit(regressionFiles[i]),scalarVisibility:r.scalarVisibility,frames:r.framesAfter,enabled:r.storagePrecache.rhi,disabled:r.defaultDisabled.storagePrecache.rhi})),
  payloadEncoding:'gzip-base64-json',payload:payload.toString('base64'),
  references:['https://www.w3.org/TR/webgpu/#dom-gpudevice-lost','https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker','https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-crashGpuProcess'],
  boundary:'Actual isolated-browser GPU process crashes. Fresh adapter, GPU device, engine and Nanite pages; camera restored automatically, dynamic application assets restored through explicit checkpoint hooks. Native full-world in-place GPU reconstruction is not implemented. Default browser refusal after consecutive GPU crashes terminates cleanly. Repeated-crash diagnostic alone uses --disable-domain-blocking-for-3d-apis; production/default runs do not. Remaining material/instance and complete-scene acceptance stay open.'};
const file=path.join(__dirname,'evidence/nanite-device-recovery-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,bytes:fs.statSync(file).size,regressions:report.regressions.map(r=>({frames:r.frames,scalarVisibility:r.scalarVisibility}))}));
