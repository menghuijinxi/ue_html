'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const tags=process.argv.slice(2);assert(tags.length&&tags.every(t=>/^[a-z0-9-]+$/.test(t)));
const summaries=[];
for(const tag of tags){
 const file=path.join(__dirname,'results',`gpu-${tag}.json`),r=JSON.parse(fs.readFileSync(file));assert(r.pass&&r.frames.length===16);
 const groups=new Map();
 for(const command of r.capture.results)for(const pass of command.passes){
  const markers=new Set(Object.keys(pass.pipelines).flatMap(p=>r.capture.pipelines[p]?.markers||[]));
  const phase=markers.has('WebHierarchyBatchData')?'hierarchy-batch':markers.has('WebCullLODMode')?'hierarchy-single':
   markers.has('WebOcclusionPrevious')?'hzb':markers.has('WebRasterClusterKeys')?'pack':
   markers.has('WebMaterialTile')?'material-tiles':markers.has('WebNativeMaterial')?'native-material':
   /Nanite.*MicroRaster/.test(pass.label)?'micro-raster':/Nanite.*Raster/.test(pass.label)?'raster':pass.label||pass.kind;
  const g=groups.get(phase)||{phase,milliseconds:0,passes:0,dispatches:0,draws:0};
  g.milliseconds+=pass.nanoseconds/1e6;g.passes++;
  for(const p of Object.values(pass.pipelines)){g.dispatches+=p.dispatches;g.draws+=p.draws;}
  groups.set(phase,g);
 }
 const phases=[...groups.values()].map(g=>Object.fromEntries(Object.entries(g).map(([k,v])=>[k,typeof v==='number'?v/16:v]))).sort((a,b)=>b.milliseconds-a.milliseconds);
 summaries.push({tag,report:audit(file),meanSpanMs:r.meanSpanMs,meanPassMs:r.meanPassMs,view:r.view,phases});
 console.log({tag,meanSpanMs:r.meanSpanMs,phases:phases.slice(0,8)});
}
const output=path.join(__dirname,'results','nanite-batch-hierarchy-20261112','gpu-analysis.json');assert(!fs.existsSync(output));
fs.copyFileSync(__filename,output.replace(/\.json$/,'-source.cjs'));
fs.writeFileSync(output,JSON.stringify({source:audit(__filename),summaries,boundary:'Timestamp diagnostics only. Phase names derive from actual shader markers; a pass duration includes every dispatch in that pass. GPU span includes gaps; summed pass times exclude copies/barriers.'},null,2)+'\n');
