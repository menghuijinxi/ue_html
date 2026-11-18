'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const output=path.join(__dirname,'results/nanite-curves'),input=path.join(output,'vectorvm/verified.json');
const report=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
assert(report.pass&&report.native.pass&&report.native.halfValues===1304576&&report.web.length===2);
for(const source of report.sourceFiles)assert.equal(audit(source.file).sha256,source.sha256,source.file);
for(const run of report.web){
 assert(run.result.pass&&run.result.halfValues===1304576&&run.result.byteCases===4096&&run.result.shiftCases===1024&&run.result.integerCases===8192);
 const log=fs.readFileSync(path.join(output,'vectorvm',run.mode+'-stderr.log'),'utf8');
 assert(!/runtime error:|Sanitizer:|ERROR:|SUMMARY:/.test(log));
 assert(fs.readFileSync(path.join(output,'vectorvm',run.mode+'.data')).equals(fs.readFileSync(path.join(output,'vectorvm/reference.bin'))));
}
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const archive=path.join(__dirname,'evidence','vectorvm-web-'+stamp),files=[];
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const buildPath=path.join(__dirname,'results/web-engine-full-thread-build-results.json'),build=read(buildPath);
assert(build.pass&&build.buildSucceeded&&build.wasmValidated&&build.fullLinkVerified,'complete UE target build');
const buildInputs=[build.log,build.exportedActions,build.compileExecution,...build.products,...build.sourceFiles.filter(x=>/VectorVM/.test(x.file))];
for(const item of buildInputs)assert.equal(audit(item.file).sha256,item.sha256,item.file);
const execution=read(build.compileExecution.file),compiled=execution.results.find(x=>x.source==='Module.VectorVM.cpp');
assert(execution.pass&&compiled&&compiled.code===0);
const buildArchive=path.join(output,'vectorvm/full-ue-build');fs.mkdirSync(buildArchive,{recursive:true});
for(const file of [buildPath,build.log.file,build.exportedActions.file,build.compileExecution.file,...compiled.attempts.map(x=>x.log)])fs.copyFileSync(file,path.join(buildArchive,path.basename(file)));
const fullTarget={report:audit(buildPath),products:build.products,vectorVM:compiled,sourceFiles:buildInputs.filter(x=>/VectorVM/.test(x.file))};
function preserve(relative){
 const source=path.join(output,relative);
 for(const e of fs.readdirSync(source,{withFileTypes:true})){
  const name=path.join(relative,e.name);if(e.isDirectory()){preserve(name);continue;}assert(e.isFile());
  const from=path.join(output,name),bytes=fs.readFileSync(from),compressed=zlib.gzipSync(bytes,{level:9}),target=path.join(archive,name+'.gz');
  assert(zlib.gunzipSync(compressed).equals(bytes));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed);
  files.push({source:audit(from),archive:audit(target),encoding:'gzip-file',bytes:bytes.length});
 }
}
for(const folder of ['vectorvm','failure-vectorvm-platform','failure-vectorvm-unaligned','failure-sdk-cache-config','failure-vectorvm-register-type'])preserve(folder);
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),verified:audit(input),report,fullTarget,files,
 boundary:'VectorVM Web arithmetic, integer register interfaces and memory access contract, plus actual VectorVM module compilation and complete UE target link. Niagara simulation and Nanite Groom browser scene acceptance remain separate requirements.'};
const target=archive+'.json';fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({pass:true,target,files:files.length});
