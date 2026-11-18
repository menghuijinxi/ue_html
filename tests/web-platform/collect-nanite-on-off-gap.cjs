'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,tag='nanite-on-off-gap-retry-20261112',name='nanite-on-off-gap-20261112',files=new Set();
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const add=f=>{assert(fs.existsSync(f),f);files.add(path.resolve(f));};
const verify=p=>{assert.equal(audit(p.file).sha256,p.sha256,p.file);add(p.file);};
const directory=path.join(root,'results',tag),input=path.join(directory,'report.json'),r=read(input);
assert(r.pass&&r.tour&&r.headed&&!r.trace&&!r.gpuProbe&&!r.gpuTimestamps);
assert.deepEqual(r.nanites,['0','1','1','0']);assert.equal(r.width,2560);assert.equal(r.height,1440);assert.equal(r.seconds,60);
add(input);verify({file:path.join(directory,'source.cjs'),sha256:r.source.sha256});
const analysisFile=path.join(directory,'analysis.json'),analysis=read(analysisFile);verify(analysis.input);add(analysisFile);
verify({file:path.join(directory,'analysis-source.cjs'),sha256:analysis.source.sha256});
const distribution=values=>{const sorted=values.toSorted((a,b)=>a-b),tail=sorted.slice(-Math.ceil(sorted.length/100)),sum=values.reduce((a,b)=>a+b,0);
 return {frames:values.length,fps:values.length*1000/sum,meanMs:sum/values.length,low1:tail.length*1000/tail.reduce((a,b)=>a+b,0),maxMs:sorted.at(-1),over50:values.filter(v=>v>50).length};};
for(const run of r.runs){
 assert(run.pass&&!run.errors.length);assert.equal(run.folder,'nanite-pack-villa-20261112');assert.equal(run.nanite.enabled,Number(r.nanites[run.index]));
 assert(run.nanite.hierarchyBatch&&run.nanite.occlusionBatch&&run.nanite.packBatch&&run.nanite.materialPrecache);
 assert.equal(run.nanite.registered,run.nanite.enabled?2062:0);assert.equal(run.nanite.entries>0,!!run.nanite.enabled);
 assert.deepEqual(run.assets.map(p=>p.sha256),r.runs[0].assets.map(p=>p.sha256));run.assets.forEach(verify);
 const p=run.phases[0];assert.deepEqual(p.before.settings,r.runs[0].phases[0].before.settings);assert.deepEqual(p.after.settings,p.before.settings);
 for(const key of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(p.before.view[key],r.runs[0].phases[0].before.view[key]);
 assert.deepEqual(run.initial.camera,r.runs[0].initial.camera);assert(p.travelCm>1900&&p.turnDegrees>260);
 assert(!p.before.visualClock?.renderTimeFrozen&&!p.before.visualClock?.materialTimeFrozen);
 add(path.join(directory,run.index+'-candidate.log'));add(path.join(directory,run.index+'-candidate.png'));
}
for(const enabled of [0,1])assert.equal(new Set(r.runs.filter(t=>t.nanite.enabled===enabled).map(t=>t.startupConfig.sha256)).size,1);
const performance={};
for(const enabled of [0,1]){
 const phases=r.runs.filter(t=>t.nanite.enabled===enabled).map(t=>t.phases[0]);
 performance[enabled?'on':'off']={...distribution(phases.flatMap(p=>{const times=p.times;return times.slice(1).map((v,i)=>v-times[i]);})),
  rhiMs:phases.reduce((s,p)=>s+p.after.stages.rhiWorkMilliseconds-p.before.stages.rhiWorkMilliseconds,0)/phases.reduce((s,p)=>s+p.after.stages.presented-p.before.stages.presented,0)};
}
performance.gap={fpsLowerPercent:(1-performance.on.fps/performance.off.fps)*100,low1LowerPercent:(1-performance.on.low1/performance.off.low1)*100,extraMeanMs:performance.on.meanMs-performance.off.meanMs};
performance.runs=analysis.runs.map((a,i)=>({index:i,nanite:r.runs[i].nanite,overall:a.overall,rhiMs:r.runs[i].phases[0].result.rhiMs,
 travelCm:a.travelCm,turnDegrees:a.turnDegrees,lowestFPS5s:a.windows.toSorted((a,b)=>a.fps-b.fps)[0]}));
const pkgFile=path.join(root,'build/nanite-pack-villa-20261112/package.json'),pkg=read(pkgFile);assert(pkg.pass);add(pkgFile);
for(const p of pkg.products){assert.equal(audit(p.file).sha256,p.sha256);if(/(?:index.html|content-files.json|config-files.json|asset-versions.json)$/.test(p.file))add(p.file);}
verify(pkg.build);const build=read(pkg.build.file);assert(build.pass&&build.fullLinkVerified);for(const p of build.products)assert.equal(audit(p.file).sha256,p.sha256);
const failed=path.join(root,'results/nanite-on-off-gap-20261112/report.json'),failure=read(failed);assert(!failure.pass&&failure.failure.includes('ERR_CONNECTION_REFUSED'));add(failed);
verify({file:path.join(path.dirname(failed),'source.cjs'),sha256:failure.source.sha256});
const previous=path.join(root,'evidence/nanite-pack-batch-20261112.json');assert(read(previous).pass);add(previous);add(__filename);
for(const f of ['Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebRaster.cpp','Engine/Shaders/Private/Nanite/WebNaniteRaster.usf',
 'Engine/Source/Runtime/Engine/Private/Nanite/NaniteWebGBuffer.cpp','Engine/Source/Runtime/Renderer/Private/Nanite/NaniteWebMaterialPass.cpp'])add(path.join(root,'../../reference-engine',f));
const output=path.join(root,'evidence',name);assert(!fs.existsSync(output));fs.mkdirSync(output);const records=[];
for(const [i,file] of [...files].entries()){const data=fs.readFileSync(file),archive=path.join(output,i+'-'+path.basename(file)+'.gz');fs.writeFileSync(archive,zlib.gzipSync(data,{level:9}));assert(zlib.gunzipSync(fs.readFileSync(archive)).equals(data));records.push({original:audit(file),archive:audit(archive)});}
fs.writeFileSync(path.join(root,'evidence',name+'.json'),JSON.stringify({date:new Date().toISOString(),pass:true,naniteFullPerformanceAccepted:false,performance,settings:r.runs[0].phases[0].before.settings,records,
 boundary:'Current immutable converted Villa package, only startup r.Nanite changes. Serial fresh processes, normal time, first 60-second simultaneous translation/rotation, all stalls retained. Off uses cooked fallback geometry. Viewport submissions are not physical display timestamps; this is a scene-level cost comparison. RHI telemetry is asynchronous and does not establish exclusive stall causation. No claim of identical Nanite/fallback triangles or final performance acceptance.'},null,2)+'\n');
console.log(JSON.stringify({pass:true,archives:records.length,performance},null,2));
