'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'results/nanite-curves'),input=path.join(output,'vectorvm/verified.json');
const report=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
assert(report.pass&&report.native.pass&&report.native.halfValues===1304576&&report.web.length===2);
for(const source of report.sourceFiles)assert.equal(audit(source.file).sha256,source.sha256,source.file);
for(const run of report.web){
 assert(run.result.pass&&run.result.halfValues===1304576&&run.result.byteCases===4096&&run.result.shiftCases===1024);
 const log=fs.readFileSync(path.join(output,'vectorvm',run.mode+'-stderr.log'),'utf8');
 assert(!/runtime error:|Sanitizer:|ERROR:|SUMMARY:/.test(log));
 assert(fs.readFileSync(path.join(output,'vectorvm',run.mode+'.data')).equals(fs.readFileSync(path.join(output,'vectorvm/reference.bin'))));
}
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const archive=path.join(__dirname,'evidence','vectorvm-web-'+stamp),files=[];
function preserve(relative){
 const source=path.join(output,relative);
 for(const e of fs.readdirSync(source,{withFileTypes:true})){
  const name=path.join(relative,e.name);if(e.isDirectory()){preserve(name);continue;}assert(e.isFile());
  const from=path.join(output,name),bytes=fs.readFileSync(from),compressed=zlib.gzipSync(bytes,{level:9}),target=path.join(archive,name+'.gz');
  assert(zlib.gunzipSync(compressed).equals(bytes));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed);
  files.push({source:audit(from),archive:audit(target),encoding:'gzip-file',bytes:bytes.length});
 }
}
for(const folder of ['vectorvm','failure-vectorvm-platform','failure-vectorvm-unaligned','failure-sdk-cache-config'])preserve(folder);
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),verified:audit(input),report,files,
 boundary:'VectorVM Web arithmetic and memory access contract only. Full UE target, Niagara simulation and Nanite Groom scene acceptance remain separate requirements.'};
const target=archive+'.json';fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({pass:true,target,files:files.length});
