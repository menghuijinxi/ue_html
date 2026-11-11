'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,name='nanite-motion-shadow-fix-20261112',out=path.join(root,'evidence',name);
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const results=n=>path.join(root,'results',n),files=new Set(),records=[];
const add=f=>{assert(fs.existsSync(f),f);files.add(f);};
const tags=['nanite-walk-turn-20261111-a','nanite-walk-turn-20261111-b','nanite-walk-turn-20261111-isolate',
  'nanite-walk-turn-20261111-trace','nanite-walk-turn-20261111-gpu','nanite-walk-turn-20261111-gpu-legacy',
  'nanite-walk-turn-20261111-shadow-args','nanite-walk-turn-20261111-shadow-point-only',
  'nanite-walk-turn-20261111-fixed-abba','nanite-walk-turn-20261112-fixed-gpu',
  'nanite-shadow-mode-20261111','nanite-shadow-images-20261112','nanite-shadow-images-20261112-retry',
  'nanite-shadow-images-20261112-final','nanite-shadow-scene-20261112'];
for(const tag of tags){
  const dir=results(tag);assert(fs.existsSync(dir),tag);
  const entry=path.join(dir,tag==='nanite-shadow-scene-20261112'?'packed.json':'report.json');
  const recorded=read(entry);assert.equal(audit(path.join(dir,'source.cjs')).sha256,recorded.source.sha256);
  for(const n of fs.readdirSync(dir))if(/\.(?:json|cjs|wgsl|png)$/.test(n)&&!n.endsWith('-trace.json')&&n!=='trace-summary.json')add(path.join(dir,n));
}
for(const n of ['prepare-web-cook-shaders.cjs','probe-nanite-off-regression.cjs','analyze-nanite-walk-turn.cjs',
  'observe-nanite-motion-gpu.cjs','diagnose-point-shadow-vsm.cjs','verify-point-shadow-mode.cjs',
  'package-nanite-shadow-guard.cjs','package-nanite-mode-variant.cjs','probe-point-shadow-images.cjs',
  'probe-nanite-full-scene.cjs','collect-nanite-motion-fix.cjs'])add(path.join(root,n));
add(path.join(root,'../../reference-engine/Engine/Shaders/Private/ShadowDepthPixelShader.usf'));
const cookFile=results('web-project-nanite-shadow-guard-desktop-cook-results.json'),cook=read(cookFile);
assert(cook.pass&&cook.exitCode===0);add(cookFile);add(cook.log.file);add(cook.shaderSourcesReport.file);
const stageFile=results('web-project-nanite-shadow-guard-desktop-stage-results.json');assert(read(stageFile).pass);add(stageFile);
const packageFile=path.join(root,'build/villa-nanite-off-shadow-guard-20261111/package.json'),pkg=read(packageFile);assert(pkg.pass);add(packageFile);
for(const p of pkg.sources){assert.equal(audit(p.file).sha256,p.sha256);add(p.file);}
for(const p of pkg.products){assert.equal(audit(p.file).sha256,p.sha256);if(/(?:index.html|config-files.json|asset-versions.json)$/.test(p.file))add(p.file);}
const onPackage=path.join(root,'build/nanite-shadow-guard-scene-20261112/package.json'),on=read(onPackage);
assert(on.pass&&on.settingsOverrides['r.Nanite']===1);assert.equal(on.parent.sha256,audit(packageFile).sha256);add(onPackage);
assert.equal(audit(on.source.file).sha256,on.source.sha256);
for(const p of on.products){assert.equal(audit(p.file).sha256,p.sha256);if(/(?:index.html|config-files.json|asset-versions.json)$/.test(p.file))add(p.file);}
const formal=read(results('nanite-walk-turn-20261111-fixed-abba/report.json'));
assert(formal.pass&&formal.headed&&formal.tour&&!formal.trace&&!formal.gpuProbe&&!formal.gpuTimestamps&&!formal.pointOnly);
assert.equal(formal.width,2560);assert.equal(formal.height,1440);
assert.deepEqual(formal.runs.map(r=>r.mode),['candidate','off','off','candidate']);
function distribution(values){const sorted=values.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length/100));
  return {frames:values.length,fps:values.length*1000/values.reduce((a,b)=>a+b,0),low1:tail.length*1000/tail.reduce((a,b)=>a+b,0),
    maxMs:sorted.at(-1),over33:values.filter(v=>v>1000/30).length,over50:values.filter(v=>v>50).length,over100:values.filter(v=>v>100).length};}
const comparison={};
for(const mode of ['off','candidate']){
  const runs=formal.runs.filter(r=>r.mode===mode);assert(runs.every(r=>r.pass&&!r.errors.length));
  const values=runs.flatMap(r=>{const t=r.phases[0].times;return t.slice(1).map((v,i)=>v-t[i]);});
  comparison[mode]=distribution(values);
}
assert(comparison.off.maxMs>100&&comparison.candidate.maxMs<50);
assert(comparison.candidate.fps>comparison.off.fps*1.05&&comparison.candidate.low1>comparison.off.low1*1.25);
const analysis=read(results('nanite-walk-turn-20261111-fixed-abba/analysis.json'));
comparison.rollingLow=analysis.runs.map(r=>({mode:r.mode,low1:r.lowest5s.low1,maxMs:r.overall.maxMs}));
assert(read(results('nanite-shadow-mode-20261111/report.json')).pass);
const images=read(results('nanite-shadow-images-20261112-final/report.json'));assert(images.pass);
const scene=read(results('nanite-shadow-scene-20261112/packed.json'));assert(scene.pass);
assert.equal(scene.package.sha256,audit(onPackage).sha256);assert.equal(scene.tests.length,6);
function gpuSummary(tag){
  const r=read(results(tag+'/report.json'));assert(r.pass&&r.gpuTimestamps);
  const g=r.runs[0].gpuTimestamps;assert(!g.errors.length&&!g.pending);
  const frames=new Map();for(const c of g.results){const f=frames.get(c.frame)||{frame:c.frame,elapsed:c.elapsed,passMs:0,cubeMs:0,cubePasses:0,maxCubeMs:0};
    for(const p of c.passes){f.passMs+=p.ns/1e6;if(p.label==='WebCubeShadowFace'){f.cubeMs+=p.ns/1e6;f.cubePasses++;f.maxCubeMs=Math.max(f.maxCubeMs,p.ns/1e6);}}
    frames.set(c.frame,f);}
  return [...frames.values()].sort((a,b)=>b.cubeMs-a.cubeMs).slice(0,8);
}
const gpu={before:gpuSummary('nanite-walk-turn-20261111-gpu'),legacy:gpuSummary('nanite-walk-turn-20261111-gpu-legacy'),
  after:gpuSummary('nanite-walk-turn-20261112-fixed-gpu')};
assert(gpu.before[0].cubeMs>100&&gpu.after[0].cubeMs<5);
fs.mkdirSync(out,{recursive:true});
for(const [i,f] of [...files].entries()){
  const archived=path.join(out,i+'-'+path.basename(f)+'.gz');const bytes=fs.readFileSync(f);
  fs.writeFileSync(archived,zlib.gzipSync(bytes,{level:9}));
  assert(zlib.gunzipSync(fs.readFileSync(archived)).equals(bytes));records.push({original:audit(f),archive:audit(archived),bytes:bytes.length});
}
const report={date:new Date().toISOString(),pass:true,movementRegressionFixed:true,naniteFullPerformanceAccepted:false,
  comparison,gpu,images:images.comparisons,scene:{frames:scene.frames,tests:scene.tests.map(t=>({step:t.step,enabled:t.enabled,entries:t.entries,validation:t.validation}))},
  candidate:audit(packageFile),naniteCandidate:audit(onPackage),records,
  traceLimitation:'The first Chrome trace exhausted its buffer at 22.9 seconds and does not cover the 30–37 second stalls. '
    +'No absent CPU scope is used as evidence. GPU pass timestamps and the shader isolation/readback tests establish the diagnosis.',
  failedProbe:'The initial indirect-argument capture called getMappedRange twice for overlapping bytes. '
    +'Its failure is retained, and its timings are excluded from acceptance. The corrected observer is exercised by fixed-gpu. '
    +'Image collector attempts first referenced a not-yet-defined global, then incorrectly expected both mutually exclusive test clocks. '
    +'Final images use fixed material-expression time and advancing render/streaming time.',
  boundary:'ABBA serial fresh visible Edge sessions, 2560x1440 DPR1, first 60-second interior camera movement and turning, no route warmup. '
    +'Submission intervals include every measured stall; GPU diagnostic runs and frozen image checks are separate. '
    +'Fixes the reproduced Nanite-off point-shadow regression. Nanite-on scene throughput and complete compatibility acceptance remain open.'};
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,comparison,gpu,archives:records.length,bytes:records.reduce((s,r)=>s+fs.statSync(r.archive.file).size,0)}));
