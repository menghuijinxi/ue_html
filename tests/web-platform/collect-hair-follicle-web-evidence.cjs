'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results/nanite-curves'),input=path.join(root,'follicle/verified.json');
const report=JSON.parse(fs.readFileSync(input,'utf8'));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
assert(report.pass&&report.variants.length===2&&report.results.length===12);
[report.source,report.shader,report.originalInput,report.originalFailure,report.commonDeclarations].forEach(verify);
for(const variant of report.variants){assert.equal(variant.stages.length,2);for(const stage of variant.stages)stage.files.forEach(verify);}
for(const result of report.results){
 verify(result.readback);assert(result.maxError<2e-6);assert(result.reject?result.coverage===0:result.coverage>0);
 const data=JSON.parse(fs.readFileSync(result.readback.file,'utf8'));assert.deepEqual(data.errors,[]);assert.equal(data.pixels.length,64*64*4);
}
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const archive=path.join(__dirname,'evidence','hair-follicle-web-'+stamp),files=[];
function preserve(relative){
 for(const e of fs.readdirSync(path.join(root,relative),{withFileTypes:true})){
  const name=path.join(relative,e.name);if(e.isDirectory()){preserve(name);continue;}assert(e.isFile());
  const source=path.join(root,name),bytes=fs.readFileSync(source),compressed=zlib.gzipSync(bytes,{level:9}),target=path.join(archive,name+'.gz');
  assert(zlib.gunzipSync(compressed).equals(bytes));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed);
  files.push({source:audit(source),archive:audit(target),encoding:'gzip-file',bytes:bytes.length});
 }
}
for(const folder of ['follicle','failure-follicle-infinity'])preserve(folder);
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),verified:audit(input),report,files,
 boundary:'Hair follicle shader regression only. The original production Tint crash is reproduced and both actual VS/PS permutations are validated on WebGPU. Full UE Cook and Nanite Groom scene acceptance remain separate requirements.'};
const target=archive+'.json';fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({pass:true,target,files:files.length});
