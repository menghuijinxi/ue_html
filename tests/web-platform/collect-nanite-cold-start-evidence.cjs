'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const input=path.join(__dirname,'results/nanite-automatic-cold-start/results.json'),r=JSON.parse(fs.readFileSync(input,'utf8'));
assert(r.pass&&r.runs.length===4);for(const item of [r.source,r.package])assert.equal(audit(item.file).sha256,item.sha256);
const pkg=JSON.parse(fs.readFileSync(r.package.file,'utf8'));for(const item of [...pkg.sources,...pkg.products])assert.equal(audit(item.file).sha256,item.sha256);
for(const [i,run] of r.runs.entries()){
  assert(run.pass&&run.scalar===!!(i%2));assert(run.readyMilliseconds>0&&run.readyMilliseconds<180000);assert.equal(run.scene.entries,8);assert.equal(run.scene.draws,8);
  assert(run.scene.covered>500);assert.deepEqual(run.errors,[]);assert.deepEqual(run.state.gpu.errors,[]);
  assert.equal(run.state.rhi.asyncPrecacheFailed,0);assert.equal(run.state.rhi.asyncPrecacheRequested,run.state.rhi.asyncPrecacheCompleted);
}
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(r)),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),r);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),artifact:audit(input),package:r.package,
  runs:r.runs.map(t=>({index:t.index,scalar:t.scalar,readyMilliseconds:t.readyMilliseconds,frames:t.state.frames,covered:t.scene.covered,pipelines:t.state.rhi.asyncPrecacheCompleted})),
  payloadEncoding:'gzip-base64-json',payload:payload.toString('base64'),
  boundary:'Four fresh persistent browser profiles and disabled HTTP cache, while native shader compilation also runs. Both visibility atomic configurations render all eight normal-scene materials. The earlier isolated 180-second timeout is not reproduced; its original cause is not claimed fixed.'};
const file=path.join(__dirname,'evidence/nanite-cold-start-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({pass:true,file,runs:report.runs}));
