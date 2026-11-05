'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const input=option('report'),output=option('output');assert(input&&output&&!fs.existsSync(output));
const root=path.resolve(__dirname,'../..');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const portable=f=>({file:path.relative(root,path.resolve(f)).replaceAll('\\','/'),sha256:audit(f).sha256});
const verify=item=>assert.equal(audit(item.file).sha256,item.sha256,item.file);
const report=read(input);assert(report.pass&&report.runs.length===4);
assert.deepEqual(report.modes,['owner','local','local','owner']);
verify(report.source);report.packageFiles.forEach(verify);
const pkgFile=path.join(__dirname,'results',report.folder+'-package.json'),pkg=read(pkgFile),build=read(pkg.build.file);
assert(pkg.pass&&pkg.psoPrecache&&build.pass&&build.buildSucceeded&&build.wasmValidated);verify(pkg.build);
const checks={explicitPrecache:true,completedPrecache:true,defaultCameraRouteDisabled:true,
  noSteadyPipelineShaderCreation:true,gameFrameCameraDriver:true,continuousMotion:true,
  sameSettings:true,noRuntimeErrors:true};
const reference=report.runs[0].ready;
for(const run of report.runs){
  assert(run.pass&&!run.errors.length&&!run.final.failure);
  assert.equal(run.ready.motion,undefined,'Camera benchmark must remain off before explicit start');
  assert(run.ready.arguments.includes('-WebPSOPrecacheTest')&&run.ready.pso.enabled);
  assert.equal(run.ready.pso.active,0);assert.equal(run.ready.pso.filePrecompileTasks,0);
  assert(run.ready.optimization.asyncPrecacheRequested>0);
  assert.equal(run.ready.optimization.asyncPrecacheRequested,run.ready.optimization.asyncPrecacheCompleted);
  assert.equal(run.ready.optimization.asyncPrecacheFailed,0);assert.equal(run.final.optimization.asyncPrecacheFailed,0);
  assert.equal(run.ready.clock.mode,run.mode);assert(run.ready.history.enabled);assert.equal(run.ready.wake.active,'priority');
  assert.deepEqual(run.ready.settings,reference.settings);assert.deepEqual(run.ready.camera,reference.camera);
  for(const key of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(run.ready.view[key],reference.view[key]);
  for(const phase of run.phases){
    assert.equal(phase.driver.driver,'game-frame');assert(phase.driver.completed&&!phase.driver.active);
    assert(phase.driver.updates>report.seconds*20);
    assert(Math.abs(phase.driver.updates-phase.data.frames)<10,'Camera must update once per Game frame');
    assert.equal(phase.before.pso.active,0);assert.equal(phase.before.pso.filePrecompileTasks,0);
    assert.equal(phase.before.streaming.pending,0);assert.deepEqual(phase.before.settings,phase.after.settings);
    assert(Math.abs(phase.summary.durationSeconds-report.seconds)<.2);
    if(phase.kind==='turning')assert(phase.summary.turnDegrees>350&&phase.summary.travelCm<1);
    else assert(phase.summary.travelCm>1900&&phase.summary.movingSampleFraction>.95);
    if(phase.steadyAccepted)assert.equal(phase.data.events.length,0);
  }
}
const evidence={date:new Date().toISOString(),pass:true,folder:report.folder,checks,
  analyzer:portable(__filename),benchmark:portable(input),executedSource:{file:path.relative(root,report.source.file).replaceAll('\\','/'),sha256:report.source.sha256},
  package:portable(pkgFile),build:portable(pkg.build.file),
  changedSources:['tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp','tests/web-platform/web-engine-worker.js'].map(portable),
  packageFiles:report.packageFiles.map(item=>({file:path.relative(root,item.file).replaceAll('\\','/'),sha256:item.sha256})),
  order:report.modes,secondsPerPhase:report.seconds,warmupSeconds:report.warmup,summary:report.summary,
  settings:reference.settings,view:reference.view,camera:reference.camera,routes:report.runs[0].routes,
  runs:report.runs.map(run=>({index:run.index,mode:run.mode,idleGpu:run.idleGpu,pso:run.ready.pso,
    precacheRequested:run.ready.optimization.asyncPrecacheRequested,precacheCompleted:run.ready.optimization.asyncPrecacheCompleted,
    precachedGraphicsPipelines:run.ready.optimization.precachedGraphicsPipelines,
    errors:run.errors,phases:run.phases.map(p=>({name:p.name,driver:p.driver,
      fps:p.summary.fps,low1Fps:p.summary.low1Fps,durationSeconds:p.summary.durationSeconds,
      travelCm:p.summary.travelCm,turnDegrees:p.summary.turnDegrees,movingSampleFraction:p.summary.movingSampleFraction,
      steadyAccepted:p.steadyAccepted,creations:p.data.events,
      historyHits:p.after.history.hits-p.before.history.hits,streamingPendingAfter:p.after.streaming.pending}))})),
  excluded:{report:portable(path.join(__dirname,'results/scheduling-motion-pso-v72-abba-20261105.json')),
    reason:'RPC camera update rate depended on scheduling mode; preliminary numbers excluded. Fourth run deliberately interrupted by closing its test browser.'},
  limits:['RTX 4090 on this machine, original local Lumen-off Cook/config only; no inference about other devices or Lumen-on.',
    'Scripted camera routes bypass collision and update directly on Game frames; does not measure keyboard/mouse latency or normal player traversal.',
    'First-area means first visit per engine session, with browser/driver caches retained; one uncovered render pipeline still appears per first traversal.',
    'FPS and Low are RHI submission intervals, not physical display or end-to-end input latency.',
    'No motion image quality or temporal artifact acceptance.']};
fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence.summary,null,2));
