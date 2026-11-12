'use strict';
// Fresh-process comparison: the cache must be disabled before engine startup.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [offTag,onTag,outputTag]=process.argv.slice(2);
assert([offTag,onTag,outputTag].every(v=>/^[a-z0-9-]+$/.test(v)));
const read=f=>JSON.parse(fs.readFileSync(f));
const inputs=[offTag,onTag].map(t=>path.join(__dirname,'results',t,'report.json'));
const [off,on]=inputs.map(read);assert(off.pass&&on.pass);
assert.equal(off.materialPrecache,'0');assert.equal(on.materialPrecache,'1');
assert.equal(off.package.sha256,on.package.sha256);assert.equal(off.scalar,on.scalar);assert.equal(off.villa,on.villa);
assert.equal(off.tests.length,on.tests.length);
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const comparisons=off.tests.map((t,i)=>{
 const u=on.tests[i];assert.equal(t.label,u.label);assert.equal(t.batch,u.batch);
 for(const r of [t,u])assert.equal(audit(r.readback.file).sha256,r.readback.sha256);
 const [a,b]=[t,u].map(t=>read(t.readback.file));
 assert.equal(a.materialPrecache,false);assert.equal(b.materialPrecache,true);
 const cameraDifference={};
 for(const key of new Set([...Object.keys(a.view),...Object.keys(b.view)])){
  if(['x','y','z'].includes(key)){cameraDifference[key]=Math.abs(a.view[key]-b.view[key]);assert(cameraDifference[key]<=1e-4,'Fresh-process camera origin tolerance: 0.0001 cm');}
  else assert.equal(a.view[key],b.view[key],key);
 }
 assert.equal(a.registered,b.registered);assert.equal(a.entries,b.entries);
 assert.equal(a.rejected,0);assert.equal(b.rejected,0);
 if(!a.entries){assert(!a.enabled&&!b.enabled);assert(!a.pixels?.length&&!b.pixels?.length);return {label:t.label,batch:t.batch,entries:0,covered:0};}
 assert(a.materialComplete&&b.materialComplete);
 assert.equal(a.pixels.length,b.pixels.length);let covered=0,maxSpecularDifference=0;
 for(let p=0;p<a.pixels.length;p+=28){
  assert.equal(a.pixels[p+2],b.pixels[p+2],`Scene depth at ${p/28}`);
  const owns=v=>!!v.pixels[p]&&v.pixels[p+1]===v.pixels[p+2];
  assert.equal(owns(a),owns(b),`Nanite ownership at ${p/28}`);if(!owns(a))continue;covered++;
  assert.equal(a.pixels[p+1],b.pixels[p+1]);
  for(let j=8;j<28;j++){
   if(j===13){const d=Math.abs(float(a.pixels[p+j])-float(b.pixels[p+j]));assert(d<=1/255+1e-7);maxSpecularDifference=Math.max(maxSpecularDifference,d);}
   else assert.equal(a.pixels[p+j],b.pixels[p+j],`Material channel ${j} at ${p/28}`);
  }
 }
 if(a.entries)assert(covered>20);
 return {label:t.label,batch:t.batch,entries:a.entries,covered,maxSpecularDifference,cameraDifference};
});
const directory=path.join(__dirname,'results',outputTag);assert(!fs.existsSync(directory));fs.mkdirSync(directory);
fs.copyFileSync(__filename,path.join(directory,'source.cjs'));
fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({pass:true,source:audit(__filename),inputs:inputs.map(audit),comparisons,
 boundary:'Same package, fresh processes, precache changed before startup. Frozen visual clock and temporal sequence. Camera origin tolerance 0.0001 cm; projection/jitter remain exact. Exact scene/Nanite depth, ownership and material channels; specular tolerance 1/255. IDs used to encode atomic visibility can differ between processes and are not compared.'},null,2)+'\n');
console.log({pass:true,comparisons:comparisons.length,directory});
