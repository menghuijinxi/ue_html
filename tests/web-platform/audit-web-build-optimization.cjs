'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [input,output]=process.argv.slice(2);assert(input&&output&&!fs.existsSync(output));
const build=JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''));assert(build.pass&&build.buildSucceeded);
const counts={},units=[];
for(const unit of build.objects){
 assert.equal(audit(unit.response.file).sha256,unit.response.sha256,'Compile response changed');
 assert.equal(audit(unit.object.file).sha256,unit.object.sha256,'Object changed');
 const text=fs.readFileSync(unit.response.file,'utf8');
 const flags=[...text.matchAll(/^-O[0-3sz]\b/gm)].map(m=>m[0]);assert.equal(flags.length,1);
 counts[flags[0]]=(counts[flags[0]]||0)+1;
 units.push({module:path.basename(path.dirname(unit.response.file)),source:unit.source.file,
  optimization:flags[0],simd:/\s-msimd128(?:\s|$)/.test(text),lto:/\s-flto(?:[=\s]|$)/.test(text),
  object:unit.object,response:unit.response});
}
assert.equal(audit(build.linkResponse.file).sha256,build.linkResponse.sha256,'Link response changed');
const link=fs.readFileSync(build.linkResponse.file,'utf8');
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),build:audit(input),objects:units,
 compileCounts:counts,simdUnits:units.filter(u=>u.simd).length,ltoUnits:units.filter(u=>u.lto).length,
 link:{source:build.linkResponse,optimization:[...link.matchAll(/(?:^|\s)(-O[0-3sz])(?=\s|$)/gm)].map(m=>m[1]),
  assertions:link.match(/-sASSERTIONS=(\d)/)?.[1],debug:[...link.matchAll(/(?:^|\s)(-g\d?)(?=\s|$)/g)].at(-1)?.[1],
  lto:/(?:^|\s)-flto(?:[=\s]|$)/.test(link),switches:link.split(/\r?\n/).filter(l=>l.startsWith('-'))},
 products:build.products,boundary:'Audits actual response files and object hashes from this successful build. No FPS is inferred from optimization flags. Final-link optimization is distinct from LLVM LTO.'};
fs.writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify({pass:true,objects:units.length,compileCounts:counts,simdUnits:result.simdUnits,ltoUnits:result.ltoUnits,link:result.link}));
