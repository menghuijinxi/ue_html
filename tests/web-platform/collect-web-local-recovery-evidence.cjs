'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(path.join(__dirname,f),'utf8'));
const validate=item=>assert.equal(audit(item.file).sha256,item.sha256,item.file);
const baseline=read('results/local-recovery-baseline.json'),recovery=read('results/local-recovery.json');
const quota=read('results/web-local-quota-edge.json'),io=read('results/web-local-io-edge-results.json');
for(const r of [baseline,recovery]){
 assert(r.pass);[r.source,r.worker,r.fixture].forEach(validate);
}
assert(baseline.baseline&&baseline.cases.length===1);assert(baseline.cases[0].errors.every(Boolean));
assert(!recovery.baseline&&recovery.cases.length===4);
assert(quota.pass&&quota.cases.length===6);quota.sources.forEach(validate);validate(quota.fixture);
assert(io.pass&&io.browsers.length===1);io.sourceFiles.forEach(validate);
const originalFile='results/nanite-gpu-instances/failure-opfs-not-found/browser.json';
const original=read(originalFile);assert(!original.pass&&original.tests.length===0);
assert(original.failure.includes('requested file or directory could not be found'));
const evidence={pass:true,date:new Date().toISOString(),source:audit(__filename),baseline,recovery,quota,io,
 original:{file:audit(path.join(__dirname,originalFile)),report:original,
  worker:{file:baseline.worker,content:fs.readFileSync(baseline.worker.file,'utf8')}},
 boundary:'A single missing OPFS directory or file during asset opening is recovered with fresh handles, exclusive validation and one bounded retry. Persistent disappearance, permission failures and corrupt reads still fail. The original browser-side deletion/reclamation trigger is not established. Validation used Edge; Chrome is not installed on this host.'};
const file=path.join(__dirname,'evidence/web-local-recovery-20261110.json');
fs.writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');console.log({pass:true,file});
