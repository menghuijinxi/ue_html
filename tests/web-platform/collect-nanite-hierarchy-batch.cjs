'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,name='nanite-hierarchy-batch-20261112',files=new Set(),output=path.join(root,'evidence',name);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
const packages=new Set();
function pkg(a){verify(a);if(packages.has(a.file))return;packages.add(a.file);const p=read(a.file);assert(p.pass);add(a.file);
 for(const b of p.products){verify(b);if(/(?:index.html|config-files.json|asset-versions.json|content-files.json)$/.test(b.file))add(b.file);}
 if(p.build){verify(p.build);add(p.build.file);}
}
function run(tag){const f=path.join(root,'results',tag,'report.json'),r=read(f);assert(r.pass);assert.equal((r.errors||r.runs?.flatMap(t=>t.errors))?.length,0);
 const source=path.join(path.dirname(f),'source.cjs');verify({file:source,sha256:r.source.sha256});add(f);add(source);if(r.package)pkg(r.package);return r;}
const correctness=[];
for(const tag of ['nanite-batch-default-correctness-fixed-20261112','nanite-batch-villa-correctness-20261112','nanite-batch-default-scalar-20261112']){
 const r=run(tag);assert(r.comparisons.length>=3&&!r.gpu.errors.length);
 for(const t of r.tests){verify(t.readback);add(t.readback.file);if(t.entries)assert.equal(t.batched>0,!!t.batch);}
 correctness.push({tag,scalar:r.scalar,comparisons:r.comparisons,dispatches:r.tests.filter(t=>t.batch&&t.entries).map(t=>({label:t.label,entries:t.entries,dispatchBuffers:t.dispatchBuffers}))});
}
const eligibility=run('nanite-batch-eligibility-20261112');assert(eligibility.tests.length===13&&eligibility.idleStatus);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);if(!t.registered){assert.equal(t.gpu.dispatches,0);assert.deepEqual(t.gpu.resources,{});}}
const recovery=[];
for(const mode of ['packed','scalar']){
 const dir=path.join(root,'results/nanite-batch-recovery-20261112'),f=path.join(dir,mode+'.json'),r=read(f);
 assert(r.pass&&!r.errors.length&&!r.gpu.errors.length&&r.tests.length===8);add(f);
 const source=path.join(dir,mode+'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);pkg(r.package);
 for(const t of r.tests)for(const h of t.history)if(h.targetPresent&&!h.occluderBlocking)assert(h.candidate);
 recovery.push({mode,tests:r.tests.length,report:audit(f)});
}
const gpuFile=path.join(root,'results/nanite-batch-hierarchy-20261112/gpu-analysis.json'),gpu=read(gpuFile);
verify({file:gpuFile.replace(/\.json$/,'-source.cjs'),sha256:gpu.source.sha256});add(gpuFile);add(gpuFile.replace(/\.json$/,'-source.cjs'));
for(const s of gpu.summaries){verify(s.report);add(s.report.file);const r=read(s.report.file);assert(r.pass);pkg(r.package);
 const source=s.report.file.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);}
const cpus=[];
for(const tag of ['nanite-on-current-spawn-20261112','nanite-batch-cpu-off-20261112','nanite-batch-cpu-on-20261112']){
 const f=path.join(root,'results','cpu-'+tag+'.json'),r=read(f);assert(r.pass&&!r.errors.length);add(f);pkg(r.package);
 const source=f.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);
 for(const e of fs.readdirSync(path.join(root,'results')))if(e.startsWith('cpu-'+tag)&&/\.(?:cpuprofile|png|log)$/.test(e))add(path.join(root,'results',e));
 cpus.push({tag,nanite:r.nanite,plainSamples:r.plainSamples});
}
const motion=run('nanite-batch-motion-abba-20261112');assert(motion.headed&&motion.tour&&!motion.trace&&!motion.gpuProbe&&!motion.gpuTimestamps);
assert.deepEqual(motion.runs.map(r=>r.hierarchy.enabled),[0,1,1,0]);
function distribution(values){const sorted=values.toSorted((a,b)=>a-b),low=sorted.slice(-Math.ceil(sorted.length/100));
 return {frames:values.length,fps:values.length*1000/values.reduce((a,b)=>a+b,0),low1:low.length*1000/low.reduce((a,b)=>a+b,0),maxMs:sorted.at(-1),over50:values.filter(v=>v>50).length};}
const performance={};
for(const enabled of [0,1]){
 const runs=motion.runs.filter(r=>r.hierarchy.enabled===enabled);assert(runs.length===2&&runs.every(r=>r.pass&&!r.errors.length));
 performance[enabled?'on':'off']=distribution(runs.flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}));
}
for(const r of motion.runs){for(const p of r.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(root,'results/nanite-batch-motion-abba-20261112',r.index+'-'+r.mode+'.'+ext));}
const analysisFile=path.join(root,'results/nanite-batch-motion-abba-20261112/analysis.json'),analysis=read(analysisFile);
assert.equal(analysis.input.sha256,audit(path.join(path.dirname(analysisFile),'report.json')).sha256);add(analysisFile);
verify({file:path.join(path.dirname(analysisFile),'analysis-source.cjs'),sha256:analysis.source.sha256});add(path.join(path.dirname(analysisFile),'analysis-source.cjs'));
performance.runs=analysis.runs.map(r=>({index:r.index,hierarchy:r.hierarchy,overall:r.overall,lowest5s:r.lowest5s,travelCm:r.travelCm,turnDegrees:r.turnDegrees}));
const diagnostic=run('nanite-batch-late-stall-diagnostic-20261112');assert(diagnostic.trace&&diagnostic.gpuTimestamps&&diagnostic.gpuProbe);
const diagnosticDir=path.join(root,'results/nanite-batch-late-stall-diagnostic-20261112');
const diagnosticAnalysis=read(path.join(diagnosticDir,'gpu-analysis.json'));assert.equal(diagnosticAnalysis.input.sha256,audit(path.join(diagnosticDir,'report.json')).sha256);
verify({file:path.join(diagnosticDir,'gpu-analysis-source.cjs'),sha256:diagnosticAnalysis.source.sha256});
for(const n of ['gpu-observer.cjs','gpu-analysis.json','gpu-analysis-source.cjs','dawn-analysis.json','0-candidate.log'])add(path.join(diagnosticDir,n));
for(const r of diagnostic.runs){verify(r.phases[0].trace);add(r.phases[0].trace.file);}
const buildFile=path.join(root,'build/nanite-batch-villa-20261112/runtime-build.json'),build=read(buildFile);assert(build.pass&&build.fullLinkVerified&&build.lowerMemory64&&!build.trace&&!build.simd);add(buildFile);
for(const p of [...build.sourceFiles,...build.products,build.log,build.linkResponse]){verify(p);if(p===build.log||p===build.linkResponse)add(p.file);}
const originals=path.join(root,'results/nanite-batch-hierarchy-20261112'),oldBuild=read(path.join(originals,'baseline-build.json'));add(path.join(originals,'baseline-build.json'));add(path.join(originals,'sources.json'));
const priorEvidence=read(path.join(root,'evidence/nanite-idle-20261112.json'));
const oldShaderArchive=priorEvidence.records.find(r=>path.basename(r.original.file)==='web-cook-shader-sources.json');assert(oldShaderArchive);
verify(oldShaderArchive.archive);add(oldShaderArchive.archive.file);
const oldShaderSources=JSON.parse(zlib.gunzipSync(fs.readFileSync(oldShaderArchive.archive.file)));
const currentCook=read(path.join(root,'results/web-project-nanite-batch-villa-built-20261112-desktop-cook-results.json'));
verify(currentCook.shaderSourcesReport);const currentShaderSources=read(currentCook.shaderSourcesReport.file);
for(const [i,n] of read(path.join(originals,'sources.json')).entries()){
 const old=path.join(originals,i+'-before-source'),current=path.join(root,'../../reference-engine',n);add(old);add(current);
 const entry=b=>b.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
 assert.equal(audit(old).sha256,entry(n.startsWith('Engine/Shaders/')?oldShaderSources:oldBuild).sha256);
 assert.equal(audit(current).sha256,entry(n.startsWith('Engine/Shaders/')?currentShaderSources:build).sha256);
}
for(const n of ['web-project-nanite-batch-villa-built-20261112-desktop','web-engine-webgpu-sm5-default'])for(const kind of ['cook','stage']){
 const f=path.join(root,'results',n+'-'+kind+'-results.json'),r=read(f);assert(r.pass);add(f);
 for(const p of [r.log,r.moduleBuildLog,r.hostPreparationReport,r.hostPreparationLog,r.shaderSourcesReport,r.shaderInventory?.artifact].filter(Boolean)){verify(p);add(p.file);}
}
const failed=[];
for(const n of ['nanite-batch-default-correctness-20261112']){const f=path.join(root,'results',n,'report.json'),r=read(f);assert(!r.pass);add(f);const s=path.join(path.dirname(f),'source.cjs');verify({file:s,sha256:r.source.sha256});add(s);failed.push({report:audit(f),reason:r.failure});}
for(const tag of ['nanite-on-no-hzb-spawn-20261112','nanite-on-no-hzb-spawn-retry-20261112']){
 const f=path.join(root,'results','cpu-'+tag+'.json'),r=read(f);add(f);const s=f.replace(/\.json$/,'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
 failed.push({report:audit(f),reason:'HZB command/config isolation was not verified by native CVar readback; excluded from performance conclusions.'});
}
const stopped=path.join(root,'results/web-project-nanite-batch-villa-20261112-desktop-cook-results.json');const attempt=read(stopped);assert(!attempt.pass);add(stopped);if(attempt.log){verify(attempt.log);add(attempt.log.file);}failed.push({report:audit(stopped),reason:'Stopped before acceptance because the shader-export module had not yet been rebuilt; superseded by complete rebuild/Cook.'});
const original=read(path.join(root,'results/nanite-full-scene-conversion-verified.json'));assert(original.pass);for(const p of original.originalFiles)verify(p);add(path.join(root,'results/nanite-full-scene-conversion-verified.json'));
for(const n of ['collect-nanite-hierarchy-batch.cjs','probe-nanite-hierarchy-batch.cjs','profile-nanite-user-cpu.cjs','profile-web-gpu.cjs','probe-nanite-off-regression.cjs','analyze-nanite-walk-turn.cjs','analyze-nanite-stall-gpu.cjs','observe-nanite-motion-gpu.cjs','package-nanite-shadow-guard.cjs','web-engine-worker.js',
 '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteCullReadback.h',
 ...['SceneCull','Instances','Views','InstanceDistance','HZB'].map(s=>'../ue-web-smoke/Source/UEWebEngine/Private/WebNanite'+s+'Test.cpp')])add(path.join(root,n));
fs.mkdirSync(output,{recursive:true});const records=[];
for(const [i,f] of [...files].entries()){const b=fs.readFileSync(f),archive=path.join(output,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(b,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(b));records.push({original:audit(f),archive:audit(archive)});}
const report={date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,correctness,recovery,performance,gpu:gpu.summaries,lateStallDiagnostic:diagnosticAnalysis.summaries,cpus,failed,records,
 boundary:'Ordinary rigid Nanite hierarchy batching only. HZB, packing and material work remain. Same-package native 0/1/1/0 performance comparison uses real movement/rotation with all stalls. GPU timestamps are separate diagnostics. Original project file hashes verified unchanged; experimental packages are not a complete release.'};
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,archives:records.length,performance});
