'use strict';
// Keep reproducible verdicts in Git; leave full captures in the ignored archive.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),prefix='tests/web-platform/evidence/';
const option=name=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3);
const baseline=option('baseline')||'origin/master';
assert(/^[\w./-]+$/.test(baseline)&&!baseline.startsWith('-'));
const originalCommit=option('original-commit')||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert(/^[a-f0-9]{40}$/.test(originalCommit));
const existing=new Set(execFileSync('git',['ls-tree','-r','--name-only',baseline,'--',prefix],
 {cwd:root,encoding:'utf8'}).trim().split(/\r?\n/));
const directory=path.join(__dirname,'evidence'),output=path.join(__dirname,'validation-summaries');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const omittedKeys=new Set(['payload','pixels','gbuffer','traceEvents','logs','log','rawProfiles','rawData','raw','content']);
function omission(value,reason){
 const bytes=typeof value==='string'?value:JSON.stringify(value);
 return {$omitted:true,reason,type:Array.isArray(value)?'array':typeof value,
  entries:Array.isArray(value)?value.length:undefined,bytes:Buffer.byteLength(bytes),sha256:digest(bytes)};
}
function compact(value,key='',depth=0){
 if(value===null||typeof value==='boolean'||typeof value==='number')return value;
 if(omittedKeys.has(key))return omission(value,'Full diagnostic data is retained in the original report');
 if(typeof value==='string')return value.length<=2048?value:omission(value,'Large text');
 if(depth>10)return omission(value,'Nested diagnostic detail');
 if(Array.isArray(value))return value.length<=128?value.map(item=>compact(item,'',depth+1)):omission(value,'Large array');
 return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,compact(item,name,depth+1)]));
}
fs.mkdirSync(output,{recursive:true});
const reports=[];
for(const name of fs.readdirSync(directory).filter(name=>name.endsWith('.json')&&!existing.has(prefix+name)).sort()){
 const file=path.join(directory,name),original=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const artifact=audit(file),report={format:'validation-summary-v1',summaryOnly:true,
  originalReport:{path:prefix+name,bytes:fs.statSync(file).size,sha256:artifact.sha256,commit:originalCommit},
  result:compact(original)};
 let text=JSON.stringify(report,null,2)+'\n';
 if(Buffer.byteLength(text)>256*1024){
  for(const [key,value]of Object.entries(report.result)){
   if(typeof value==='object'&&value!==null&&Buffer.byteLength(JSON.stringify(value))>8192)
    report.result[key]=omission(original[key],'Detailed section exceeds the summary budget');
  }
  text=JSON.stringify(report,null,2)+'\n';
 }
 assert(Buffer.byteLength(text)<=256*1024,name+' exceeds the summary budget');
 if('pass'in original)assert.equal(report.result.pass,original.pass,name+' verdict changed');
 const target=path.join(output,name);fs.writeFileSync(target,text);
 reports.push({file:name,bytes:Buffer.byteLength(text),originalBytes:report.originalReport.bytes,
  originalSHA256:artifact.sha256,pass:original.pass});
}
const manifest={format:'validation-summary-index-v1',originalCommit,baseline,reports,
 boundary:'Summaries preserve original verdicts and available measurements. Omitted payloads remain in the local evidence directory and its external backup. These historical reports are not a new test run.'};
fs.writeFileSync(path.join(output,'index.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({pass:true,reports:reports.length,summaryBytes:reports.reduce((n,r)=>n+r.bytes,0),
 originalBytes:reports.reduce((n,r)=>n+r.originalBytes,0),output}));
