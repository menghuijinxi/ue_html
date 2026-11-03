'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const input=path.resolve(process.argv[2]||path.join(__dirname,'results/draw-api-final.json'));
const output=path.resolve(process.argv[3]||path.join(__dirname,'evidence/draw-api-20261103.json'));
const report=JSON.parse(fs.readFileSync(input)),median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
assert(report.pass&&report.runs.length===report.rounds*4);
for(const f of report.files){const file=path.join(__dirname,f.file);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),f.sha256,'Source/binary changed: '+f.file);}
const cases=[];
for(const backend of ['native-d3d12','native-dawn-d3d12','browser-js-webgpu','browser-wasm64-webgpu'])
for(const draws of report.workload.counts)for(let mode=0;mode<4;mode++){
  const rounds=report.runs.filter(r=>r.backend===backend).map(r=>{
    const c=r.cases.find(c=>c.mode===mode&&c.draws===draws);assert(c.outputVerified);
    const cpu=c.drawLoop.samplesMs.map((_,i)=>c.setup.samplesMs[i]+c.drawLoop.samplesMs[i]+c.finish.samplesMs[i]+c.submit.samplesMs[i]);
    return {round:r.round,drawLoopMs:c.drawLoop.medianMs,cpuFrontendMs:median(cpu),submitMs:c.submit.medianMs,
      gpuMs:c.gpu.medianMs,batch3WallMsPerFrame:c.batch3WallMsPerFrame,bundleBuildMs:c.bundleBuildMs};
  });
  const medians={};for(const key of Object.keys(rounds[0]).filter(k=>k!=='round'))medians[key]=median(rounds.map(r=>r[key]));
  cases.push({backend,draws,mode,medians,rounds});
}
const monitorFile=input.replace(/\.json$/,'-environment.jsonl');
const monitor=fs.existsSync(monitorFile)?fs.readFileSync(monitorFile,'utf8').trim().split(/\r?\n/).map(l=>JSON.parse(l.replace(/^\uFEFF/,''))):[];
const validationPath=input.replace(/\.json$/,'-validation.json');
const validation=JSON.parse(fs.readFileSync(validationPath));assert(validation.pass&&validation.cases.every(c=>c.outputVerified));
const validationLog=validationPath.replace(/\.json$/,'.log');
const evidence={date:report.date,input:path.relative(__dirname,input),rawSha256:crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'),
  pass:true,rounds:report.rounds,build:report.build,environment:report.environment,browser:report.browser,browserCommand:report.browserCommand,
  gpuDevices:report.gpu.gpu.devices,workload:report.workload,files:report.files,
  verification:{cases:report.runs.reduce((n,r)=>n+r.cases.length,0),allPixelsVerified:true,browserIsolated:report.runs.filter(r=>r.backend.startsWith('browser')).every(r=>r.crossOriginIsolated),
    d3d12DebugLayer:{pass:true,cases:validation.cases.length,separateFromTimings:true,logSha256:crypto.createHash('sha256').update(fs.readFileSync(validationLog)).digest('hex')}},
  environmentSamples:monitor,cases};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
console.table(cases.filter(c=>c.draws===3200).map(c=>({backend:c.backend,mode:c.mode,...c.medians})));
