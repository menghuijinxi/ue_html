'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {audit}=require('./content-file-metadata.cjs'),{writeVersions}=require('./asset-versions.cjs');
const [baseName,name,value]=process.argv.slice(2);
assert([baseName,name].every(n=>/^[a-z0-9-]+$/.test(n))&&['0','1'].includes(value));
const base=path.join(__dirname,'build',baseName),output=path.join(__dirname,'build',name);
assert(!fs.existsSync(output));
const parentFile=path.join(base,'package.json'),parent=JSON.parse(fs.readFileSync(parentFile));assert(parent.pass);
parent.products.forEach(p=>assert.equal(audit(p.file).sha256,p.sha256));
fs.mkdirSync(output);
for(const p of parent.products){const n=path.basename(p.file);if(!['index.html','config-files.json','asset-versions.json'].includes(n))fs.linkSync(p.file,path.join(output,n));}
const files=JSON.parse(fs.readFileSync(path.join(base,'config-files.json')));
const config=files.find(f=>f.path==='/Engine/Platforms/Web/Config/WebEngine.ini');assert(config);
let text=Buffer.from(config.data,'base64').toString('utf8');
assert.equal((text.match(/^r\.Nanite=[01]\r?$/gm)||[]).length,1);
text=text.replace(/^r\.Nanite=[01]\r?$/m,'r.Nanite='+value);
config.data=Buffer.from(text).toString('base64');config.sha256=crypto.createHash('sha256').update(text).digest('hex');
fs.writeFileSync(path.join(output,'config-files.json'),JSON.stringify(files));
let html=fs.readFileSync(path.join(base,'index.html'),'utf8');const match=html.match(/const localRuntimeAssets = (\{[^\n]*\});/);assert(match);
const assets=JSON.parse(match[1]);assets.versions['config-files.json']=audit(path.join(output,'config-files.json')).sha256;
html=html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';').replace(/<title>[^<]*<\/title>/,'<title>Villa - Nanite '+(value==='1'?'开启':'关闭')+'</title>');
fs.writeFileSync(path.join(output,'index.html'),html);
const products=fs.readdirSync(output).map(n=>audit(path.join(output,n)));products.push(writeVersions(output,products));
const report={date:new Date().toISOString(),pass:true,output,fullScene:true,performanceProfile:parent.performanceProfile,
  parent:audit(parentFile),settingsOverrides:{'r.Nanite':Number(value)},source:audit(__filename),products};
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,output});
