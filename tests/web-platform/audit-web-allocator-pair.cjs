'use strict';
// Run before another build replaces shared intermediate objects or response files.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [miFile,dlFile,output]=process.argv.slice(2);assert(miFile&&dlFile&&output&&!fs.existsSync(output));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const cache=new Map(),valid=p=>{assert(p?.file);if(!cache.has(p.file))cache.set(p.file,audit(p.file).sha256);assert.equal(cache.get(p.file),p.sha256,p.file);};
const mi=read(miFile),dl=read(dlFile);
const runtimeProducts=(b,file)=>b.products.filter(p=>/\.(?:js|wasm)$/.test(p.file)).map(p=>{
 const packaged=path.join(__dirname,'build',path.basename(file).replace(/-build\.json$/,''),path.basename(p.file));
 return {file:fs.existsSync(packaged)?packaged:p.file,sha256:p.sha256};
});
const products={mimalloc:runtimeProducts(mi,miFile),dlmalloc:runtimeProducts(dl,dlFile)};
assert(mi.pass&&dl.pass&&mi.fullLinkVerified&&dl.fullLinkVerified&&mi.threads&&dl.threads);
assert(mi.allocator==='mimalloc'&&dl.allocator==='default-dlmalloc');
assert(!mi.allocationProbe&&!dl.allocationProbe&&!mi.simd&&!dl.simd&&!mi.trace&&!dl.trace);
assert.equal(mi.linkOptimization,dl.linkOptimization);
for(const b of [mi,dl]){
 products[b===mi?'mimalloc':'dlmalloc'].forEach(valid);b.sourceFiles.forEach(valid);valid(b.log);
 for(const u of b.objects)for(const k of ['source','definitions','response','object'])valid(u[k]);
}
assert.equal(mi.objects.length,dl.objects.length);
for(let i=0;i<mi.objects.length;i++)for(const k of ['source','definitions','response','object'])assert.deepEqual(mi.objects[i][k],dl.objects[i][k],`${i} ${k}`);
// The report's link response may be replaced by the second build; use the
// immutable copy written alongside each build log for the allocator flags.
const links=[mi,dl].map(b=>{
 const file=b.log.file+'.link.rsp';assert(fs.existsSync(file));const text=fs.readFileSync(file,'utf8');
 assert.equal(text.includes('-sMALLOC=mimalloc'),b===mi);
 assert(!text.includes('--wrap=posix_memalign'));
 return {file:audit(file),mimalloc:text.includes('-sMALLOC=mimalloc'),optimization:[...text.matchAll(/(?:^|\s)(-O[0-3sz])(?=\s|$)/g)].map(m=>m[1])};
});
const settings=path.resolve(__dirname,'../../.tools/emsdk/upstream/emscripten/src/settings.js');
assert(/var MALLOC\s*=\s*['"]dlmalloc['"]/.test(fs.readFileSync(settings,'utf8')));
const result={date:new Date().toISOString(),pass:true,source:audit(__filename),mimalloc: audit(miFile),dlmalloc:audit(dlFile),objects:mi.objects.length,
 identicalCompileObjects:true,compileObjects:mi.objects,links,defaultAllocatorSettings:audit(settings),products,
 boundary:'Same actual C++ sources, definitions, compile response files and object bytes; no allocation instrumentation or SIMD. Only the final allocator linkage differs. Audit must precede builds that replace shared intermediates. Performance is measured separately.'};
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({pass:true,objects:result.objects,output}));
