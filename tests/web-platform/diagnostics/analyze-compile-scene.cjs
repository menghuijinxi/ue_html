'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const [tag]=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(tag));
const prefix=path.resolve(__dirname,'../results',tag),report=JSON.parse(fs.readFileSync(prefix+'.json'));
assert(report.pass);
const median=a=>{a=a.toSorted((a,b)=>a-b);return(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2;};
const out={date:new Date().toISOString(),pass:false,input:audit(prefix+'.json'),sources:[audit(__filename)],runs:[],groups:[]};
for(const run of report.runs) {
  assert(run.pass);assert.deepEqual(run.errors,[]);assert.deepEqual(run.final.failures,[]);
  assert.equal(run.initial.threads.cores,run.coreLimit);
  assert.equal(run.initial.threads.taskWorkers,run.coreLimit-1);
  const phases=run.phases.map(p=>{
    const requests=p.data.events.filter(e=>e.name.endsWith('PipelineAsync'));
    assert(requests.every(e=>e.completed&&!e.error));
    const points=requests.flatMap(e=>[[e.start,1],[e.completed,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    let live=0,peak=0;for(const [,delta]of points){live+=delta;peak=Math.max(peak,live);}
    return {name:p.name,frames:p.summary.frames,fps:p.summary.fps,low1:p.summary.low1Fps,max:p.summary.maximum,over50:p.summary.over50,over100:p.summary.over100,
      asyncRequests:requests.length,peakRequests:peak,requestSpan:requests.length?Math.max(...requests.map(e=>e.completed))-Math.min(...requests.map(e=>e.start)):0,
      callSum:requests.reduce((s,e)=>s+e.end-e.start,0)};
  });
  out.runs.push({index:run.index,mode:run.mode,cores:run.coreLimit,schedule:run.schedule||'fifo',phases});
}
for(const key of new Set(out.runs.map(r=>[r.mode,r.cores,r.schedule].join('/')))) {
  const runs=out.runs.filter(r=>[r.mode,r.cores,r.schedule].join('/')===key);
  out.groups.push({key,runs:runs.length,phases:runs[0].phases.map(p=>({name:p.name,...Object.fromEntries(Object.keys(p).filter(k=>k!=='name').map(k=>[k,median(runs.map(r=>r.phases.find(x=>x.name===p.name)[k]))]))}))});
}
out.pass=true;fs.writeFileSync(prefix+'-scene-analysis.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out.groups,null,2));
