'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,name='nanite-idle-20261112',files=new Set(),output=path.join(root,'evidence',name);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);return p;};
const run=tag=>{const f=path.join(root,'results',tag,'report.json'),r=read(f);assert(r.pass);assert.equal((r.errors||r.runs?.flatMap(t=>t.errors))?.length,0);verify({file:path.join(path.dirname(f),'source.cjs'),sha256:r.source.sha256});add(f);add(path.join(path.dirname(f),'source.cjs'));return r;};
const pkg=r=>{verify(r.package);const p=read(r.package.file);assert(p.pass);add(r.package.file);for(const a of p.products){verify(a);if(/(?:index.html|config-files.json|asset-versions.json|content-files.json)$/.test(a.file))add(a.file);}return p;};
const before=run('nanite-idle-original-before-pass-20261112'),fixed=run('nanite-idle-original-fixed-20261112');
const baselinePackage=pkg(before),fixedPackage=pkg(fixed);
for(const r of [before,fixed])assert(r.scene.meshes===2240&&r.readback.assets===0&&r.readback.registered===0&&r.readback.entries===0);
const start=fixed.start.status,end=fixed.end.status;
assert(!start.allocated&&!start.resources&&!start.initializations&&!start.updates&&!start.stagingBytes&&!start.proxies&&start.enabled);
assert.deepEqual({...end,sequence:start.sequence},start);
assert.equal(fixed.end.history.naniteActiveScenes,0);assert.equal(fixed.end.history.boundsChangeSerial,fixed.start.history.boundsChangeSerial);
assert.equal(fixed.end.history.naniteActivityTransitions,0);
for(const n of ['content.bin','content-files.json','config-files.json'])assert.equal(baselinePackage.products.find(p=>path.basename(p.file)===n).sha256,fixedPackage.products.find(p=>path.basename(p.file)===n).sha256);
const eligibility=run('nanite-idle-eligibility-20261112');assert(eligibility.idleStatus&&eligibility.tests.length===13);pkg(eligibility);
for(const t of eligibility.tests){verify(t.readback);add(t.readback.file);assert.equal(t.idleAfter.initializations,1);
  if(!t.registered){assert.equal(t.idleAfter.updates,t.idleBefore.updates);assert.equal(t.historyAfter.naniteActiveScenes,0);assert.equal(t.historyAfter.boundsChangeSerial,t.historyBefore.boundsChangeSerial);}
  else {assert.equal(t.registered,2062);assert(t.materialComplete&&t.covered>100&&t.idleAfter.updates>t.idleBefore.updates);assert.equal(t.historyAfter.naniteActiveScenes,1);}}
const recoveries=[];
for(const mode of ['packed','scalar']){const d=path.join(root,'results/nanite-idle-recovery-20261112'),f=path.join(d,mode+'.json'),r=read(f);
  assert(r.pass&&!r.errors.length&&!r.gpu.errors.length&&r.tests.length===8);verify({file:path.join(d,mode+'-source.cjs'),sha256:r.source.sha256});add(f);add(path.join(d,mode+'-source.cjs'));pkg(r);
  for(const t of r.tests)for(const h of t.history)if(h.targetPresent&&!h.occluderBlocking)assert(h.candidate);
  recoveries.push({mode,report:audit(f),tests:r.tests.length,frames:r.frames});}
const motion=run('nanite-idle-motion-abba-20261112');assert(motion.headed&&motion.tour&&!motion.trace&&!motion.gpuProbe&&!motion.gpuTimestamps&&motion.runs.length===4);
assert.deepEqual(motion.runs.map(r=>r.mode),['legacy','candidate','candidate','legacy']);
for(const r of motion.runs){for(const p of r.assets){verify(p);add(p.file);}
  for(const ext of ['log','png'])add(path.join(root,'results/nanite-idle-motion-abba-20261112',r.index+'-'+r.mode+'.'+ext));}
const summarize=mode=>{const runs=motion.runs.filter(r=>r.mode===mode);assert(runs.every(r=>r.pass&&!r.errors.length));
  const values=runs.flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);}),sort=values.toSorted((a,b)=>a-b),low=sort.slice(-Math.ceil(sort.length/100));
  return {fps:values.length*1000/values.reduce((a,b)=>a+b,0),low1:low.length*1000/low.reduce((a,b)=>a+b,0),maxMs:sort.at(-1),over50:values.filter(v=>v>50).length,frames:values.length};};
const performance={before:summarize('legacy'),fixed:summarize('candidate')};
assert(performance.fixed.fps>performance.before.fps*.95,'Unexpected movement throughput regression');
const motionDirectory=path.join(root,'results/nanite-idle-motion-abba-20261112');
const analysisFile=path.join(motionDirectory,'analysis.json'),analysis=read(analysisFile);
assert.equal(analysis.input.sha256,audit(path.join(motionDirectory,'report.json')).sha256);
verify({file:path.join(motionDirectory,'analysis-source.cjs'),sha256:analysis.source.sha256});
assert.equal(analysis.runs.length,4);add(analysisFile);add(path.join(motionDirectory,'analysis-source.cjs'));
performance.runs=analysis.runs.map(r=>({mode:r.mode,overall:r.overall,lowest5s:r.lowest5s,
  travelCm:r.travelCm,turnDegrees:r.turnDegrees}));
const build=read(fixedPackage.build.file);verify(fixedPackage.build);assert(build.pass&&build.fullLinkVerified&&build.threads&&build.lowerMemory64&&!build.trace&&!build.simd);
add(fixedPackage.build.file);for(const p of [build.log,build.linkResponse]){verify(p);add(p.file);}
const priorBuild=read(baselinePackage.build.file);verify(baselinePackage.build);add(baselinePackage.build.file);verify(priorBuild.log);add(priorBuild.log.file);
const sourceList=path.join(root,'results',name,'sources.json');add(sourceList);
for(const [i,n] of read(sourceList).entries()){
  const old=path.join(root,'results',name,i+'-before-source'),current=path.join(root,'../../reference-engine',n);add(old);add(current);
  const entry=b=>b.sourceFiles.find(s=>s.file.replaceAll('\\','/').endsWith('/reference-engine/'+n));
  assert.equal(audit(old).sha256,entry(priorBuild).sha256);assert.equal(audit(current).sha256,entry(build).sha256);}
const verification=path.join(root,'results/nanite-full-scene-conversion-verified.json'),original=read(verification);assert(original.pass);add(verification);
for(const p of original.originalFiles)verify(p);
for(const n of ['web-project-nanite-idle-original-desktop-cook-results.json','web-project-nanite-idle-original-desktop-stage-results.json']){
  const f=path.join(root,'results',n),r=read(f);assert(r.pass);add(f);if(r.log){verify(r.log);add(r.log.file);}if(r.shaderSourcesReport){verify(r.shaderSourcesReport);add(r.shaderSourcesReport.file);}}
// Keep all failed diagnostic attempts and preparation failures reviewable.
const failures=[];
for(const e of fs.readdirSync(path.join(root,'results'),{withFileTypes:true}))if(e.isDirectory()&&e.name.startsWith('nanite-idle-original-before-')){
  const f=path.join(root,'results',e.name,'report.json');if(!fs.existsSync(f))continue;const r=read(f);if(r.pass)continue;
  add(f);const source=path.join(path.dirname(f),'source.cjs');verify({file:source,sha256:r.source.sha256});add(source);failures.push({report:audit(f),failure:r.failure,errors:r.errors});}
for(const n of ['failed-cook-preparation.json','failed-global-only-package.cjs','review-interrupted-build.json','first-collector.cjs','failed-first-collector.json'])add(path.join(root,'results',name,n));
const interrupted=read(path.join(root,'results',name,'review-interrupted-build.json'));assert(!interrupted.pass&&!interrupted.compilerErrors.length);verify(interrupted.log);add(interrupted.log.file);
add(path.join(root,'results/web-cook-host-20261112-110817.log'));
for(const n of ['collect-nanite-idle.cjs','probe-nanite-idle.cjs','probe-nanite-eligibility.cjs','probe-nanite-primitive-recovery.cjs',
  'probe-nanite-off-regression.cjs','package-nanite-runtime-variant.cjs','package-nanite-shadow-guard.cjs','prepare-web-cook-host.cjs','web-engine-worker.js',
  '../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteEligibilityTest.cpp'])add(path.join(root,n));
fs.mkdirSync(output,{recursive:true});const records=[];
for(const [i,f] of [...files].entries()){const bytes=fs.readFileSync(f),archive=path.join(output,i+'-'+path.basename(f)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(bytes,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(bytes));records.push({original:audit(f),archive:audit(archive)});}
const report={date:new Date().toISOString(),pass:true,coldNaniteStreamingAllocationEliminated:true,idleStreamingPaused:true,idleOcclusionChangesPaused:true,
  naniteFullPerformanceAccepted:false,originalScene:fixed.scene,coldState:start,performance,recoveries,failures,records,
  boundary:'Original Villa uses the same fresh Cook and configuration before/after. Native counters establish zero cold streamer allocation/updates and no Nanite bounds-change collection. '
    +'After Nanite has actually been used, valid loaded asset pages remain cached while streaming sleeps. '
    +'Per-scene activity changes invalidate old pending/completed occlusion queries once. Both atomic paths preserve first-frame disocclusion. '
    +'GPU resource labels were unavailable in the old runtime and do not independently prove absence of GPU allocations. Ordinary occlusion and texture streaming still operate. '
    +'Movement measurements are viewport submission intervals on this machine; they do not establish full Nanite-on performance acceptance.'};
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,archives:records.length,performance});
