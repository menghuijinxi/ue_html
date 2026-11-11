'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'evidence/nanite-core-native-20261111');fs.mkdirSync(output,{recursive:true});
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const artifacts=[],seen=new Map();
function archive(f){f=path.resolve(f);if(seen.has(f))return seen.get(f);const b=fs.readFileSync(f),gz=zlib.gzipSync(b,{level:9});assert(zlib.gunzipSync(gz).equals(b));
 const target=path.join(output,artifacts.length+'-'+path.basename(path.dirname(f))+'-'+path.basename(f)+'.gz');fs.writeFileSync(target,gz);
 const a={original:audit(f),archive:audit(target),encoding:'gzip'};artifacts.push(a);seen.set(f,a);return a;}
const proofFile=path.join(__dirname,'evidence/nanite-primitive-visibility-20261111.json'),proof=read(proofFile);assert(proof.pass);
for(const a of proof.artifacts)verify(a.archive);archive(proofFile);
const runs=[];
for(const isDefault of [false,true]){
 const dir=path.join(__dirname,'results',isDefault?'nanite-default-native-current':'nanite-full-scene-native');
 const packageProof=proof.packages[isDefault?'nanite-core-default':'nanite-core-scene'].package;verify(packageProof);
 const pkg=read(packageProof.file);assert(pkg.pass);pkg.products.forEach(verify);archive(packageProof.file);
 const nf=path.join(dir,'native-results.json'),native=read(nf);assert(native.pass);
 for(const a of [native.source,native.input,native.host,native.browser,native.browserSettings,native.project,native.producer,native.binary,native.build,native.hostManifest,native.log]){verify(a);archive(a.file);}
 const settings=read(native.browserSettings.file);assert(settings.pass);assert.equal(settings.package.sha256,packageProof.sha256);
 const build=read(native.build.file);assert(build.pass);for(const a of Object.values(build))if(a?.file){verify(a);archive(a.file);}
 const prepared=read(build.preparation.file);for(const a of [...prepared.sources,...prepared.generated,...prepared.configs]){verify(a);archive(a.file);}
 assert.equal(native.captures.length,isDefault?3:9);
 for(const [i,c] of native.captures.entries()){
  for(const a of [c.image,c.metadata,...c.phases.map(p=>p.image)]){verify(a);archive(a.file);}
  assert.equal(c.values.renderTimeFrozen,false);assert.equal(c.values.materialTime,0);assert(c.values.temporalSequencesFrozen);
  if(isDefault){assert.equal(c.values.samples,8);assert.equal(c.values.naniteSamples,i===1?0:8);assert.equal(c.values.naniteAssetComponents,8);}
  for(const phase of [0,1,2,3]){const last=c.values.stability.filter(s=>s.phase===phase).at(-1);
   assert(last.stableSamples>=3&&last.warmupFrames>=600);assert.equal(last.antiAliasingMethod,isDefault?2:4);assert(last.realtime&&last.temporalAA);}
 }
 for(const mode of ['packed','scalar']){
  const f=path.join(dir,mode+'.json'),r=read(f),cf=path.join(dir,mode+'-comparison.json'),c=read(cf);
  assert(r.pass&&c.pass);assert.equal(!!r.defaultScene,isDefault);verify(r.source);verify(r.package);verify(c.source);
  assert.equal(r.package.sha256,packageProof.sha256);assert.equal(r.views.length,isDefault?1:3);
  assert(r.visualClock.materialTimeFrozen&&!r.visualClock.renderTimeFrozen);assert.deepEqual(r.errors,[]);assert.deepEqual(c.failures,[]);
  assert.equal(c.comparisons.length,isDefault?84:156);c.inputs.forEach(verify);
  for(const view of r.views){assert.deepEqual(view.gpu.errors,[]);assert.equal(view.gpu.features.includes('atomic-vec2u-min-max'),mode==='packed');assert.equal(view.tests.length,3);
   for(const t of view.tests){assert.equal(t.phases.length,4);for(const p of t.phases){assert.equal(p.antiAliasingMethod,isDefault?2:4);verify(p.image);archive(p.image.file);}
    for(const capture of t.captureChecks){verify(capture.image);archive(capture.image.file);}}
  }
  for(const comparison of c.comparisons)for(const metric of ['naniteEffectDifference','webRecreationDifference','nativeRecreationDifference'])
   assert(comparison[metric].mean<5&&comparison[metric].p95<18);
  for(const a of c.contactSheets){verify(a);archive(a.file);}archive(f);archive(cf);archive(r.source.file);archive(c.source.file);
  runs.push({scene:isDefault?'Template_Default':'Villa',mode,frames:r.views.reduce((s,v)=>s+v.frames,0),comparisons:c.comparisons.length,
   maxMean:Math.max(...c.comparisons.map(x=>x.naniteEffectDifference.mean)),maxP95:Math.max(...c.comparisons.map(x=>x.naniteEffectDifference.p95)),report:audit(cf)});
 }
}
archive(__filename);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),runtimeEvidence:audit(proofFile),runs,artifacts,
 boundary:'Same final runtime in Template_Default and Villa, actual TAA/TSR, matched jitter and material mip bias, four stable AO phases, independent native SM6 on/off/restored capture. Full-world clocks advance and only material time is fixed. Existing image thresholds are unchanged; absolute platform differences remain reported separately. This does not claim every experimental Nanite feature is supported.'};
const file=path.join(__dirname,'evidence/nanite-core-native-20261111.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log({pass:true,file,runs,artifacts:artifacts.length});
