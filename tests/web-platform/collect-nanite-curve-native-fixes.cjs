'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const root=path.join(__dirname,'results/nanite-curves'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const inputs=new Set([__filename]),verified=new Map();
function check(value){
 if(!value||typeof value!=='object')return;
 if(typeof value.file==='string'&&typeof value.sha256==='string'){
  if(verified.has(value.file))assert.equal(verified.get(value.file),value.sha256,value.file);
  else{assert.equal(audit(value.file).sha256,value.sha256,value.file);verified.set(value.file,value.sha256);}
  if(!/\.(dll|pdb|lib|obj)$/.test(value.file))inputs.add(value.file);return;
 }
 Object.values(value).forEach(check);
}
function report(file){inputs.add(file);const r=read(file);assert(r.pass,file);check(r);return r;}
function tree(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())tree(f);else inputs.add(f);}}
const build=report(path.join(__dirname,'results/native-nanitebuilder-build-results.json'));assert(build.installedInputsUnmodified);
const native=report(path.join(root,'verified.json'));assert.equal(native.groom.length,4);
const gpu={};
for(const name of ['decode','groom-decode','native-bounds','groom-native-bounds','hierarchy-bounds','groom-hierarchy-bounds','native-wave-endpoints','native-visibility-index'])gpu[name]=report(path.join(root,name+'.json'));
assert.equal(gpu.decode.results.length,29);assert.equal(gpu['groom-decode'].results.length,4);
for(const name of ['decode','groom-decode'])for(const r of gpu[name].results){
 assert(r.pass&&r.gpuDecodingMatchesCPU);assert.deepEqual(r.gpuErrors,[]);assert.deepEqual(r.materialMismatches,[]);
 report(r.input.file);assert.equal(r.leafPoints,r.allSourcePoints);
}
for(const name of ['native-bounds','groom-native-bounds','hierarchy-bounds','groom-hierarchy-bounds'])for(const r of gpu[name].results)assert.equal(r.outside,0);
assert.equal(gpu['native-wave-endpoints'].cases.length,60);assert.equal(gpu['native-wave-endpoints'].results.length,12);
for(const r of gpu['native-wave-endpoints'].results){if(r.baseline)assert(r.mismatches>0);else assert.equal(r.mismatches,0);}
assert.equal(gpu['native-visibility-index'].fixtures.length,29);
const segmentChecks=gpu['native-visibility-index'].fixtures.reduce((n,r)=>n+r.segments,0);assert.equal(segmentChecks,1101248);
for(const name of ['fixture.log','fixture-console.log','shader.log','shader-console.log']){
 const file=path.join(root,name);assert(!/Error:|Ensure condition failed|Fatal error/.test(fs.readFileSync(file,'utf8')),name);inputs.add(file);
}
for(const dir of ['fixtures','groom','groom-gpu','shaders','failure-native-curves'])tree(path.join(root,dir));
tree(path.join(__dirname,'fixtures/nanite-curves'));
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const output=path.join(__dirname,'evidence','nanite-curve-native-fixes-'+stamp);fs.mkdirSync(output,{recursive:true});const files=[];
for(const source of inputs){const raw=fs.readFileSync(source),bytes=zlib.gzipSync(raw,{level:9});assert(zlib.gunzipSync(bytes).equals(raw));
 const target=path.join(output,`${files.length}-${path.basename(source)}.gz`);fs.writeFileSync(target,bytes);files.push({source:audit(source),archive:audit(target),bytes:raw.length});}
const target=path.join(__dirname,'evidence','nanite-curve-native-fixes-'+stamp+'.json');
fs.writeFileSync(target,JSON.stringify({pass:true,date:new Date().toISOString(),source:audit(__filename),build,native,gpu,segmentChecks,files,
 boundary:'Native curve Builder and decoder/raster fixes: preserve all leaves and material order, contain decoded radii, encode 256 points, finish long-curve hierarchies, fetch wave-boundary endpoints and encode segment visibility IDs. 29 direct Builder fixtures and four real Groom inputs pass GPU decoding and independent bounds checks, plus 720 GPU wave configurations and 1101248 CPU checks of encoded segment IDs. Browser component, streaming and complete Nanite acceptance remain open.'},null,2)+'\n');
console.log({pass:true,target,files:files.length,segmentChecks});
