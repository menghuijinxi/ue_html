'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const name='nanite-material-precache-20261112',directory=path.join(__dirname,'evidence',name),files=new Set(),packages=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
function pkg(p){verify(p);if(packages.has(p.file))return;packages.add(p.file);add(p.file);const r=read(p.file);assert(r.pass);
 for(const a of r.products){verify(a);if(/(?:index.html|config-files.json|content-files.json|asset-versions.json)$/.test(a.file))add(a.file);}
 if(r.build){verify(r.build);add(r.build.file);}if(r.parent)pkg(r.parent);
}
function run(tag){const f=path.join(__dirname,'results',tag,'report.json'),r=read(f);assert(r.pass,r.failure);add(f);
 const s=path.join(path.dirname(f),'source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
 if(r.package)pkg(r.package);return r;
}
const correctness=[];
for(const scene of ['default','default-scalar','villa']){
 for(const mode of ['off','on']){
  const tag=`nanite-material-precache-${scene}-${mode}-20261112`,r=run(tag);assert.deepEqual(r.errors,[]);assert.deepEqual(r.gpu.errors,[]);
  assert.equal(r.materialPrecache,mode==='on'?'1':'0');assert.equal(r.scalar,scene==='default-scalar');
  for(const t of r.tests){verify(t.readback);add(t.readback.file);}add(path.join(__dirname,'results',tag,'engine.log'));
 }
 const r=run(`nanite-material-precache-${scene}-compare-20261112`);assert(r.comparisons.length>=12);correctness.push({scene,comparisons:r.comparisons});
}
const recovery=[];
for(const mode of ['packed','scalar']){
 const d=path.join(__dirname,'results/nanite-material-precache-recovery-20261112'),f=path.join(d,mode+'.json'),r=read(f);
 assert(r.pass&&r.tests.length===8&&!r.errors.length&&!r.gpu.errors.length);add(f);pkg(r.package);
 const s=path.join(d,mode+'-source.cjs');verify({file:s,sha256:r.source.sha256});add(s);
 recovery.push({mode,tests:r.tests.length,report:audit(f)});
}
const eligibility=run('nanite-material-precache-eligibility-20261112');assert(eligibility.idleStatus&&eligibility.tests.length===13);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);if(!t.registered){assert.equal(t.gpu.dispatches,0);assert.deepEqual(t.gpu.resources,{});}}
const motionTag='nanite-material-precache-motion-abba-20261112',motion=run(motionTag);
assert(motion.headed&&motion.tour&&!motion.trace&&!motion.gpuProbe&&!motion.gpuTimestamps);
assert.deepEqual(motion.runs.map(r=>r.materialPrecache.enabled),[0,1,1,0]);
const distribution=values=>{const s=values.toSorted((a,b)=>a-b),low=s.slice(-Math.ceil(s.length/100));return {frames:s.length,fps:s.length*1000/s.reduce((a,b)=>a+b,0),low1:low.length*1000/low.reduce((a,b)=>a+b,0),maxMs:s.at(-1),over50:s.filter(v=>v>50).length};};
const performance={};
for(const enabled of [0,1])performance[enabled?'on':'off']=distribution(motion.runs.filter(r=>r.materialPrecache.enabled===enabled).flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}));
for(const r of motion.runs){assert(r.pass&&!r.errors.length);for(const p of r.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(__dirname,'results',motionTag,r.index+'-'+r.mode+'.'+ext));}
const analysisFile=path.join(__dirname,'results',motionTag,'analysis.json'),analysis=read(analysisFile);verify(analysis.input);add(analysisFile);
const analysisSource=path.join(path.dirname(analysisFile),'analysis-source.cjs');verify({file:analysisSource,sha256:analysis.source.sha256});add(analysisSource);
performance.runs=analysis.runs.map(r=>({index:r.index,overall:r.overall,lowestFPS5s:r.windows.toSorted((a,b)=>a.fps-b.fps)[0],travelCm:r.travelCm,turnDegrees:r.turnDegrees}));
const repeatTag='nanite-material-precache-motion-baab-20261112',repeat=run(repeatTag);
assert(repeat.headed&&repeat.tour&&!repeat.trace&&!repeat.gpuProbe&&!repeat.gpuTimestamps);
assert.deepEqual(repeat.runs.map(r=>r.materialPrecache.enabled),[1,0,0,1]);
performance.repeat={};
for(const enabled of [0,1])performance.repeat[enabled?'on':'off']=distribution(repeat.runs.filter(r=>r.materialPrecache.enabled===enabled).flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}));
for(const r of repeat.runs){assert(r.pass&&!r.errors.length);for(const p of r.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(__dirname,'results',repeatTag,r.index+'-'+r.mode+'.'+ext));}
const repeatAnalysisFile=path.join(__dirname,'results',repeatTag,'analysis.json'),repeatAnalysis=read(repeatAnalysisFile);verify(repeatAnalysis.input);add(repeatAnalysisFile);
const repeatAnalysisSource=path.join(path.dirname(repeatAnalysisFile),'analysis-source.cjs');verify({file:repeatAnalysisSource,sha256:repeatAnalysis.source.sha256});add(repeatAnalysisSource);
performance.repeat.runs=repeatAnalysis.runs.map(r=>({index:r.index,overall:r.overall,lowestFPS5s:r.windows.toSorted((a,b)=>a.fps-b.fps)[0]}));
const diagnostics=[];
for(const mode of ['off','on']){
 const tag=`nanite-material-precache-${mode}-diagnostic-20261112`,r=run(tag),d=path.join(__dirname,'results',tag);assert(r.trace&&r.gpuTimestamps&&r.gpuProbe);
 const g=r.runs[0].gpuTimestamps;assert(!g.errors.length&&g.pending===0);
 const target='main_00000930_48a87330 / main_0001fcf8_6f8e54f1';
 const startup=g.startupPipelines.filter(p=>p.label===target),runtime=g.pipelineCreations.filter(p=>p.label===target);
 if(mode==='on'){assert(startup.some(p=>p.kind==='createRenderPipelineAsync'&&p.completionMs>=0&&!p.error));assert.equal(runtime.length,0);}
 else assert(runtime.some(p=>p.kind==='createRenderPipeline'));
 const a=read(path.join(d,'gpu-analysis.json'));verify(a.input);
 const dawn=read(path.join(d,'dawn-analysis.json'));verify(dawn.provenance);
 const dawnSource=path.join(d,'dawn-analysis-source.cjs');verify({file:dawnSource,sha256:dawn.source.sha256});
 for(const n of ['gpu-analysis.json','gpu-analysis-source.cjs','gpu-observer.cjs','dawn-analysis.json','dawn-analysis-source.cjs','0-candidate.log'])add(path.join(d,n));
 for(const p of r.runs){verify(p.phases[0].trace);add(p.phases[0].trace.file);}
 diagnostics.push({mode,startup,runtime,gpu:a.summaries});
}
const buildFile=path.join(__dirname,'build/nanite-material-precache-villa-20261112/runtime-build.json'),build=read(buildFile);
assert(build.pass&&build.fullLinkVerified&&build.lowerMemory64&&!build.trace&&!build.simd);add(buildFile);
for(const p of [...build.sourceFiles,...build.products,build.log,build.linkResponse]){verify(p);if(p===build.log||p===build.linkResponse)add(p.file);}
const baseline=path.join(__dirname,'results',name),beforeFile=path.join(baseline,'baseline-build.json'),before=read(beforeFile);add(beforeFile);
const failureFile=path.join(baseline,'initial-build-failure.json'),failure=read(failureFile);assert(!failure.pass);verify(failure.log);add(failureFile);add(failure.log.file);
const sources=read(path.join(baseline,'sources.json'));add(path.join(baseline,'sources.json'));
for(const [i,n] of sources.entries()){
 const old=path.join(baseline,i+'-before-source'),current=path.join(__dirname,'../../reference-engine',n);add(old);add(current);
 const source=r=>r.sourceFiles.find(p=>p.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
 assert.equal(audit(old).sha256,source(before).sha256);assert.equal(audit(current).sha256,source(build).sha256);
 if(n.endsWith('NaniteWebMaterialPass.cpp')){
  const shader=f=>fs.readFileSync(f,'utf8').split('class FWebNaniteMaterialTilesVS')[1].split('#if !WEB_NANITE_MATERIAL_SHADER_ONLY')[0];
  assert.equal(shader(old),shader(current),'Shader-only class and registration unchanged; complete Stage 2 Cook can be reused');
 }
}
const previousFile=path.join(__dirname,'evidence/nanite-occlusion-batch-20261112.json');assert(read(previousFile).pass);add(previousFile);
const originalFile=path.join(__dirname,'results/nanite-full-scene-conversion-verified.json'),original=read(originalFile);assert(original.pass);original.originalFiles.forEach(verify);add(originalFile);
for(const n of ['collect-nanite-material-precache.cjs','compare-nanite-material-precache.cjs','probe-nanite-hierarchy-batch.cjs','probe-nanite-off-regression.cjs','observe-nanite-motion-gpu.cjs','package-nanite-runtime-variant.cjs','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp'])add(path.join(__dirname,n));
assert(!fs.existsSync(directory));fs.mkdirSync(directory);const records=[];
for(const [i,f] of [...files].entries()){const data=fs.readFileSync(f),archive=path.join(directory,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(data,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(data));records.push({original:audit(f),archive:audit(archive)});}
fs.writeFileSync(path.join(__dirname,'evidence',name+'.json'),JSON.stringify({date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,correctness,recovery,performance,diagnostics,previousEvidence:audit(previousFile),records,
 boundary:'Registered native material pipeline precache checkpoint. Complete Stage 2 Cook reused with unchanged shader class and shader sources; new full runtime build recorded. Fresh-process first movement includes all stalls; GPU/trace diagnostics remain separate. Complete Nanite performance acceptance remains open.'},null,2)+'\n');
console.log({pass:true,archives:records.length,performance});
