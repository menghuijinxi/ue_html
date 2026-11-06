'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const output=process.argv[2];assert(output&&!fs.existsSync(output));
const tags=[
  'mouse-low-renderpool768-probe','mouse-low-submit-coalesce-probe','mouse-low-bundles-probe',
  'mouse-low-querypool-probe','mouse-low-pace8-probe','mouse-low-pace10-probe',
  'mouse-low-shadowcache768-probe','mouse-low-render-state-probe','mouse-low-budgets-diagnostic',
  'mouse-low-group-probe','mouse-low-group-direct-probe','mouse-low-csmoff',
  'mouse-low-group-bindings','mouse-low-group-clocks','mouse-low-querybuffer3',
  'mouse-low-alloc-candidate','mouse-low-readback-pages-probe','mouse-low-motion-hzb',
  'mouse-low-motion-hzb-active','mouse-low-cores6','mouse-low-cores8',
  'mouse-low-input-direct-game-thread','mouse-low-input-shared-mailbox','mouse-low-hold-probe',
  'mouse-low-bounded-clock','mouse-low-gpu-passes','mouse-low-new-motion-probe','mouse-low-new-motion-control-probe'];
const report={date:new Date().toISOString(),defaultChanged:false,
  boundary:'Exploratory single runs and diagnostics, not independent release acceptance. Instrumented runs are not normal FPS measurements. Retain failures and configuration mistakes.',experiments:[],missing:[]};
for(const tag of tags){
  const file=path.join(__dirname,'results',tag+'-20261106.json');
  if(!fs.existsSync(file)){report.missing.push(tag);continue;}
  const r=JSON.parse(fs.readFileSync(file));
  report.experiments.push({tag,raw:audit(file),pass:r.pass,error:r.failure||r.error||null,
    folder:r.folder,seconds:r.duration,input:r.inputMode,occlusion:r.occlusionMode,
    diagnostic:['gpuProbe','gpuTimestamps','pipeline','profileWorkers','chromeTrace','passCounts','bufferLifecycle','shadowCacheProbe'].filter(k=>r[k]),
    runs:r.runs.map(run=>({mode:run.mode,result:run.result,workload:run.workload,rhiMs:run.rhiMs,
      history:run.after?.history,pool:run.after?.stagingReadbackPool,display:run.display,
      settings:run.after?.settings,ownerBudget:run.after?.ownerBudget,localBudget:run.after?.budget}))});
}
report.notes={
  'mouse-low-motion-hzb':'Misconfigured isolation: history URL overrode HZB INI. hzbCompleted remained zero; not an HZB result.',
  'mouse-low-motion-hzb-active':'HZB completed during measurement. Post-measurement recovery assertion incorrectly required hardware queryCaptured; raw failure retained, harness subsequently corrected.',
  'mouse-low-readback-pages-probe':'32-round byte validation and five-view binding checks passed separately, but map batching did not improve low FPS; implementation removed and archived.',
  'mouse-low-alloc-candidate':'Short-run improvement shrank to 4.67% low FPS in the separate 60-second ABBA; not treated as sufficient handoff evidence.'};
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({experiments:report.experiments.length,missing:report.missing}));
