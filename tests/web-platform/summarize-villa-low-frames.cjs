'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const option=n=>process.argv.find(v=>v.startsWith('--'+n+'='))?.slice(n.length+3);
const prefix=option('prefix'),output=option('output');assert(prefix&&output&&!fs.existsSync(output));
const results=path.join(__dirname,'results');
const mean=a=>a.reduce((s,v)=>s+v,0)/a.length;
function stats(a){
  assert(a.length>100&&a.every(v=>Number.isFinite(v)&&v>0));
  const s=a.toSorted((a,b)=>a-b);
  return {frames:s.length,fps:1000/mean(s),low1:1000/mean(s.slice(-Math.ceil(s.length*.01))),
    p95:s[Math.floor(s.length*.95)],p99:s[Math.floor(s.length*.99)],max:s.at(-1),
    over25:s.filter(v=>v>25).length,over33:s.filter(v=>v>1000/30).length,over50:s.filter(v=>v>50).length};
}
const report={date:new Date().toISOString(),pass:false,defaultEnabled:false,physicalPresentationValidated:false,
  definition:'RHI submission intervals; 1% Low = 1000 / mean(slowest ceil(N*0.01) intervals). No stalls excluded; no inter-run gaps included.',
  boundary:'Same DOM mouse trajectory and possessed pawn, reset only between phases; frame-weighted workload may differ. This does not measure physical presentation or subjective input latency.',
  order:['control','candidate','candidate','control'],normal:{},captures:{}};
let reference;
for(const [kind,suffixes]of [['control',['a1','a2']],['candidate',['b1','b2']]]){
  const windows=[],all=[];
  for(const suffix of suffixes){
    const tag=prefix+'-'+suffix+'-20261106',file=path.join(results,tag+'.json');
    const r=JSON.parse(fs.readFileSync(file)),run=r.runs[0];
    assert(r.pass&&r.mouseOnly&&r.resetInput&&r.packagedInput&&r.runs.length===1);
    for(const flag of ['gpuProbe','gpuTimestamps','pipeline','profileWorkers','chromeTrace','passCounts','shadowCacheProbe','bufferLifecycle'])assert(!r[flag]);
    assert.deepEqual(r.modes,['page3']);assert.deepEqual(run.errors,[]);
    assert.equal(audit(r.capturedSource.file).sha256,r.source.sha256);
    for(const item of r.files)assert.equal(audit(item.file).sha256,item.sha256);
    reference||=run.before;
    assert.deepEqual(run.before.settings,reference.settings);
    assert.deepEqual(run.before.camera,reference.camera);
    for(const k of ['width','height','outputWidth','outputHeight','antiAliasing'])assert.equal(run.before.view[k],reference.view[k]);
    assert(run.after.ownerBudget[3]<=3&&run.after.ownerBudget[5]<=3&&run.after.ownerBudget[7]<=2);
    const intervals=run.measurement.slice(1).map((t,i)=>t-run.measurement[i]);all.push(...intervals);
    const result=stats(intervals);assert(Math.abs(result.low1-run.result.low1Fps)<1e-6);
    windows.push({tag,folder:r.folder,input:r.inputMode,seconds:r.duration,result,rhiMs:run.rhiMs,workload:run.workload,
      turnDegrees:run.turn,travelCm:run.travel,display:run.display,budget:run.after.ownerBudget,
      poolBefore:run.before.stagingReadbackPool,poolAfter:run.after.stagingReadbackPool,
      psoBefore:run.before.optimization,psoAfter:run.after.optimization});
    report.captures[tag]={raw:audit(file),source:r.source,capturedSource:r.capturedSource,files:r.files};
  }
  report.normal[kind]={result:stats(all),windows};
}
report.changes=Object.fromEntries(['fps','low1','p95','p99'].map(k=>[k+'Percent',100*(report.normal.candidate.result[k]/report.normal.control.result[k]-1)]));
report.pass=true;
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({normal:Object.fromEntries(Object.entries(report.normal).map(([k,v])=>[k,v.result])),changes:report.changes},null,2));
