'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const tag=process.argv[2];assert(/^[a-z0-9-]+$/.test(tag));
const dir=path.join(__dirname,'results',tag),file=path.join(dir,'report.json'),r=JSON.parse(fs.readFileSync(file));assert(r.pass&&r.gpuTimestamps);
const output=path.join(dir,'gpu-analysis.json');assert(!fs.existsSync(output));
const summaries=r.runs.map(run=>{
 const gpu=run.gpuTimestamps;assert(gpu.pending===0&&!gpu.errors.length);
 const frames=new Map();
 for(const c of gpu.results){let f=frames.get(c.frame);if(!f){f={frame:c.frame,elapsed:c.elapsed,passes:[]};frames.set(c.frame,f);}f.passes.push(...c.passes);}
 const rows=[...frames.values()].map(f=>{
  let start,end;const phases={};
  for(const p of f.passes){const a=BigInt(p.start),b=BigInt(p.end);if(start===undefined||a<start)start=a;if(end===undefined||b>end)end=b;
   const markers=new Set(p.pipelines.flatMap(k=>gpu.markers[k]||[]));
   const phase=markers.has('WebHierarchyBatchData')?'hierarchy':markers.has('WebOcclusionPrevious')?'hzb':markers.has('WebRasterClusterKeys')?'pack':
    markers.has('WebNativeMaterial')?'native-material':p.label||p.kind;
   const g=phases[phase]??={ms:0,dispatches:0,draws:0,passes:0};g.ms+=p.ns/1e6;g.dispatches+=p.dispatches;g.draws+=p.draws;g.passes++;
  }
  return {frame:f.frame,elapsed:f.elapsed,spanMs:Number(end-start)/1e6,sumMs:f.passes.reduce((s,p)=>s+p.ns/1e6,0),phases,
   longest:f.passes.toSorted((a,b)=>b.ns-a.ns).slice(0,5)};
 }).sort((a,b)=>b.spanMs-a.spanMs);
 return {index:run.index,frames:rows.length,top:rows.slice(0,10)};
});
fs.copyFileSync(__filename,path.join(dir,'gpu-analysis-source.cjs'));
fs.writeFileSync(output,JSON.stringify({source:audit(__filename),input:audit(file),summaries,
 boundary:'Instrumented GPU diagnostics. Per-frame span uses earliest/latest timestamp across every command buffer. A phase includes all work in a shared pass; no FPS acceptance claim.'},null,2)+'\n');
console.log(summaries.map(s=>({index:s.index,frames:s.frames,top:s.top.slice(0,2).map(f=>({frame:f.frame,elapsed:f.elapsed,spanMs:f.spanMs,phases:f.phases}))})));
