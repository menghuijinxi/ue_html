'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=__dirname,out=path.join(root,'results/cleanup-20261113');fs.mkdirSync(out,{recursive:true});
const userFile='G:/UE_HTML/清理旧测试文件.bat',backup=path.join(out,'original-cleanup.bat');
assert(!fs.existsSync(backup));fs.copyFileSync(userFile,backup);
const inventory=JSON.parse(fs.readFileSync(path.join(out,'browser-inventory.json')));
const targets=inventory.map(p=>({path:p.path,reason:'已结束的自动测试浏览器缓存'}));
for(const n of ['nanite-pack-programmable-20261112','nanite-pack-programmable-content-20261112','nanite-pack-material-20261112',
 'nanite-pack-material-content-20261112','nanite-pack-fixture-20261112','nanite-pack-fixture-content-20261112'])targets.push({path:path.join(root,'build',n),reason:'已归档的失败专项包及配套内容副本'});
const allowedFailed=new Set(targets.slice(inventory.length).map(p=>path.resolve(p.path)));
const profileParent=path.join(root,'results/browser-profiles');
function state(dir){const s=fs.lstatSync(dir);assert(s.isDirectory()&&!s.isSymbolicLink(),dir);let bytes=0,files=0,latest=s.mtimeMs,stack=[dir];
 while(stack.length)for(const e of fs.readdirSync(stack.pop(),{withFileTypes:true})){
  const f=path.join(e.parentPath||e.path,e.name),s=fs.lstatSync(f);assert(!s.isSymbolicLink(),f);latest=Math.max(latest,s.mtimeMs);
  if(s.isDirectory())stack.push(f);else{assert(s.isFile());bytes+=s.size;files++;}}
 return {bytes,files,lastWrite:latest};}
for(const p of targets){p.path=path.resolve(p.path);assert(path.dirname(p.path)===profileParent||allowedFailed.has(p.path));Object.assign(p,state(p.path));}
assert.equal(targets.length,82);assert.equal(new Set(targets.map(p=>p.path)).size,82);
// Confirm failed package reports remain independently archived before listing them.
const evidence=JSON.parse(fs.readFileSync(path.join(root,'evidence/nanite-pack-batch-20261112.json')));assert(evidence.pass);
for(const n of ['nanite-pack-programmable-20261112','nanite-pack-material-20261112','nanite-pack-fixture-20261112']){
 const file=path.join(root,'build',n,'package.json'),a=audit(file);assert(evidence.records.some(p=>p.original.file===file&&p.original.sha256===a.sha256),file);}
const plan={date:new Date().toISOString(),root,targets,logicalBytes:targets.reduce((s,p)=>s+p.bytes,0),
 boundary:'Fixed automatic-browser caches and three archived failed package pairs only. Preserve source, original Villa, engine, Cook outputs, current packages, raw test reports and evidence. Logical bytes include hard links and do not predict reclaimed disk bytes.'};
fs.writeFileSync(path.join(root,'cleanup-test-cache-20261113.json'),JSON.stringify(plan,null,2)+'\n');
const header=fs.readFileSync(backup,'utf8').split('# === POWERSHELL BODY ===\r\n').slice(0,1)[0];
assert(header.startsWith('@echo off'));assert(header.trimEnd().endsWith('exit /b %UE_HTML_TEST_CLEANUP_EXIT%'));
let body=fs.readFileSync(path.join(root,'cleanup-test-cache-20261113-body.ps1'),'utf8');
assert(body.includes('__FIXED_TARGETS__'));
body=body.replace('__FIXED_TARGETS__',targets.map(p=>"    [pscustomobject]@{ Path='"+p.path+"'; Bytes="+p.bytes+"L; Files="+p.files+"L; LastWrite="+Math.ceil(p.lastWrite)+"L }").join('\n'));
const text=(header.replace('if /I not "%~1"=="--preview" pause','if /I not "%~1"=="--preview" if /I not "%~1"=="--execute" pause')+
 '# === POWERSHELL BODY ===\n'+body).replace(/\r?\n/g,'\r\n');
const output=path.join(root,'cleanup-test-cache-standalone-20261113.bat');fs.writeFileSync(output,text);fs.copyFileSync(output,userFile);
fs.writeFileSync(path.join(out,'package.json'),JSON.stringify({pass:true,source:audit(__filename),body:audit(path.join(root,'cleanup-test-cache-20261113-body.ps1')),backup:audit(backup),
 plan:audit(path.join(root,'cleanup-test-cache-20261113.json')),output:audit(output),userFile:audit(userFile),directories:targets.length,logicalGiB:plan.logicalBytes/2**30},null,2)+'\n');
console.log({pass:true,directories:targets.length,logicalGiB:plan.logicalBytes/2**30,file:userFile});
