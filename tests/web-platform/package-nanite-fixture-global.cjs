'use strict';
// Keep fixture project assets; use the donor's matching globals and configuration.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {audit,metadata}=require('./content-file-metadata.cjs'),{writeVersions}=require('./asset-versions.cjs');
const [baseName,donorName,name]=process.argv.slice(2);assert([baseName,donorName,name].every(n=>/^[a-z0-9-]+$/.test(n)));
const root=path.join(__dirname,'build'),base=path.join(root,baseName),donor=path.join(root,donorName),output=path.join(root,name);
assert(!fs.existsSync(output));const read=f=>JSON.parse(fs.readFileSync(f));
const inputs=[base,donor].map(d=>{const file=path.join(d,'package.json'),r=read(file);assert(r.pass);for(const p of r.products)assert.equal(audit(p.file).sha256,p.sha256);return audit(file);});
const manifest=read(path.join(base,'content-files.json')),sourceManifest=read(path.join(donor,'content-files.json'));
fs.mkdirSync(output);fs.copyFileSync(path.join(base,'content.bin'),path.join(output,'content.bin'));
const replacements=[];
for(const globalPath of ['/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin','/Engine/Programs/UEWebEngine/Content/ShaderArchive-Global-SF_WEBGPU_SM5-SP_WEBGPU_SM5.ushaderbytecode']){
 const source=sourceManifest.files.find(p=>p.path===globalPath);assert(source);
 const data=Buffer.alloc(source.size),fd=fs.openSync(path.join(donor,'content.bin'),'r');
 try{assert.equal(fs.readSync(fd,data,0,data.length,source.offset),data.length);}finally{fs.closeSync(fd);}
 assert.equal(crypto.createHash('sha256').update(data).digest('hex'),source.sha256);
 const offset=fs.statSync(path.join(output,'content.bin')).size;fs.appendFileSync(path.join(output,'content.bin'),data);
 manifest.files=manifest.files.filter(p=>p.path!==globalPath);manifest.files.push({...source,offset});replacements.push(source);
}
manifest.pack=metadata(path.join(output,'content.bin'),'content.bin');fs.writeFileSync(path.join(output,'content-files.json'),JSON.stringify(manifest));
const configs=read(path.join(donor,'config-files.json'));
const accepted=f=>/^\/Engine\/(?:Config\/|Platforms\/Web\/Config\/|Programs\/UEWebEngine\/Config\/)/.test(f.path)&&!/(?:^|\/)\.\.(?:\/|$)/.test(f.path);
const excludedConfigPaths=configs.filter(f=>!accepted(f)).map(f=>f.path);
fs.writeFileSync(path.join(output,'config-files.json'),JSON.stringify(configs.filter(accepted)));
const products=fs.readdirSync(output).map(n=>audit(path.join(output,n)));products.push(writeVersions(output,products));
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify({pass:true,inputs,source:audit(__filename),products,excludedConfigPaths,replacements,
 boundary:'Fixture-only override. Original project assets unchanged. Configuration, global shader map and matching Global bytecode library come from the same verified current scene package; shader eligibility settings must match its Cook. Excluded configuration paths are recorded. Requires runtime packaging and correctness verification.'},null,2)+'\n');
console.log({pass:true,output});
