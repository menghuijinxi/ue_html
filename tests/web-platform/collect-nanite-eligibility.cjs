'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,name='nanite-eligibility-20261112',output=path.join(root,'evidence',name),files=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const beforeFile=path.join(root,'results/nanite-full-scene-inventory.json'),afterFile=path.join(root,'results/nanite-full-scene-conversion.json');
const original=read(beforeFile),converted=read(afterFile),verificationFile=path.join(root,'results/nanite-full-scene-conversion-verified.json'),verification=read(verificationFile);
assert(original.pass&&!original.converted&&original.meshes.length===590&&original.meshes.every(m=>!m.nanite&&m.clusters===0));
assert(converted.pass&&converted.converted&&converted.meshes.filter(m=>m.nanite).length===587);
assert(verification.pass);assert.equal(audit(beforeFile).sha256,verification.sources.find(p=>p.file===beforeFile).sha256);
assert.equal(audit(afterFile).sha256,verification.report.sha256);
// Verify the original project still matches its pre-conversion inventory.
for(const f of verification.originalFiles)assert.equal(audit(f.file).sha256,f.sha256,f.file);
[beforeFile,afterFile,verificationFile].forEach(add);
const preparationFile=path.join(root,'results/web-project-nanite-full-scene-prepare-results.json'),preparation=read(preparationFile);
assert(preparation.pass&&preparation.originalProjectUnmodified);add(preparationFile);
add(path.join(path.dirname(preparation.project),'.web-nanite-project-copy.json'));
const runs=[];
for(const kind of ['before','fixed']){
  const directory=path.join(root,'results',`nanite-eligibility-${kind==='before'?'before-retry':kind}-20261112`),f=path.join(directory,'report.json'),r=read(f);
  assert(r.pass&&r.expectation===kind&&r.errors.length===0&&r.tests.length===13);
  assert.equal(audit(path.join(directory,'source.cjs')).sha256,r.source.sha256);add(f);add(path.join(directory,'source.cjs'));
  assert.equal(audit(r.package.file).sha256,r.package.sha256);const pkg=read(r.package.file);assert(pkg.pass);add(r.package.file);
  assert.equal(audit(pkg.build.file).sha256,pkg.build.sha256);const build=read(pkg.build.file);
  assert(build.pass&&build.fullLinkVerified&&build.threads&&build.lowerMemory64&&!build.trace&&!build.simd);add(pkg.build.file);
  for(const p of [build.log,build.linkResponse]){assert.equal(audit(p.file).sha256,p.sha256);add(p.file);}
  for(const n of ['UEWebEngineThreads.js','UEWebEngineThreads.wasm'])
    assert.equal(pkg.products.find(p=>path.basename(p.file)===n).sha256,build.products.find(p=>path.basename(p.file)===n).sha256);
  for(const p of pkg.products){assert.equal(audit(p.file).sha256,p.sha256);if(/(?:index.html|asset-versions.json)$/.test(p.file))add(p.file);}
  for(const t of r.tests){assert.equal(audit(t.readback.file).sha256,t.readback.sha256);add(t.readback.file);
    if(t.entries===0&&t.assets>0&&t.mode!==4){const rb=read(t.readback.file);assert(rb.batches.length>2000);
      assert(rb.batches.every(b=>b.created&&b.triangles>0&&b.material));}
    if(t.mode===0&&t.step!==2)assert(t.registered===2062&&t.entries>0&&t.covered>100);
    if([1,2,3].includes(t.mode))assert.equal(t.registered,kind==='before'?2062:0);
    if(t.mode===5)assert(t.assets===0&&t.entries===0&&t.registered===0);
    if(kind==='fixed'&&t.entries===0)assert(!t.gpu.draws&&!t.gpu.dispatches&&!Object.keys(t.gpu.resources).length);}
  runs.push({kind,report:audit(f),package:r.package,build:pkg.build,tests:r.tests});
}
const packages=runs.map(r=>read(r.package.file));assert.equal(packages[0].parent.sha256,packages[1].parent.sha256);
for(const n of ['content.bin','content-files.json','config-files.json','web-engine-worker.js'])
  assert.equal(packages[0].products.find(p=>path.basename(p.file)===n).sha256,packages[1].products.find(p=>path.basename(p.file)===n).sha256);
const engineFiles=read(path.join(root,'results',name,'fixed-sources.json'));
add(path.join(root,'results',name,'fixed-sources.json'));
const additionalFile=path.join(root,'results',name,'additional-before-source.json'),additional=read(additionalFile);add(additionalFile);
add(path.join(root,'results',name,'build-web-engine-before.ps1'));
const failedBuildFile=path.join(root,'results',name,'before-build-failure.json'),failedBuild=read(failedBuildFile);
assert(!failedBuild.pass&&failedBuild.compilerErrors.length>0);add(failedBuildFile);add(failedBuild.log.file);
add(path.join(root,'results',name,'eligibility-test-before-compile-fix.cpp'));
const failedDir=path.join(root,'results/nanite-eligibility-before-20261112'),failed=read(path.join(failedDir,'report.json'));
assert(!failed.pass&&!failed.errors.length&&failed.tests.at(-1).mode===4&&failed.tests.at(-1).registered===0);
assert.equal(audit(path.join(failedDir,'source.cjs')).sha256,failed.source.sha256);add(path.join(failedDir,'report.json'));add(path.join(failedDir,'source.cjs'));
for(const t of failed.tests){assert.equal(audit(t.readback.file).sha256,t.readback.sha256);add(t.readback.file);}
for(const [i,n] of engineFiles.entries()){
  add(path.join(root,'results',name,i+'-before-source'));add(path.join(root,'../../reference-engine',n));
  const before=read(read(runs[0].package.file).build.file),previous=before.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
  const previousHash=previous?.sha256||(n.endsWith('/Components/StaticMeshComponent.cpp')?additional.source.sha256:null);
  assert(previousHash&&previousHash===audit(path.join(root,'results',name,i+'-before-source')).sha256,n);
  const fixed=read(read(runs[1].package.file).build.file);const source=fixed.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
  assert(source&&source.sha256===audit(path.join(root,'../../reference-engine',n)).sha256,n);
}
for(const n of ['collect-nanite-eligibility.cjs','probe-nanite-eligibility.cjs','package-nanite-runtime-variant.cjs','web-engine-worker.js','build-web-engine.ps1',
  '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteEligibilityTest.cpp'])add(path.join(root,n));
fs.mkdirSync(output,{recursive:true});const records=[];
for(const [i,f] of [...files].entries()){
  const bytes=fs.readFileSync(f),archive=path.join(output,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(bytes,{level:9}));
  assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(bytes));records.push({original:audit(f),archive:audit(archive)});
}
const report={date:new Date().toISOString(),pass:true,componentPolicyFixed:true,emptyViewGpuWorkFixed:true,naniteFullPerformanceAccepted:false,
  failedDiagnostics:'The first helper compile used pointer deduction on TObjectPtr and an unparenthesized EM_ASM object. '
    +'The first browser collector incorrectly expected hidden components to retain proxies; the real component lifecycle unregisters them. '
    +'These failed attempts are archived and excluded from passing verification.',
  assets:{originalProject:preparation.originalProject,originalMeshes:original.meshes.length,originalNaniteMeshes:0,
    testProject:preparation.project,testNaniteMeshes:587,registeredComponents:2062},runs,records,
  boundary:'Original Villa contains no enabled Nanite meshes. The compatibility package deliberately converts a separate project copy. '
    +'Real component disable flags, all-hidden candidates, non-Nanite mesh replacement, and restoration are tested. '
    +'Empty visible Nanite work now exits before raster visibility/depth preparation. '
    +'The scene opt-in still initializes streaming infrastructure and enables conservative ordinary-occlusion invalidation; zero total CPU/memory overhead is not claimed. '
    +'These instrumented frozen-clock checks are correctness evidence and do not establish Nanite-on scene performance acceptance.'};
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,archives:records.length});
