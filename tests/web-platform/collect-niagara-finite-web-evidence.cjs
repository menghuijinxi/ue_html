'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results/nanite-curves'),input=path.join(root,'niagara-finite/verified.json');
const report=JSON.parse(fs.readFileSync(input,'utf8'));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
assert(report.pass&&report.floatValues===67584);assert.deepEqual(report.vectorWidths,[1,2,3,4]);
[report.source,report.helper,report.input,report.oldFailure,report.productionInput,report.gpu,...report.contract,...report.actual.files].forEach(verify);
assert.equal(report.actual.pass,false);assert.match(report.actual.error,/OpMemoryBarrier/);
const data=JSON.parse(fs.readFileSync(report.gpu.file,'utf8'));
assert.deepEqual(data.errors,[]);assert.equal(data.words.length,67584);assert.deepEqual(data.values,data.expected);
assert.match(fs.readFileSync(report.oldFailure.file,'utf8'),/IsNan is not supported/);
const compiler=path.resolve(__dirname,'../ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp');
const compilerText=fs.readFileSync(compiler,'utf8');assert(compilerText.includes('v34-NiagaraFinite')&&compilerText.includes('UE::WebGPUShader::LowerNiagaraFiniteChecks(Source);'));
const buildLog=path.join(root,'niagara-finite-build.log');assert.match(fs.readFileSync(buildLog,'utf8'),/Result: Succeeded/);
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const archive=path.join(__dirname,'evidence','niagara-finite-web-'+stamp),files=[];
function preserve(relative){
 const source=path.join(root,relative);
 if(fs.statSync(source).isDirectory()){for(const e of fs.readdirSync(source))preserve(path.join(relative,e));return;}
 const bytes=fs.readFileSync(source),compressed=zlib.gzipSync(bytes,{level:9}),target=path.join(archive,relative+'.gz');
 assert(zlib.gunzipSync(compressed).equals(bytes));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed);
 files.push({source:audit(source),archive:audit(target),encoding:'gzip-file',bytes:bytes.length});
}
for(const name of ['niagara-finite','failure-niagara-isnan','niagara-finite-build.log'])preserve(name);
const result={pass:true,date:new Date().toISOString(),source:audit(__filename),verified:audit(input),compiler:audit(compiler),build:audit(buildLog),report,files,
 boundary:'Niagara finite-value classification only. Real simulation shader still fails on OpMemoryBarrier; no shader failure is ignored and simulation compatibility is not claimed.'};
const target=archive+'.json';fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');console.log({pass:true,target,files:files.length});
