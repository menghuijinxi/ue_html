'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,name='nanite-occlusion-batch-20261112',directory=path.join(root,'evidence',name),files=new Set(),packages=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
function pkg(a){verify(a);if(packages.has(a.file))return;packages.add(a.file);add(a.file);const p=read(a.file);assert(p.pass);
 for(const f of p.products){verify(f);if(/(?:index.html|config-files.json|content-files.json|asset-versions.json)$/.test(f.file))add(f.file);}
 if(p.build){verify(p.build);add(p.build.file);}
}
function run(tag){const f=path.join(root,'results',tag,'report.json'),r=read(f);assert(r.pass);assert.deepEqual(r.errors||r.runs.flatMap(t=>t.errors),[]);
 const s=path.join(path.dirname(f),'source.cjs');verify({file:s,sha256:r.source.sha256});add(f);add(s);if(r.package)pkg(r.package);return r;}
const correctness=[];
for(const tag of ['nanite-occlusion-default-correctness-20261112','nanite-occlusion-villa-correctness-20261112','nanite-occlusion-default-scalar-20261112']){
 const r=run(tag);assert(r.occlusion&&r.comparisons.length>=3&&!r.gpu.errors.length);
 for(const t of r.tests){verify(t.readback);add(t.readback.file);if(t.entries)assert.equal(t.batched>0,!!t.batch);}
 correctness.push({tag,scalar:r.scalar,comparisons:r.comparisons,dispatches:r.tests.filter(t=>t.batch&&t.entries).map(t=>({label:t.label,entries:t.entries,dispatchBuffers:t.dispatchBuffers}))});
}
const recovery=[];
for(const mode of ['packed','scalar']){
 const d=path.join(root,'results/nanite-occlusion-recovery-20261112'),f=path.join(d,mode+'.json'),r=read(f);assert(r.pass&&r.tests.length===8&&!r.errors.length&&!r.gpu.errors.length);
 add(f);const s=path.join(d,mode+'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);pkg(r.package);
 for(const t of r.tests)for(const h of t.history)if(h.targetPresent&&!h.occluderBlocking)assert(h.candidate);
 recovery.push({mode,tests:r.tests.length,report:audit(f)});
}
const eligibility=run('nanite-occlusion-eligibility-20261112');assert(eligibility.tests.length===13&&eligibility.idleStatus);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);if(!t.registered){assert.equal(t.gpu.dispatches,0);assert.deepEqual(t.gpu.resources,{});}}
const gf=path.join(root,'results',name,'gpu-analysis.json'),gpu=read(gf);add(gf);
const gs=gf.replace(/\.json$/,'-source.cjs');verify({file:gs,sha256:gpu.source.sha256});add(gs);
for(const s of gpu.summaries){verify(s.report);add(s.report.file);const r=read(s.report.file);assert(r.pass);pkg(r.package);
 const source=s.report.file.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);}
const controlledFile=path.join(root,'results/nanite-occlusion-controlled-gpu-20261112/gpu-analysis.json'),controlled=read(controlledFile);add(controlledFile);
const controlledSource=controlledFile.replace(/\.json$/,'-source.cjs');verify({file:controlledSource,sha256:controlled.source.sha256});add(controlledSource);
assert.equal(controlled.summaries.length,2);assert.equal(controlled.summaries[0].nativeBeforeCapture.entries,controlled.summaries[1].nativeBeforeCapture.entries);
for(const s of controlled.summaries){assert(!s.nativeBeforeCapture.primitiveVisibility);verify(s.report);add(s.report.file);const r=read(s.report.file);assert(r.pass);pkg(r.package);
 const source=s.report.file.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);}
const cpus=[];
for(const tag of ['nanite-occlusion-off-spawn-20261112','nanite-occlusion-on-spawn-20261112']){
 const f=path.join(root,'results','cpu-'+tag+'.json'),r=read(f);assert(r.pass&&!r.errors.length&&r.samples.length===0);add(f);pkg(r.package);
 const s=f.replace(/\.json$/,'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
 const log=f.replace(/\.json$/,'.log');if(fs.existsSync(log))add(log);
 cpus.push({tag,nanite:r.nanite,plainSamples:r.plainSamples});
}
const motionTag='nanite-occlusion-motion-abba-20261112',motion=run(motionTag);
assert(motion.headed&&motion.tour&&!motion.trace&&!motion.gpuProbe&&!motion.gpuTimestamps);assert.deepEqual(motion.runs.map(r=>r.occlusion.enabled),[0,1,1,0]);
const performance={};
function distribution(values){const s=values.toSorted((a,b)=>a-b),low=s.slice(-Math.ceil(s.length/100));return {frames:s.length,fps:s.length*1000/s.reduce((a,b)=>a+b,0),low1:low.length*1000/low.reduce((a,b)=>a+b,0),maxMs:s.at(-1),over50:s.filter(v=>v>50).length};}
for(const enabled of [0,1])performance[enabled?'on':'off']=distribution(motion.runs.filter(r=>r.occlusion.enabled===enabled).flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}));
for(const r of motion.runs){assert(r.pass&&!r.errors.length);for(const p of r.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(root,'results',motionTag,r.index+'-'+r.mode+'.'+ext));}
const af=path.join(root,'results',motionTag,'analysis.json'),analysis=read(af);assert.equal(analysis.input.sha256,audit(path.join(path.dirname(af),'report.json')).sha256);add(af);
const as=path.join(path.dirname(af),'analysis-source.cjs');verify({file:as,sha256:analysis.source.sha256});add(as);
performance.runs=analysis.runs.map(r=>({index:r.index,occlusion:r.occlusion,overall:r.overall,lowest5s:r.lowest5s,travelCm:r.travelCm,turnDegrees:r.turnDegrees}));
for(const r of performance.runs)r.lowestFPS5s=analysis.runs.find(a=>a.index===r.index).windows.toSorted((a,b)=>a.fps-b.fps)[0];
const diagnosticTag='nanite-occlusion-stall-diagnostic-20261112',diagnostic=run(diagnosticTag),diagnosticDir=path.join(root,'results',diagnosticTag);
assert(diagnostic.trace&&diagnostic.gpuTimestamps&&diagnostic.gpuProbe);
const diagnosticAnalysisFile=path.join(diagnosticDir,'gpu-analysis.json'),diagnosticAnalysis=read(diagnosticAnalysisFile);assert.equal(diagnosticAnalysis.input.sha256,audit(path.join(diagnosticDir,'report.json')).sha256);
const diagnosticAnalysisSource=path.join(diagnosticDir,'gpu-analysis-source.cjs');verify({file:diagnosticAnalysisSource,sha256:diagnosticAnalysis.source.sha256});
for(const n of ['gpu-analysis.json','gpu-analysis-source.cjs','gpu-observer.cjs','dawn-analysis.json','0-candidate.log'])add(path.join(diagnosticDir,n));
for(const r of diagnostic.runs){verify(r.phases[0].trace);add(r.phases[0].trace.file);}
const bf=path.join(root,'build/nanite-occlusion-villa-20261112/runtime-build.json'),build=read(bf);assert(build.pass&&build.fullLinkVerified&&build.lowerMemory64&&!build.trace&&!build.simd);add(bf);
for(const p of [...build.sourceFiles,...build.products,build.log,build.linkResponse]){verify(p);if(p===build.log||p===build.linkResponse)add(p.file);}
const previousFile=path.join(root,'evidence/nanite-hierarchy-batch-20261112.json'),previous=read(previousFile);assert(previous.pass);add(previousFile);
const originals=path.join(root,'results',name),before=path.join(originals,'baseline-build.json');add(before);
const oldCpp=previous.records.find(r=>r.original.file.replaceAll('\\','/').endsWith('/NaniteWebHZB.cpp'));assert(oldCpp);verify(oldCpp.archive);
const shaderArchive=previous.records.find(r=>path.basename(r.original.file)==='web-cook-shader-sources.json');assert(shaderArchive);verify(shaderArchive.archive);
const oldShaders=JSON.parse(zlib.gunzipSync(fs.readFileSync(shaderArchive.archive.file)));
const cook=read(path.join(root,'results/web-project-nanite-occlusion-villa-20261112-desktop-cook-results.json'));verify(cook.shaderSourcesReport);const shaders=read(cook.shaderSourcesReport.file);
for(const [i,n] of ['Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebHZB.cpp','Engine/Shaders/Private/Nanite/WebNaniteOcclusion.usf'].entries()){
 const old=path.join(originals,i+'-before-source'),current=path.join(root,'../../reference-engine',n);add(old);add(current);
 const match=r=>r.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
 assert.equal(audit(old).sha256,i?match(oldShaders).sha256:oldCpp.original.sha256);
 assert.equal(audit(current).sha256,match(i?shaders:build).sha256);
}
for(const n of ['web-project-nanite-occlusion-villa-20261112-desktop','web-engine-webgpu-sm5-default'])for(const kind of ['cook','stage']){
 const f=path.join(root,'results',n+'-'+kind+'-results.json'),r=read(f);assert(r.pass);add(f);
 for(const p of [r.log,r.moduleBuildLog,r.hostPreparationReport,r.hostPreparationLog,r.shaderSourcesReport,r.shaderInventory?.artifact].filter(Boolean)){verify(p);add(p.file);}
 if(kind==='cook'){const inv=read(r.shaderInventory.artifact.file);for(const type of ['FWebNaniteHierarchyCull_CS','FWebNaniteOcclusionCS'])assert(inv.types.some(t=>t.name===type&&t.permutations===5));}
}
const originalFile=path.join(root,'results/nanite-full-scene-conversion-verified.json'),original=read(originalFile);assert(original.pass);for(const p of original.originalFiles)verify(p);add(originalFile);
for(const n of ['collect-nanite-occlusion-batch.cjs','probe-nanite-hierarchy-batch.cjs','profile-nanite-user-cpu.cjs','profile-web-gpu.cjs','probe-nanite-off-regression.cjs','analyze-nanite-walk-turn.cjs','analyze-nanite-hierarchy-gpu.cjs','observe-nanite-motion-gpu.cjs','package-nanite-shadow-guard.cjs','web-engine-worker.js',
 ...['AutomaticScene','GBuffer','HZB','Sidedness'].map(s=>'../ue-web-smoke/Source/UEWebEngine/Private/WebNanite'+s+'Test.cpp')])add(path.join(root,n));
assert(!fs.existsSync(directory));fs.mkdirSync(directory);const records=[];
for(const [i,f] of [...files].entries()){const b=fs.readFileSync(f),archive=path.join(directory,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(b,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(b));records.push({original:audit(f),archive:audit(archive)});}
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify({date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,correctness,recovery,performance,cpus,gpu:gpu.summaries,controlledGPU:controlled.summaries,stallDiagnostic:diagnosticAnalysis.summaries,previousEvidence:audit(previousFile),records,
 boundary:'Rigid HZB batching checkpoint. Both previous/current HZB decisions and per-instance state remain independent. Actual movement performance includes every stall; diagnostic GPU times are separate. Complete scene performance remains open; original project hashes unchanged.'},null,2)+'\n');
console.log({pass:true,archives:records.length,performance});
