'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const read=name=>JSON.parse(fs.readFileSync(path.join(__dirname,name),'utf8').replace(/^\uFEFF/,''));
const valid=item=>assert.equal(audit(item.file).sha256,item.sha256,item.file);
const baseline=read('results/local-stale-recovery-baseline.json'),stale=read('results/local-stale-recovery.json');
const recovery=read('results/local-recovery.json'),quota=read('results/web-local-quota-edge.json');
const io=read('results/web-local-io-edge-results.json');
for(const r of [baseline,stale,recovery]){assert(r.pass);[r.source,r.worker,r.fixture].forEach(valid);}
assert(baseline.baseline&&baseline.stale&&baseline.cases.length===4);
assert(baseline.cases.every(c=>!c.valid&&c.errors.every(e=>e.includes('InvalidStateError'))));
assert(!stale.baseline&&stale.stale&&stale.cases.length===5);
for(const c of stale.cases){
 assert.equal(c.stats.staleHandleRetries,1);assert.equal(c.stats.missingFileRetries,0);
 if(c.scenario==='stale-repeated'){assert(!c.valid&&c.errors.every(e=>e.includes('InvalidStateError')));}
 else {assert(c.valid);assert.deepEqual(c.errors,[null,null]);}
}
assert(recovery.cases.length===4&&quota.pass&&quota.cases.length===6&&io.pass&&io.browsers.length===1);
quota.sources.forEach(valid);valid(quota.fixture);io.sourceFiles.forEach(valid);
const failureRoot='results/nanite-assembly/failure-opfs-invalid-state/';
const original=read(failureRoot+'browser.json');
assert(!original.pass&&original.tests.length===0&&original.failure.includes('InvalidStateError'));
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),baseline,stale,recovery,quota,io,
 original:{source:audit(path.join(__dirname,failureRoot,'browser.json')),report:original,
  worker:baseline.worker,workerSource:fs.readFileSync(baseline.worker.file,'utf8')},
 boundary:'The observed startup InvalidStateError is retained. Opening an asset now refreshes OPFS handles once for either a missing or stale handle, revalidates the marker under an exclusive lock, and queues a shared lease before releasing it. Four stale-handle injection sites fail with the old worker and recover with complete byte validation after the fix. Repeated invalidation and permission failures still fail. The browser-side trigger of the original invalidation is not established; disk pressure was observed later during packaging. Existing active-file leases, quota recovery, corrupt-data rejection and bounded-memory IO regressions pass in Edge.'};
const file=path.join(__dirname,'evidence/web-local-stale-recovery-20261111.json');
fs.writeFileSync(file,JSON.stringify(result,null,2)+'\n');console.log({pass:true,file});
