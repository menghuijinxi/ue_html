'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results/nanite-curves');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const gpuFile=path.join(root,'material-index/verified.json'),gpu=read(gpuFile);assert(gpu.pass);
[gpu.source,...gpu.inputs,...gpu.results.flatMap(r=>[r.readback,...r.files])].forEach(verify);
assert.deepEqual(gpu.results.map(r=>r.cases),[116288,116288]);
assert.deepEqual(gpu.results[0].failures,[86501,86501,86501,86501,0,0]);
assert.deepEqual(gpu.results[1].failures,[0,0,0,0,0,0]);
const nativeFile=path.join(root,'native-preflight/material-verified.json'),native=read(nativeFile);assert(native.pass);
[native.source,native.input,native.run,...native.results.flatMap(r=>r.inputs)].forEach(verify);
assert.equal(native.results.length,21);assert.equal(native.results.reduce((n,r)=>n+r.covered,0),31291);
const run=read(native.run.file);assert(run.pass&&run.preflight);
[...run.sources,...run.captures,run.log].forEach(verify);
assert(!/Error:|Ensure condition failed|Fatal error/.test(fs.readFileSync(run.log.file,'utf8')));
for(const r of native.results){const view=read(r.inputs.find(a=>a.file.endsWith('.json')).file);
 assert.equal(view.naniteComponents,2);assert.equal(view.featureLevel,4);assert.equal(view.antiAliasingMethod,0);
 assert(r.materialSamples.every(n=>n>0));}
const failure=path.join(root,'failure-native-material-index');
assert(fs.existsSync(path.join(failure,'preflight-long-1.bin')));
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const output=path.join(__dirname,'evidence','nanite-curve-material-'+stamp);fs.mkdirSync(output,{recursive:true});
const inputs=new Set([__filename,gpuFile,nativeFile,gpu.source.file,...gpu.inputs.map(a=>a.file),
 ...gpu.results.flatMap(r=>[r.readback,...r.files].map(a=>a.file)),native.source.file,native.input.file,native.run.file,run.log.file,
 ...run.captures.map(a=>a.file),...run.sources.filter(a=>!/\.(dll|pdb)$/.test(a.file)).map(a=>a.file),
 ...fs.readdirSync(failure).map(n=>path.join(failure,n))]);
const files=[];
for(const source of inputs){const raw=fs.readFileSync(source),bytes=zlib.gzipSync(raw,{level:9});assert(zlib.gunzipSync(bytes).equals(raw));
 const target=path.join(output,`${files.length}-${path.basename(source)}.gz`);fs.writeFileSync(target,bytes);files.push({source:audit(source),archive:audit(target),bytes:raw.length});}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),gpu,native,run,files,
 boundary:'Native Nanite visibility-to-curve material index conversion only. Six GPU consumers and 21 independent native SM6 material preflight views pass. These views are not the browser-derived native comparison; browser curves, streaming and full Nanite completion remain open.'};
const target=path.join(__dirname,'evidence','nanite-curve-material-'+stamp+'.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');console.log({pass:true,target,files:files.length});
