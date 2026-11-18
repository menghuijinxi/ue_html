'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const input=path.join(__dirname,'results/nanite-curves/material-visualization/verified.json');
const proof=JSON.parse(fs.readFileSync(input,'utf8'));assert(proof.pass);
const checks=[proof.source,...proof.inputs,...proof.results.flatMap(r=>[r.readback,...r.files])];
checks.forEach(a=>assert.equal(audit(a.file).sha256,a.sha256,a.file));
assert.deepEqual(proof.results.map(r=>[r.cases,r.failures]),[[116288,[86501,86501]],[116288,[0,0]]]);
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const output=path.join(__dirname,'evidence','nanite-curve-visualization-'+stamp);fs.mkdirSync(output,{recursive:true});
const files=[];
for(const source of new Set([__filename,input,...checks.map(a=>a.file)])){
 const raw=fs.readFileSync(source),bytes=zlib.gzipSync(raw,{level:9});assert(zlib.gunzipSync(bytes).equals(raw));
 const target=path.join(output,`${files.length}-${path.basename(source)}.gz`);fs.writeFileSync(target,bytes);files.push({source:audit(source),archive:audit(target),bytes:raw.length});
}
const target=path.join(__dirname,'evidence','nanite-curve-visualization-'+stamp+'.json');
fs.writeFileSync(target,JSON.stringify({pass:true,date:new Date().toISOString(),source:audit(__filename),proof,files,
 boundary:'Production material-index expressions used by Nanite visualization color and GPU feedback verified on the GPU. Full debug-view rendering and complete browser curve acceptance remain separate checks.'},null,2)+'\n');
console.log({pass:true,target,files:files.length});
