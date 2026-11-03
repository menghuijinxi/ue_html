'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),results=path.join(__dirname,'results');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const valid=x=>{assert.equal(audit(x.file).sha256,x.sha256,x.file);return x;};
const experiments=[
 {folder:'villa-bridge-extras-v38',audit:'v38-compile-optimization-audit.json',level:[],renderingAccepted:true,linkSnapshot:'v38-original-link.rsp'},
 {folder:'villa-final-link-o2-v39',audit:'v39-compile-optimization-audit.json',level:['-O2'],renderingAccepted:false,linkSnapshot:'web-engine-full-thread-20261103-162029.log.link.rsp'},
 {folder:'villa-final-link-o1-v40',audit:'v40-compile-optimization-audit.json',level:['-O1'],renderingAccepted:true,linkSnapshot:'web-engine-full-thread-20261103-163205.log.link.rsp'}
];
let baseline;
for(const experiment of experiments){
 const file=path.join(results,experiment.audit),report=read(file);assert(report.pass);
 valid(report.source);assert.equal(report.objects.length,417);
 assert.deepEqual(report.compileCounts,{'-O2':416,'-O1':1});
 assert.equal(report.simdUnits,0);assert.equal(report.ltoUnits,0);
 assert.deepEqual(report.link.optimization,experiment.level);assert.equal(report.link.assertions,'1');
 assert.equal(report.link.debug,'-g2');assert.equal(report.link.lto,false);
 experiment.linkSnapshot=audit(path.join(results,experiment.linkSnapshot));assert.equal(experiment.linkSnapshot.sha256,report.link.source.sha256);
 if(!baseline)baseline=report;
 for(const unit of report.objects){
  valid(unit.object);valid(unit.response);
  const original=baseline.objects.find(x=>x.object.file===unit.object.file);assert(original);
  assert.equal(unit.object.sha256,original.object.sha256);assert.equal(unit.response.sha256,original.response.sha256);
 }
 for(const product of report.products.filter(x=>/\.(wasm|js)$/.test(x.file)))
  assert.equal(audit(path.join(__dirname,'build',experiment.folder,path.basename(product.file))).sha256,product.sha256);
 experiment.audit=audit(file);experiment.objects=report.objects.length;
 experiment.compileCounts=report.compileCounts;experiment.link=report.link;
 experiment.runtime=report.products.filter(x=>/\.(wasm|js)$/.test(x.file)).map(x=>audit(path.join(__dirname,'build',experiment.folder,path.basename(x.file))));
}
const comparisons=[],measurementWindows=[];
for(const folder of ['villa-final-link-o2-v39','villa-final-link-o1-v40']){
 const file=path.join(results,folder+'-abba.json'),report=read(file);assert(report.pass);valid(report.source);
 assert.equal(report.runs.length,4);
 assert.deepEqual(report.folders,['villa-bridge-extras-v38',folder,folder,'villa-bridge-extras-v38']);
 for(const run of report.runs)measurementWindows.push([run.measurement.timeOrigin+run.measurement.start,run.measurement.timeOrigin+run.measurement.end]);
 for(const p of Object.values(report.packages))for(const item of Object.values(p.files))valid(item);
 assert.equal(report.packages[folder].files['config-files.json'].sha256,report.packages['villa-bridge-extras-v38'].files['config-files.json'].sha256);
 assert.equal(report.packages[folder].files['content-files.json'].sha256,report.packages['villa-bridge-extras-v38'].files['content-files.json'].sha256);
 const screenshots=report.runs.map(r=>audit(path.join(results,`${folder}-abba-${r.index}-full.png`)));
 comparisons.push({file:audit(file),renderingComparable:folder.endsWith('v40'),performanceGainAccepted:false,causalAttribution:false,
  reason:folder.endsWith('v39')?'Rejected: same camera/config but visibly different lighting/shadows and sharply reduced drawing workload. Report.pass only checks automated run completion, not image equivalence.':'Six-view continuity/error checks and manual screenshot review passed. Baseline itself drifted from 56.98 to 42.50 FPS; background activity prevents attributing the measured difference solely to optimization. No usable gain accepted.',
  summary:report.summary,runs:report.runs.map(r=>({index:r.index,folder:r.folder,started:r.started,fps:r.fps,
   low1:r.frameMs.low1Fps,rhiWorkMs:r.rhiWorkMs,workload:r.workload,errors:r.errors,
   camera:r.before.camera,view:r.before.view,pageBefore:r.pageBefore,pageAfter:r.pageAfter})),screenshots});
}
const viewsFile=path.join(results,'villa-final-link-o1-v40-views.json'),views=read(viewsFile);
assert(views.pass&&views.views.length===6&&views.errors.length===0);valid(views.source);
const environmentFile=path.join(results,'villa-final-link-o2-v39-environment.jsonl');
const environment=fs.readFileSync(environmentFile,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const measuredEnvironment=environment.filter(x=>measurementWindows.some(([start,end])=>Date.parse(x.utc)>=start&&Date.parse(x.utc)<=end));
assert(measuredEnvironment.length>=24);assert(measuredEnvironment.every(x=>x.blockers.length===0),'Game/editor/compiler overlapped measurement windows');
const restoredFile=path.join(results,'default-restored-compile-optimization-audit.json'),restored=read(restoredFile);
assert(restored.pass);assert.deepEqual(restored.link.optimization,[]);
for(const item of restored.products.filter(x=>/\.(wasm|js)$/.test(x.file))){valid(item);assert(baseline.products.some(x=>x.file===item.file&&x.sha256===item.sha256));}
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),experiments,comparisons,
 restoredDefault:{file:audit(restoredFile),runtime:restored.products.filter(x=>/\.(wasm|js)$/.test(x.file)),byteIdenticalToV38:true,experimentalOptimizationAdopted:false},
 correctness:{file:audit(viewsFile),screenshot:audit(path.join(results,'villa-final-link-o1-v40-views.png')),views:6,errors:[],manualReview:'v40 default spawn lighting matches v38; v39 visibly loses shadows/changes lighting and is rejected.'},
 environment:{file:audit(environmentFile),samples:environment.length,measurementSamples:measuredEnvironment.length,first:environment[0].utc,last:environment.at(-1).utc,blockersDuringMeasurements:[],boundary:'Only UTC windows of the measured intervals are checked; builds between experiments are excluded. Existing Edge/Oopz/music and system background activity retained. Monitor is process-level CPU evidence, not proof of exclusive GPU/CPU ownership.'},
 attribution:{baselineOwnerProfile:audit(path.join(results,'villa-bridge-extras-v38-views-owner-analysis.json')),
  createGroupsInclusivePercent:23.915580244573693,createGroupsSelfPercent:5.585528117007245,
  boundary:'Overlapping inclusive wall-clock samples include child JS, allocation and waits; custom Web RHI is not native D3D12. Owner-only samples do not cover browser GPU process, IPC or driver.'},
 boundary:'All 417 engine objects/responses are identical across variants; no project quality or Cook changes. O2 failure is localized to the O2 link pipeline, not proven to be a Binaryen compiler bug. O1 does not run the main Binaryen optimization pipeline. SIMD/LTO and remaining native/Web gap are unmeasured causes.'};
const output=path.join(__dirname,'evidence','web-build-optimization-20261103.json');
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:true,file:path.relative(root,output),comparisons:comparisons.map(x=>({renderingComparable:x.renderingComparable,performanceGainAccepted:x.performanceGainAccepted,summary:x.summary}))}));
