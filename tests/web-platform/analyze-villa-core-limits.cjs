'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const input=process.argv[2]; assert(input, 'Pass the completed core-limit benchmark JSON');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const report=read(input), root=path.resolve(__dirname,'../..');
assert(report.pass && report.coreLimits && [4,6,8].every(n=>report.coreLimits.includes(n)));
assert.equal(report.runs.length,report.coreLimits.length);
assert.equal(report.psoPrecache,false);
assert.deepEqual(report.qualityOverrides,[]);
const reference=report.runs[0].before;
const viewKey=v=>['width','height','outputWidth','outputHeight','antiAliasing','x','y','outputX','outputY'].map(k=>v[k]);
for(const run of report.runs){
  assert.equal(run.mode,'full'); assert.equal(run.errors.length,0);
  assert.equal(run.before.threads.cores,run.coreLimit);
  assert.equal(run.before.threads.taskWorkers,run.coreLimit-1);
  assert.equal(new Set(['gameThread','renderThreadId','rhiThreadId'].map(k=>run.before.threads[k])).size,3);
  for(const state of [run.before,run.after]){
    assert.deepEqual(state.camera,reference.camera);
    assert.deepEqual(state.settings,reference.settings);
    assert.deepEqual(viewKey(state.view),viewKey(reference.view));
    assert.equal(state.memory.pending,0,'Texture streaming still pending');
    for(const key of ['residentMips','requestedMips','residentBytes'])
      assert.equal(state.memory[key],run.before.memory[key],'Texture residency changed within a measured run: '+key);
  }
}
const summary=[4,6,8].map(cores=>{
  const runs=report.runs.filter(r=>r.coreLimit===cores);
  const frames=runs.reduce((s,r)=>s+r.measurement.frames,0);
  const ms=runs.reduce((s,r)=>s+r.measurement.end-r.measurement.start,0);
  const weighted=(field)=>runs.reduce((s,r)=>s+r[field]*r.measurement.frames,0)/frames;
  const sampleFrames=runs.reduce((s,r)=>s+r.workload.sampleFrames,0);
  const workload=Object.fromEntries(['drawsPerFrame','indirectDrawsPerFrame','dispatchesPerFrame'].map(k=>
    [k,runs.reduce((s,r)=>s+r.workload[k]*r.workload.sampleFrames,0)/sampleFrames]));
  const fps=frames/ms*1000;
  assert(Math.abs(report.summary[String(cores)].fps-fps)<1e-9);
  return {cores,taskWorkers:cores-1,repetitions:runs.length,frames,milliseconds:ms,fps,
    frameMs:report.summary[String(cores)].frameMs,rhiWorkMs:weighted('rhiWorkMs'),
    resourceProxyCallsPerFrame:weighted('resourceProxyCallsPerFrame'),workload,
    textureResidency:runs.map(r=>Object.fromEntries(['residentMips','requestedMips','residentBytes'].map(k=>[k,r.before.memory[k]]))),
    runs:runs.map(r=>({index:r.index,fps:r.fps,low1Fps:r.frameMs.low1Fps,
      rhiWorkMs:r.rhiWorkMs,taskWorkers:r.before.threads.taskWorkers,workload:r.workload}))};
});
for(const row of summary){
  row.fpsChangeVs4Percent=(row.fps/summary[0].fps-1)*100;
  row.low1ChangeVs4Percent=(row.frameMs.low1Fps/summary[0].frameMs.low1Fps-1)*100;
}
const packageFile=path.join(__dirname,'results',report.folder+'-package.json');
const buildFile=path.join(__dirname,'results',report.folder+'-build.json');
assert(read(packageFile).pass && read(buildFile).pass);
const artifacts=[input,packageFile,buildFile];
for(const run of report.runs) for(const ext of ['log','png'])
  artifacts.push(input.replace(/\.json$/,'')+'-'+run.index+'-'+run.mode+'.'+ext);
const result={date:new Date().toISOString(),pass:true,summary,browser:report.browser,
  view:reference.view,settings:reference.settings,camera:reference.camera,qualityOverrides:report.qualityOverrides,
  psoPrecache:report.psoPrecache,packageFiles:report.packageFiles,
  sources:[__filename,path.join(__dirname,'benchmark-villa-threading.cjs'),
    path.join(root,'tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp'),
    ...['Public/Web/WebPlatformMisc.h','Private/Web/WebPlatformMisc.cpp'].map(p=>path.join(root,'reference-engine/Engine/Platforms/Web/Source/Runtime/Core',p))].map(audit),
  artifacts:artifacts.map(audit),checks:{fixedCamera:true,fixedSettings:true,fixedResolutionAndAA:true,
    textureResidencyStableWithinRuns:true,
    textureResidencyEqualAcrossRuns:report.runs.every(r=>r.before.memory.residentBytes===reference.memory.residentBytes && r.before.memory.residentMips===reference.memory.residentMips),
    physicalThreadIDsDistinct:true,taskWorkerCountsVerified:true,noRecordedValidationOrFatalErrors:true},
  limitations:['Same pthread WASM and Cook; core limit changes UE task and queued pool sizes, not hardware CPU affinity.',
    'Core counts are browser-reported logical concurrency, not physical CPU topology.',
    'Default spawn only; asynchronous visibility and texture streaming can change actual draw work and mip residency between runs. Residency is recorded, not forced by quality overrides.',
    '1% low uses the reciprocal mean of the slowest 1% frame intervals. RHI frames are completed viewport presents, not display scanout.',
    'RHI work and proxy counters are approximate snapshots; proxy counter does not include every MAIN_THREAD_EM_ASM call.']};
const output=input.replace(/\.json$/,'-analysis.json'); assert(output!==input);
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
