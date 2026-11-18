'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const {readPage}=require('../web-pipeline-prewarm-package.cjs');
const {verifyDesktopRelease}=require('../web-release-defaults.cjs');
const {verifyBuildDefaults,verifyOptimizationContract}=require('../web-optimization-contract.cjs');
const base=path.resolve(__dirname,'..'),read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const name='villa-presentation-performance-20261115',output=path.join(base,'build',name);
const files={before:'results/villa-low-final-before-20261115/report.json',
 after:'results/villa-low-final-after-20261115/report.json',
 baselineTrace:'results/villa-low-baseline2-20261115/report.json',
 cpuTrace:'results/villa-low-cpu-trace-20261115/report.json',
 release:'results/'+name+'-hud-restored.json',build:'results/web-engine-full-thread-build-results.json',
 prepare:'results/web-project-villa-project-settings-20261114-prepare-results.json'};
const inputs=Object.fromEntries(Object.entries(files).map(([key,file])=>[key,read(path.join(base,file))]));
for(const key of ['before','after','baselineTrace','cpuTrace']){
 assert(inputs[key].pass&&inputs[key].hud.visible&&!inputs[key].errors.length,key);
 assert(inputs[key].phases.length===2);
}
assert(!inputs.before.trace&&!inputs.after.trace);
assert(inputs.after.initial.replayScratchEnabled);
assert(Object.keys(inputs.after.optimizationAudit).length===10);
const release=inputs.release;assert(release.pass&&release.performanceHUDVisible&&release.projectConfigurationPreserved);
assert(release.products.every(item=>audit(item.file).sha256===item.sha256));
verifyDesktopRelease(output,release.release);
const page=readPage(output),contract=verifyOptimizationContract(output,page);
const buildAudit=verifyBuildDefaults(inputs.build,page.assets.wasm.sha256);
assert.equal(Object.keys(buildAudit.defaults).length,17);
assert(contract.runtime.reuseReplayScratch);
assert(!page.args.some(arg=>/^-ini:|^-WebPSOPrecacheTest$/.test(arg)));
const original=path.join(base,'build/villa-presentation-20261115');
const baseline=path.join(base,'build',inputs.before.folder);
for(const file of ['content.bin','content-files.json','config-files.json'])
 assert.equal(audit(path.join(output,file)).sha256,audit(path.join(original,file)).sha256,file);
for(const file of ['content.bin','config-files.json','UEWebEngineThreads.wasm','UEWebEngineThreads.js'])
 assert.equal(audit(path.join(output,file)).sha256,audit(path.join(baseline,file)).sha256,file);
assert(inputs.prepare.pass&&inputs.prepare.useProjectSettings&&inputs.prepare.originalProjectUnmodified);
assert(inputs.prepare.sourceFiles.every(item=>audit(item.file).sha256===item.sha256));
const configs=read(path.join(output,'config-files.json'));
for(const name of ['DefaultEngine.ini','DefaultGame.ini','DefaultInput.ini']){
 const item=configs.find(c=>c.path==='/Engine/Programs/UEWebEngine/Config/'+name);
 assert(item&&Buffer.from(item.data,'base64').equals(fs.readFileSync(path.join(path.dirname(inputs.prepare.originalProject),'Config',name))));
}
assert.deepEqual(inputs.before.initial.settings,inputs.after.initial.settings);
for(const input of [inputs.before,inputs.after])for(const phase of input.phases){
 assert.deepEqual(phase.before.settings,phase.after.settings);
 assert.equal(phase.after.history.naniteActiveScenes,0);
 assert(phase.after.motion.completed&&phase.after.motion.mode===3&&phase.after.motion.updates>200);
}
const pack=read(path.join(output,'pipeline-prewarm.json'));
assert.deepEqual(page.assets.pipelineWarmup.modes,[3,2,1]);
assert.equal(page.assets.pipelineWarmup.seconds,20);
const captures=read(release.release.prewarm.capture.file);
assert(captures.pass&&captures.runs.some(r=>r.pass&&r.optimizationAudit?.version===contract.version));
const baselineAttributionFile=path.join(base,'results/villa-low-baseline2-20261115/trace-attribution.json');
const cpuAttributionFile=path.join(base,'results/villa-low-cpu-trace-20261115/trace-attribution.json');
const oldTrace=read(baselineAttributionFile),newTrace=read(cpuAttributionFile);
const compileEvents=oldTrace.gpuCompiles.filter(e=>e.name==='CompileShaderDXC');
assert(compileEvents.some(e=>e.dur>300000)&&compileEvents.some(e=>e.dur>200000));
assert.equal(newTrace.gpuCompiles.length,0);
const streamingWaits=newTrace.longFrames.flatMap(frame=>frame.profiles.filter(p=>p.role==='Render').flatMap(p=>
 p.hotStacks.filter(s=>/FTexture2DStreamIn_IO_AsyncReallocate/.test(s.name)).map(s=>({frame:frame.frame.frame,
  frameMs:frame.frame.ms,waitMs:s.ms,stack:s.name.split('\n').slice(0,11)}))));
assert(streamingWaits.some(wait=>wait.waitMs>100));
const brief=input=>({folder:input.folder,seconds:input.seconds,trace:input.trace,
 settings:input.initial.settings,environmentBefore:input.environmentBefore.cpu,environmentAfter:input.environmentAfter.cpu,
 phases:input.phases.map(p=>({name:p.name,...p.summary,prewarmMissesBefore:p.before.prewarm.counts.misses,
  prewarmMissesAfter:p.after.prewarm.counts.misses,longFrames:p.long.filter(f=>f.ms>100).map(({frame,ms,rhiMs,renderMs,gameMs,pendingTextures,prewarmMisses})=>
   ({frame,ms,rhiMs,renderMs,gameMs,pendingTextures,prewarmMisses}))}))});
const report={date:new Date().toISOString(),pass:true,output,
 url:'http://127.0.0.1:8775/build/'+name+'/index.html',
 hardware:{gpu:'NVIDIA GeForce RTX 4090',driver:'621.24',userRTX3070Verified:false},
 originalInputsUnmodified:inputs.prepare.sourceFiles.length,exactProjectConfigCount:3,
 rendererOverrides:[],performanceHUDVisible:true,comparison:{before:brief(inputs.before),after:brief(inputs.after)},
 pipelineWarmup:{recipe:page.assets.pipelineWarmup,capture:release.release.prewarm.capture,
  modules:pack.modules.length,pipelines:pack.descriptors.length,
  routes:captures.runs.find(r=>r.pass&&r.engine==='ours').scriptedMotion.map(s=>s.motion)},
 optimizationContract:{version:contract.version,defaults:contract.defaults,explicitOverrides:contract.explicitOverrides,
  runtime:contract.runtime,nativeReadback:inputs.after.optimizationAudit},
 replayScratch:inputs.after.phases.at(-1).after.scratch,
 traceAttribution:{baselineTrace:inputs.baselineTrace.traceFile,cpuTrace:inputs.cpuTrace.traceFile,
  compileEvents,streamingWaits,traceExcludedFromFPS:true},
 remaining:'First movement still contains a 113 ms frame; average 28–30 FPS in this run has not recovered to the historical 50+ FPS. Synchronous texture reallocation/owner proxy and frame-fence waits remain. Traced CPU samples locate waits, not a separately validated fix for streaming or driver latency.',
 sourceAudits:[...Object.values(files).map(file=>path.join(base,file)),baselineAttributionFile,cpuAttributionFile,
  __filename,path.join(__dirname,'analyze-villa-low-trace.py')].map(audit),
 products:release.products,
 boundary:'Two sequential normal-clock 20 s first/repeat route samples on one RTX 4090 at 1280x720 DPR 1. RHI owner submission intervals, not physical scanout. No trace or GPU draw wrapper in accepted comparison. CPU/driver trace runs are diagnostic only. Final HUD text was refreshed after the performance comparison; its packaged hashes match the subsequent CPU trace. No RTX 3070 result or stable average-FPS restoration is claimed.'};
const evidence=path.join(base,'evidence/villa-low-frames-20261115.json');
fs.writeFileSync(evidence,JSON.stringify(report,null,2));
console.log(JSON.stringify({pass:true,evidence,firstBefore:inputs.before.phases[0].summary,
 firstAfter:inputs.after.phases[0].summary,repeatAfter:inputs.after.phases[1].summary,streamingWaits:streamingWaits.length}));
