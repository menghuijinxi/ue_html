'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const name='nanite-pack-batch-20261112',root=__dirname,directory=path.join(root,'evidence',name),files=new Set(),packages=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
function pkg(p){verify(p);if(packages.has(p.file))return;packages.add(p.file);add(p.file);const r=read(p.file);assert(r.pass);
 for(const a of r.products){verify(a);if(/(?:index.html|config-files.json|content-files.json|asset-versions.json)$/.test(a.file))add(a.file);}
 if(r.build){verify(r.build);add(r.build.file);}
}
function run(tag){const f=path.join(root,'results',tag,'report.json'),r=read(f);assert(r.pass,r.failure);add(f);
 const s=path.join(path.dirname(f),'source.cjs');verify({file:s,sha256:r.source.sha256});add(s);if(r.package)pkg(r.package);return r;
}
const correctness=[];
for(const tag of ['nanite-pack-default-correctness-20261112','nanite-pack-default-scalar-20261112','nanite-pack-villa-correctness-20261112']){
 const r=run(tag);assert(r.pack&&r.comparisons.length>=3&&!r.errors.length&&!r.gpu.errors.length);
 for(const t of r.tests){verify(t.readback);add(t.readback.file);if(t.entries){assert.equal(t.batched>0,!!t.batch);assert(read(t.readback.file).packedVisibleClusters.length>0);}}
 add(path.join(root,'results',tag,'engine.log'));correctness.push({tag,scalar:r.scalar,comparisons:r.comparisons,dispatches:r.tests.filter(t=>t.batch&&t.entries).map(t=>({label:t.label,entries:t.entries,dispatchBuffers:t.dispatchBuffers}))});
}
const recovery=[];
for(const mode of ['packed','scalar']){
 const d=path.join(root,'results/nanite-pack-recovery-20261112'),f=path.join(d,mode+'.json'),r=read(f);assert(r.pass&&r.tests.length===8&&!r.errors.length&&!r.gpu.errors.length);add(f);pkg(r.package);
 const s=path.join(d,mode+'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);recovery.push({mode,tests:r.tests.length,report:audit(f)});
}
const materials=[];
for(const [tag,count] of [['nanite-pack-programmable-verified-20261112',52],['nanite-pack-wpo-20261112',36]])for(const scalar of [false,true]){
 const d=path.join(root,'results',tag),f=path.join(d,scalar?'browser-scalar.json':'browser.json'),r=read(f);
 assert(r.pass&&r.scalar===scalar&&r.tests.length===count&&!r.errors.length&&!r.gpu.errors.length);add(f);pkg(r.package);
 const s=path.join(d,scalar?'scalar-source.cjs':'packed-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
 for(const t of r.tests){verify(t.image);add(t.image.file);}
 if(r.geometry){verify(r.geometry);add(r.geometry.file);assert(!r.validationFailures.length);}
 if(tag.includes('programmable')){assert(r.verifyPack);assert(r.tests.some(t=>t.packGPU.nonzeroOffsets.includes(16)));
  for(const t of r.tests.filter(t=>t.entries.length===2))assert(t.packGPU.groups.includes(2));}
 materials.push({tag,scalar,tests:count,report:audit(f)});
}
const fixtureFile=path.join(root,'build/nanite-pack-regression-content-20261112/package.json'),fixture=read(fixtureFile);
assert(fixture.pass&&fixture.replacements.length===2);pkg(audit(fixtureFile));for(const p of fixture.inputs){verify(p);add(p.file);}
for(const tag of ['nanite-pack-programmable-20261112','nanite-pack-programmable-retry-20261112','nanite-pack-programmable-final-20261112']){
 const d=path.join(root,'results',tag),f=path.join(d,'browser.json'),r=read(f);assert(!r.pass&&r.failure);add(f);pkg(r.package);
 const s=path.join(d,'packed-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
}
const eligibility=run('nanite-pack-eligibility-20261112');assert(eligibility.idleStatus&&eligibility.tests.length===13);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);if(!t.registered){assert.equal(t.gpu.dispatches,0);assert.deepEqual(t.gpu.resources,{});}}
const gf=path.join(root,'results/nanite-pack-controlled-gpu-20261112/gpu-analysis.json'),gpu=read(gf);add(gf);
const gs=gf.replace(/\.json$/,'-source.cjs');verify({file:gs,sha256:gpu.source.sha256});add(gs);
assert.equal(gpu.summaries.length,2);assert.equal(gpu.summaries[0].nativeBeforeCapture.entries,gpu.summaries[1].nativeBeforeCapture.entries);
for(const key of ['nanite-raster','micro-raster','native-material'])assert.deepEqual(gpu.summaries[0].pipelineWork[key],gpu.summaries[1].pipelineWork[key],key+' workload');
for(const s of gpu.summaries){assert(!s.nativeBeforeCapture.primitiveVisibility);verify(s.report);add(s.report.file);const r=read(s.report.file);assert(r.pass);pkg(r.package);
 const source=s.report.file.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);}
const cpus=[];
for(const tag of ['nanite-pack-off-spawn-20261112','nanite-pack-on-spawn-20261112']){
 const f=path.join(root,'results','cpu-'+tag+'.json'),r=read(f);assert(r.pass&&!r.errors.length&&r.samples.length===0);add(f);pkg(r.package);
 const s=f.replace(/\.json$/,'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);const log=f.replace(/\.json$/,'.log');if(fs.existsSync(log))add(log);
 cpus.push({tag,nanite:r.nanite,plainSamples:r.plainSamples});
}
const motionTag='nanite-pack-motion-abba-20261112',motion=run(motionTag);assert(motion.headed&&motion.tour&&!motion.trace&&!motion.gpuProbe&&!motion.gpuTimestamps);
assert.deepEqual(motion.runs.map(r=>r.pack.enabled),[0,1,1,0]);
const distribution=values=>{const s=values.toSorted((a,b)=>a-b),low=s.slice(-Math.ceil(s.length/100));return {frames:s.length,fps:s.length*1000/s.reduce((a,b)=>a+b,0),low1:low.length*1000/low.reduce((a,b)=>a+b,0),maxMs:s.at(-1),over50:s.filter(v=>v>50).length};};
const performance={};
for(const enabled of [0,1])performance[enabled?'on':'off']=distribution(motion.runs.filter(r=>r.pack.enabled===enabled).flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}));
for(const r of motion.runs){assert(r.pass&&!r.errors.length);for(const p of r.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(root,'results',motionTag,r.index+'-'+r.mode+'.'+ext));}
const analysisFile=path.join(root,'results',motionTag,'analysis.json'),analysis=read(analysisFile);verify(analysis.input);add(analysisFile);
const analysisSource=path.join(path.dirname(analysisFile),'analysis-source.cjs');verify({file:analysisSource,sha256:analysis.source.sha256});add(analysisSource);
performance.runs=analysis.runs.map(r=>({index:r.index,pack:r.pack,overall:r.overall,lowestFPS5s:r.windows.toSorted((a,b)=>a.fps-b.fps)[0],travelCm:r.travelCm,turnDegrees:r.turnDegrees}));
const diagnosticTag='nanite-pack-motion-diagnostic-20261112',diagnostic=run(diagnosticTag),d=path.join(root,'results',diagnosticTag);assert(diagnostic.gpuTimestamps&&diagnostic.gpuProbe);
const diagnosticFile=path.join(d,'gpu-analysis.json'),diagnosticAnalysis=read(diagnosticFile);verify(diagnosticAnalysis.input);add(diagnosticFile);
const diagnosticSource=path.join(d,'gpu-analysis-source.cjs');verify({file:diagnosticSource,sha256:diagnosticAnalysis.source.sha256});add(diagnosticSource);
for(const n of ['gpu-observer.cjs','0-candidate.log'])add(path.join(d,n));
const buildFile=path.join(root,'build/nanite-pack-villa-20261112/runtime-build.json'),build=read(buildFile);assert(build.pass&&build.fullLinkVerified&&build.lowerMemory64&&!build.trace&&!build.simd);add(buildFile);
for(const p of [...build.sourceFiles,...build.products,build.log,build.linkResponse]){verify(p);if(p===build.log||p===build.linkResponse)add(p.file);}
const beforeDir=path.join(root,'results',name),beforeFile=path.join(beforeDir,'baseline-build.json'),before=read(beforeFile);add(beforeFile);
const failureFile=path.join(beforeDir,'initial-build-failure.json'),failure=read(failureFile);assert(!failure.pass);verify(failure.log);add(failureFile);add(failure.log.file);
const sources=read(path.join(beforeDir,'sources.json'));add(path.join(beforeDir,'sources.json'));
const previousFile=path.join(root,'evidence/nanite-material-precache-20261112.json'),previous=read(previousFile);assert(previous.pass);add(previousFile);
const stage2=read(path.join(root,'evidence/nanite-occlusion-batch-20261112.json'));
const shaderArchive=stage2.records.find(r=>path.basename(r.original.file)==='web-cook-shader-sources.json');assert(shaderArchive);verify(shaderArchive.archive);add(shaderArchive.archive.file);
const oldShaders=JSON.parse(zlib.gunzipSync(fs.readFileSync(shaderArchive.archive.file)));
const cook=read(path.join(root,'results/web-project-nanite-pack-villa-20261112-desktop-cook-results.json'));verify(cook.shaderSourcesReport);const shaders=read(cook.shaderSourcesReport.file);
for(const [i,n] of sources.entries()){
 const old=path.join(beforeDir,i+'-before-source'),current=path.join(root,'../../reference-engine',n);add(old);add(current);
 const match=r=>r.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
 assert.equal(audit(old).sha256,match(n.endsWith('.usf')?oldShaders:before).sha256);
 assert.equal(audit(current).sha256,match(n.endsWith('.usf')?shaders:build).sha256);
}
for(const n of ['web-project-nanite-pack-villa-20261112-desktop','web-engine-webgpu-sm5-default'])for(const kind of ['cook','stage']){
 const f=path.join(root,'results',n+'-'+kind+'-results.json'),r=read(f);assert(r.pass);add(f);
 for(const p of [r.log,r.moduleBuildLog,r.hostPreparationReport,r.hostPreparationLog,r.shaderSourcesReport,r.shaderInventory?.artifact].filter(Boolean)){verify(p);add(p.file);}
 if(kind==='cook'){const inv=read(r.shaderInventory.artifact.file);for(const [type,count] of [['FWebNaniteHierarchyCull_CS',5],['FWebNaniteOcclusionCS',5],['FWebNaniteVisibleClustersCS',2]])assert(inv.types.some(t=>t.name===type&&t.permutations===count));}
}
const originalFile=path.join(root,'results/nanite-full-scene-conversion-verified.json'),original=read(originalFile);assert(original.pass);original.originalFiles.forEach(verify);add(originalFile);
for(const n of ['collect-nanite-pack-batch.cjs','probe-nanite-hierarchy-batch.cjs','profile-nanite-user-cpu.cjs','profile-web-gpu.cjs','probe-nanite-off-regression.cjs','observe-nanite-motion-gpu.cjs','probe-nanite-programmable.cjs','probe-nanite-wpo.cjs','package-nanite-fixture-global.cjs','package-nanite-shadow-guard.cjs','web-engine-worker.js','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteProgrammableTest.cpp','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteWPOTest.cpp'])add(path.join(root,n));
assert(!fs.existsSync(directory));fs.mkdirSync(directory);const records=[];
for(const [i,f] of [...files].entries()){const data=fs.readFileSync(f),archive=path.join(directory,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(data,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(data));records.push({original:audit(f),archive:audit(archive)});}
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify({date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,correctness,recovery,materials,performance,cpus,controlledGPU:gpu.summaries,stallDiagnostic:diagnosticAnalysis.summaries,previousEvidence:audit(previousFile),records,
 boundary:'Rigid visible-cluster packing checkpoint. Per-instance cluster records, state, WPO flag and draw offsets remain independent. Full runtime build and both complete Cooks recorded. First movement includes every stall; diagnostic GPU times remain separate. Complete scene performance acceptance stays open; original project hashes unchanged.'},null,2)+'\n');
console.log({pass:true,archives:records.length,performance});
