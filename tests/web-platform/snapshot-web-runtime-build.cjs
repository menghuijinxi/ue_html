'use strict';
// Preserve both allocator runtimes before a subsequent link replaces Binaries/Web.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [input,output,name]=process.argv.slice(2);assert(input&&output&&/^[a-z0-9-]+$/.test(name)&&!fs.existsSync(output));
const b=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));
assert(b.pass&&b.threads&&b.fullLinkVerified&&!b.trace&&!b.simd&&!b.allocationProbe);
const valid=p=>assert.equal(audit(p.file).sha256,p.sha256,p.file);
b.sourceFiles.forEach(valid);b.products.forEach(valid);
for(const u of b.objects)for(const k of ['object','response','source','definitions'])valid(u[k]);
const directory=path.resolve(__dirname,'../../.tools/web-runtime-snapshots',name);assert(!fs.existsSync(directory));
fs.mkdirSync(directory,{recursive:true});
const original=output+'.original.json';assert(!fs.existsSync(original));fs.copyFileSync(input,original);
b.runtimeSnapshotSource=audit(original);
b.products=b.products.map(p=>{
 const file=path.join(directory,path.basename(p.file));fs.copyFileSync(p.file,file);const copied=audit(file);assert.equal(copied.sha256,p.sha256);return copied;
});
const link=audit(b.log.file+'.link.rsp');assert.equal(link.sha256,b.linkResponse.sha256);b.linkResponse=link;
fs.writeFileSync(output,JSON.stringify(b,null,2)+'\n');console.log(JSON.stringify({pass:true,output,directory,allocator:b.allocator}));
