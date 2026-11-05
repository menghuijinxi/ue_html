'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const root=path.resolve(__dirname,'../../..'),results=path.join(root,'tests/web-platform/results');
const load=f=>JSON.parse(fs.readFileSync(path.join(results,f)));
const micro=load('compile-options-20261105-analysis.json');assert(micro.pass);
const variants=load('compile-variants-20261105/report.json');assert.equal(variants.matched,23);
for(const v of variants.variants){assert(v.complete);if(v.variant.startsWith('spirv-'))assert(v.modules.every(m=>m.beforeSha===m.afterSha));}
const suites=['native','browser','scheduling'].map(s=>load(`compile-options-20261105-${s}-suite.json`));
assert(suites.every(s=>s.pass));assert.equal(suites.reduce((n,s)=>n+s.rounds.length,0),111);
const scene=load('compile-options-scene-20261105-scene-analysis.json');assert(scene.pass);
const diagnostics=[];
for(const tag of ['compile-options-scene-trace-20261105','compile-options-scene-confirm-20261105']) {
  const raw=load(tag+'.json'),trace=load(tag+'-analysis.json');assert(raw.pass&&trace.pass);
  for(const [i,r]of raw.runs.entries()){
    assert(r.pass);assert.deepEqual(r.errors,[]);assert.deepEqual(r.final.failures,[]);
    assert.equal(r.final.pending,0);assert.equal(r.initial.threads.taskWorkers,r.coreLimit-1);
    const phase=trace.runs[i].phases.find(p=>p.name==='first-tour');
    assert.equal(phase.stages['CreatePipelineAsyncEvent::InitializeImpl'].count,15);
    diagnostics.push({tag,index:r.index,cores:r.coreLimit,schedule:r.schedule,report:audit(path.join(results,tag+'.json')),
      source:raw.source,packageFiles:raw.packageFiles,trace:trace.runs[i].trace,stages:phase.stages,
      diagnosticFrameMs:phase.submissionSummary.maximum,scheduling:r.final.scheduling});
  }
}
const original=load('compile-options-scene-20261105.json');
const sources=['benchmark-web-pso-corpus.cjs','web-pso-replay-worker.js','probe-web-runtime-pso.cjs',
  ...['benchmark-same-dxc.cpp','optimize-spirv.cpp','prepare-shader-variants.cjs','run-compile-options.cjs','analyze-compile-options.cjs','analyze-compile-scene.cjs','collect-compile-options-evidence.cjs'].map(f=>'diagnostics/'+f)].map(f=>audit(path.join(root,'tests/web-platform',f)));
const evidence={date:new Date().toISOString(),pass:true,
  boundary:'111 microbenchmark trials and nine complete-scene runs (four untraced ABBA, five diagnostic traces). No PSO precaching, no renderer quality changes, no production defaults changed. All browser trials disable shader disk cache; native/driver caches not globally cleared. Shared-stage scheduling helps deterministic independent corpus, but full-scene control varies from 13 to 11 DXC calls and does not establish stable extra savings. Source files in this evidence are final reviewed tools; exact executed browser/probe source audits are also retained in raw per-run reports/snapshots. Final native harness rebuild smoke verified identical O3 DXIL hashes.',
  sources,suites,micro,variants,scene,diagnostics,packageFiles:original.packageFiles,
  screenshots:original.runs.map(r=>audit(path.join(results,`compile-options-scene-20261105-${r.index}-async.png`))),
  nativeCompiler:suites[0].compiler,nativeHarness:audit(path.join(results,'benchmark-same-dxc.exe')),
  smoke:audit(path.join(results,'compile-options-native-final-smoke.json')),
  references:[{url:'https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/Toggles.cpp',claim:'D3DSkipShaderOptimizations is an internal Dawn device toggle; diagnostic launch flags used.'},
    {url:'https://www.w3.org/TR/webgpu/#dictdef-gpurenderpipelinedescriptor',claim:'Standard render pipeline creation descriptors do not expose DXC optimization levels.'}]};
const smoke=load('compile-options-native-final-smoke.json');assert(smoke.success&&smoke.rounds[0].shaders.length===30&&smoke.rounds[0].shaders.every(s=>s.matchesBrowser));
fs.writeFileSync(path.join(root,'tests/web-platform/evidence/shader-compile-options-20261105.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({pass:true,microTrials:111,sceneRuns:9,variants:variants.variants.length}));
