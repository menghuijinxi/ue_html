'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const name='nanite-micro-batch-20261113',root=__dirname,directory=path.join(root,'evidence',name),files=new Set(),packages=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
function pkg(p){verify(p);if(packages.has(p.file))return;packages.add(p.file);add(p.file);const r=read(p.file);assert(r.pass);
 for(const a of r.products){verify(a);if(/(?:index.html|config-files.json|content-files.json|asset-versions.json)$/.test(a.file))add(a.file);}
 if(r.build){verify(r.build);add(r.build.file);}
}
function run(tag){const file=path.join(root,'results',tag,'report.json'),r=read(file);assert(r.pass,r.failure);add(file);
 const source=path.join(path.dirname(file),'source.cjs');verify({file:source,sha256:r.source.sha256});add(source);if(r.package)pkg(r.package);return r;
}
const correctness=[];
for(const tag of ['nanite-micro-default-correctness-20261113','nanite-micro-default-scalar-20261113','nanite-micro-villa-correctness-20261113']){
 const r=run(tag);assert(r.micro&&r.comparisons.length>=(r.villa?4:3)&&!r.errors.length&&!r.gpu.errors.length);
 for(const t of r.tests){verify(t.readback);add(t.readback.file);const snapshot=read(t.readback.file);
  if(t.batch&&t.entries>1){assert(t.batched>0);assert(snapshot.microDispatchArguments.length>0);}
 }
 add(path.join(root,'results',tag,'engine.log'));
 correctness.push({tag,scalar:r.scalar,comparisons:r.comparisons,dispatches:r.tests.filter(t=>t.entries).map(t=>({label:t.label,batch:t.batch,entries:t.entries,batched:t.batched,dispatchBuffers:t.dispatchBuffers}))});
}
const argumentTag='nanite-micro-arguments-20261113',argumentsResult=run(argumentTag);assert.equal(argumentsResult.cases.length,36);assert(!argumentsResult.gpu.errors.length);
for(const n of ['arguments.wgsl','input.json'])add(path.join(root,'results',argumentTag,n));
const recovery=[];
for(const mode of ['packed','scalar']){
 const dir=path.join(root,'results/nanite-micro-recovery-20261113'),file=path.join(dir,mode+'.json'),r=read(file);assert(r.pass&&!r.errors.length&&!r.gpu.errors.length);add(file);pkg(r.package);
 const source=path.join(dir,mode+'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);
 assert.equal(r.tests.length,8);for(const t of r.tests){assert.equal(t.history.length,16);for(const row of t.history)if(row.targetPresent&&!row.occluderBlocking)assert(row.candidate);}
 recovery.push({mode,tests:r.tests.length,report:audit(file)});
}
const materials=[];
for(const [tag,count] of [['nanite-micro-programmable-20261113',52],['nanite-micro-wpo-20261113',36]])for(const scalar of [false,true]){
 const dir=path.join(root,'results',tag),file=path.join(dir,scalar?'browser-scalar.json':'browser.json'),r=read(file);
 assert(r.pass&&r.scalar===scalar&&r.tests.length===count&&!r.errors.length&&!r.gpu.errors.length);add(file);pkg(r.package);
 const source=path.join(dir,scalar?'scalar-source.cjs':'packed-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);
 for(const t of r.tests){verify(t.image);add(t.image.file);}
 if(r.geometry){verify(r.geometry);add(r.geometry.file);assert(!r.validationFailures.length);}
 materials.push({tag,scalar,tests:count,report:audit(file)});
}
const fixtureFile=path.join(root,'build/nanite-micro-regression-content-20261113/package.json'),fixture=read(fixtureFile);
assert(fixture.pass&&fixture.replacements.length===2);pkg(audit(fixtureFile));for(const p of fixture.inputs){verify(p);add(p.file);}
const eligibilityTag='nanite-micro-eligibility-20261113',eligibility=run(eligibilityTag);assert(eligibility.idleStatus&&eligibility.tests.length===13);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);if(!t.registered){assert.equal(t.gpu.dispatches,0);assert.deepEqual(t.gpu.resources,{});}}
function distribution(values){const sorted=values.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length/100));return {frames:values.length,fps:values.length*1000/values.reduce((a,b)=>a+b,0),low1:tail.length*1000/tail.reduce((a,b)=>a+b,0),maxMs:sorted.at(-1),over50:values.filter(v=>v>50).length};}
function performance(tag,field){const r=run(tag);assert(r.headed&&r.tour&&!r.trace&&!r.gpuProbe&&!r.gpuTimestamps);assert.equal(r.seconds,60);assert.deepEqual(r.runs.map(v=>v[field].enabled),[0,1,1,0]);
 const dir=path.join(root,'results',tag),analysis=read(path.join(dir,'analysis.json'));verify(analysis.input);add(path.join(dir,'analysis.json'));
 verify({file:path.join(dir,'analysis-source.cjs'),sha256:analysis.source.sha256});add(path.join(dir,'analysis-source.cjs'));
 for(const v of r.runs){assert(v.pass&&!v.errors.length);for(const p of v.assets){verify(p);add(p.file);}for(const ext of ['log','png'])add(path.join(dir,v.index+'-'+v.mode+'.'+ext));}
 const merged={};for(const enabled of [0,1])merged[enabled?'on':'off']=distribution(r.runs.filter(v=>v[field].enabled===enabled).flatMap(v=>{const t=v.phases[0].times;return t.slice(1).map((x,i)=>x-t[i]);}));
 return {tag,field,...merged,runs:analysis.runs.map(v=>({index:v.index,setting:v[field],overall:v.overall,lowestFPS5s:v.windows.toSorted((a,b)=>a.fps-b.fps)[0],travelCm:v.travelCm,turnDegrees:v.turnDegrees}))};
}
const motion=performance('nanite-micro-motion-abba-20261113','micro'),naniteGap=performance('nanite-micro-onoff-abba-20261113','nanite');
const gpuFile=path.join(root,'results/nanite-micro-controlled-gpu-20261113/gpu-analysis.json'),gpu=read(gpuFile);add(gpuFile);assert.equal(gpu.summaries.length,2);
const gpuSource=gpuFile.replace(/\.json$/,'-source.cjs');verify({file:gpuSource,sha256:gpu.source.sha256});add(gpuSource);
assert.equal(gpu.summaries[0].nativeBeforeCapture.entries,gpu.summaries[1].nativeBeforeCapture.entries);
for(const key of ['pack','nanite-raster','native-material'])assert.deepEqual(gpu.summaries[0].pipelineWork[key],gpu.summaries[1].pipelineWork[key],key+' unchanged work');
assert(gpu.summaries[1].pipelineWork['micro-raster'].dispatches<gpu.summaries[0].pipelineWork['micro-raster'].dispatches);
for(const s of gpu.summaries){assert(!s.nativeBeforeCapture.primitiveVisibility);verify(s.report);add(s.report.file);const r=read(s.report.file);assert(r.pass);pkg(r.package);
 const source=s.report.file.replace(/\.json$/,'-source.cjs');verify({file:source,sha256:r.source.sha256});add(source);}
const buildFile=path.join(root,'build/nanite-micro-villa-20261113/runtime-build.json'),build=read(buildFile);assert(build.pass&&build.fullLinkVerified&&build.lowerMemory64&&!build.trace&&!build.simd);add(buildFile);
for(const p of [...build.sourceFiles,...build.products,build.log,build.linkResponse]){verify(p);if(p===build.log||p===build.linkResponse)add(p.file);}
const before=path.join(root,'results',name);add(path.join(before,'baseline-build.json'));add(path.join(before,'sources.json'));
const previousFile=path.join(root,'evidence/nanite-pack-batch-20261112.json'),previous=read(previousFile);assert(previous.pass);add(previousFile);
for(const [i,n] of read(path.join(before,'sources.json')).entries()){
 const old=path.join(before,i+'-before-source'),current=path.join(root,'../../reference-engine',n);add(old);add(current);
 assert(previous.records.some(r=>r.original.file.replaceAll('\\','/').endsWith('/'+n)&&r.original.sha256===audit(old).sha256),'Baseline source '+n);
}
for(const label of ['web-engine-webgpu-sm5-default','web-project-nanite-micro-villa-20261113-desktop'])for(const kind of ['cook','stage']){
 const file=path.join(root,'results',label+'-'+kind+'-results.json'),r=read(file);assert(r.pass);add(file);
 for(const p of [r.log,r.moduleBuildLog,r.hostPreparationReport,r.hostPreparationLog,r.shaderSourcesReport,r.shaderInventory?.artifact].filter(Boolean)){verify(p);add(p.file);}
 if(kind==='cook'){const inventory=read(r.shaderInventory.artifact.file);for(const [type,count] of [['FWebNaniteMicroRasterCS',6],['FWebNaniteMicroArgumentsCS',1]])assert(inventory.types.some(t=>t.name===type&&t.permutations===count));}
}
for(const scene of ['default','villa'])add(path.join(root,'build',`nanite-micro-${scene}-content-20261113/package.json`));
for(const n of fs.readdirSync(before).filter(n=>n.endsWith('.log')))add(path.join(before,n));
const originalFile=path.join(root,'results/nanite-full-scene-conversion-verified.json'),original=read(originalFile);assert(original.pass);original.originalFiles.forEach(verify);add(originalFile);
for(const n of ['collect-nanite-micro-batch.cjs','verify-nanite-micro-batch-arguments.cjs','probe-nanite-hierarchy-batch.cjs','probe-nanite-off-regression.cjs','profile-web-gpu.cjs','analyze-nanite-hierarchy-gpu.cjs','analyze-nanite-walk-turn.cjs','package-nanite-shadow-guard.cjs','package-nanite-runtime-variant.cjs','web-engine-worker.js','../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp'])add(path.join(root,n));
assert(!fs.existsSync(directory));fs.mkdirSync(directory);const records=[];
for(const [i,file] of [...files].entries()){const bytes=fs.readFileSync(file),archive=path.join(directory,i+'-'+path.basename(file)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(bytes,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(bytes));records.push({original:audit(file),archive:audit(archive)});}
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify({date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,correctness,argumentCases:argumentsResult.cases.length,recovery,materials,motion,naniteGap,controlledGPU:gpu.summaries,originalFilesVerified:original.originalFiles.length,previousEvidence:audit(previousFile),records,
 boundary:'Rigid micro raster batches use actual visible cluster counts and bounded indirect dispatches. Exact geometry/depth/material comparisons, packed/scalar recovery, empty-scene work checks, complete runtime/Cooks, first movement ABBA and separate GPU diagnostics are archived. All stalls retained. Other raster draws remain per instance; full enabled performance acceptance stays open.'},null,2)+'\n');
console.log({pass:true,archives:records.length,motion,naniteGap});
