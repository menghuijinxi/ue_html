'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const tags=process.argv.slice(2).filter(a=>!a.startsWith('--'));assert(tags.length&&tags.every(t=>/^[a-z0-9-]+$/.test(t)));
const outputTag=process.argv.find(a=>a.startsWith('--output='))?.slice(9)||'nanite-batch-hierarchy-20261112';assert(/^[a-z0-9-]+$/.test(outputTag));
const summaries=[];
for(const tag of tags){
 const file=path.join(__dirname,'results',`gpu-${tag}.json`),r=JSON.parse(fs.readFileSync(file));assert(r.pass&&r.frames.length===16);
 const groups=new Map(),pipelineWork=new Map();
 const kindOf=shader=>{const marker=shader?.markers||[];return marker.includes('WebRasterClusterKeys')?'pack':
  marker.includes('WebFixedBatchSlotsOutput')?'fixed-arguments':marker.includes('WebFixedBatchData')?'nanite-fixed-merged':
  marker.includes('WebMicroBatchPrefixOutput')?'micro-arguments':marker.includes('WebMicroBatchData')?'micro-raster':
  marker.includes('WebRasterMaterialMasks')?(shader.compute?'micro-raster':'nanite-raster'):
  marker.includes('WebNativeMaterial')?'native-material':shader?.compute?'other-compute':'other-render';};
 for(const command of r.capture.results)for(const pass of command.passes){
  const markers=new Set(Object.keys(pass.pipelines).flatMap(p=>r.capture.pipelines[p]?.markers||[]));
  const microKinds=[...new Set(Object.keys(pass.pipelines).map(p=>kindOf(r.capture.pipelines[p])))];
  const phase=microKinds.some(k=>['micro-arguments','micro-raster','fixed-arguments','nanite-fixed-merged'].includes(k))?
   (microKinds.length===1?microKinds[0]:'mixed: '+microKinds.toSorted().join(', ')):
   markers.has('WebHierarchyBatchData')?'hierarchy-batch':markers.has('WebCullLODMode')?'hierarchy-single':
   markers.has('WebOcclusionBatchData')?'hzb-batch':markers.has('WebOcclusionPrevious')?'hzb':markers.has('WebRasterClusterKeys')?'pack':
   markers.has('WebMaterialTile')?'material-tiles':markers.has('WebNativeMaterial')?'native-material':
   /Nanite.*MicroRaster/.test(pass.label)?'micro-raster':/Nanite.*Raster/.test(pass.label)?'raster':pass.label||pass.kind;
  const g=groups.get(phase)||{phase,milliseconds:0,passes:0,dispatches:0,draws:0};
  g.milliseconds+=pass.nanoseconds/1e6;g.passes++;
  for(const [label,p] of Object.entries(pass.pipelines)){
   g.dispatches+=p.dispatches;g.draws+=p.draws;
   const kind=kindOf(r.capture.pipelines[label]);
   const work=pipelineWork.get(kind)||{draws:0,dispatches:0};work.draws+=p.draws;work.dispatches+=p.dispatches;pipelineWork.set(kind,work);
  }
  groups.set(phase,g);
 }
 const phases=[...groups.values()].map(g=>Object.fromEntries(Object.entries(g).map(([k,v])=>[k,typeof v==='number'?v/16:v]))).sort((a,b)=>b.milliseconds-a.milliseconds);
 summaries.push({tag,report:audit(file),meanSpanMs:r.meanSpanMs,meanPassMs:r.meanPassMs,view:r.view,nativeBeforeCapture:r.nativeBeforeCapture,phases,
  pipelineWork:Object.fromEntries([...pipelineWork].map(([k,w])=>[k,{draws:w.draws/16,dispatches:w.dispatches/16}]))});
 console.log({tag,meanSpanMs:r.meanSpanMs,phases:phases.slice(0,8)});
}
const output=path.join(__dirname,'results',outputTag,'gpu-analysis.json');assert(!fs.existsSync(output));
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.copyFileSync(__filename,output.replace(/\.json$/,'-source.cjs'));
fs.writeFileSync(output,JSON.stringify({source:audit(__filename),summaries,boundary:'Timestamp diagnostics only. Phase names derive from actual shader markers; a pass duration includes every dispatch in that pass. GPU span includes gaps; summed pass times exclude copies/barriers.'},null,2)+'\n');
