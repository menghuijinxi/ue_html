'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,dir=path.join(root,'results/nanite-default-native-current'),out=path.join(root,'evidence/nanite-default-temporal-20261111');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
fs.mkdirSync(out,{recursive:true});const artifacts=[],seen=new Map();
function archive(file){file=path.resolve(file);if(seen.has(file))return seen.get(file);
 const bytes=fs.readFileSync(file),compressed=zlib.gzipSync(bytes,{level:9});assert(zlib.gunzipSync(compressed).equals(bytes));
 const target=path.join(out,artifacts.length+'-'+path.basename(file)+'.gz');fs.writeFileSync(target,compressed);
 const item={original:audit(file),archive:audit(target)};artifacts.push(item);seen.set(file,item);return item;}
const proofFile=path.join(root,'evidence/nanite-raster-batch-20261111.json'),proof=read(proofFile);assert(proof.pass);
const packageProof=proof.packages['nanite-core-default'].package;verify(packageProof);
const pkg=read(packageProof.file);pkg.products.forEach(verify);
// The accepted runtime's complete source/build audits are retained immutably
// by the preceding evidence, while the next performance change is being built.
for(const item of proof.artifacts)verify(item.archive);
archive(packageProof.file);archive(proofFile);
const nativeFile=path.join(dir,'native-results.json'),native=read(nativeFile);assert(native.pass);
for(const item of [native.source,native.input,native.host,native.browser,native.browserSettings,native.project,native.producer,native.binary,native.build,native.hostManifest,native.log]){verify(item);archive(item.file);}
const build=read(native.build.file);assert(build.pass);for(const item of Object.values(build))if(item?.file){verify(item);archive(item.file);}
const prepared=read(build.preparation.file);for(const item of [...prepared.sources,...prepared.generated,...prepared.configs]){verify(item);archive(item.file);}
assert.equal(native.captures.length,3);
for(const [index,c] of native.captures.entries()){
 for(const item of [c.image,c.metadata,...c.phases.map(p=>p.image)]){verify(item);archive(item.file);}
 assert.equal(c.values.samples,8);assert.equal(c.values.naniteSamples,index===1?0:8);assert.equal(c.values.naniteAssetComponents,8);
 assert.equal(c.values.renderTimeFrozen,false);assert.equal(c.values.materialTime,0);assert(c.values.temporalSequencesFrozen);
 for(const phase of [0,1,2,3]){const last=c.values.stability.filter(s=>s.phase===phase).at(-1);assert(last.stableSamples>=3&&last.warmupFrames>=600);
  assert.equal(last.antiAliasingMethod,2);assert(last.realtime&&last.temporalAA);}
}
const runs=[];
for(const mode of ['packed','scalar']){
 const f=path.join(dir,mode+'.json'),r=read(f),cf=path.join(dir,mode+'-comparison.json'),c=read(cf);
 assert(r.pass&&c.pass&&r.defaultScene);verify(r.source);verify(r.package);verify(c.source);
 assert.equal(r.package.sha256,packageProof.sha256);assert.equal(r.views.length,1);assert.equal(r.views[0].tests.length,3);
 assert(r.visualClock.materialTimeFrozen&&!r.visualClock.renderTimeFrozen);assert.deepEqual(r.errors,[]);assert.deepEqual(r.views[0].gpu.errors,[]);
 assert.equal(c.comparisons.length,84);assert.deepEqual(c.failures,[]);for(const item of c.inputs)verify(item);
 for(const t of r.views[0].tests){assert.equal(t.phases.length,4);for(const p of t.phases){assert.equal(p.antiAliasingMethod,2);verify(p.image);archive(p.image.file);}
  for(const capture of t.captureChecks){verify(capture.image);archive(capture.image.file);}}
 for(const comparison of c.comparisons)for(const metric of ['naniteEffectDifference','webRecreationDifference','nativeRecreationDifference'])
  assert(comparison[metric].mean<5&&comparison[metric].p95<18);
 for(const sheet of c.contactSheets){verify(sheet);archive(sheet.file);}
 archive(f);archive(cf);archive(r.source.file);archive(c.source.file);
 runs.push({mode,frames:r.views[0].frames,comparisons:c.comparisons.length,maxMean:Math.max(...c.comparisons.map(x=>x.naniteEffectDifference.mean)),
  maxP95:Math.max(...c.comparisons.map(x=>x.naniteEffectDifference.p95)),report:audit(cf)});
}
archive(path.join(root,'results/nanite-core/default-native-config-path-failure.log'));archive(__filename);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:packageProof,acceptedRuntimeEvidence:audit(proofFile),nativeBuild:native.build,runs,artifacts,
 boundary:'Original Template_Default lighting/sky and eight real materials, actual TAA=2, matched projection jitter/material mip bias, four stable AO phases, native SM6 proxies 8/0/8 and Web on/off/restored. Only material time is fixed; world/render time and histories advance. Absolute platform differences are recorded separately. This accepts the raster-batch runtime; later allocator changes need new same-package regressions. Complete scene performance remains open.'};
const file=path.join(root,'evidence/nanite-default-temporal-20261111.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log({pass:true,file,runs,artifacts:artifacts.length});
