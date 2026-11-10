'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');

const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((s,x,r)=>s+x*m[r*4+c],0));
function check(t){
 const records=Buffer.from(t.visibleRecords,'base64'),stream=Buffer.from(t.streamPages,'base64'),roots=Buffer.from(t.rootPagesData,'base64');
 const stride=t.recordBytes/t.totalClusters;assert(stride===8||stride===12);assert.equal(records.length,t.recordBytes);
 const raster=Array(t.width*t.height).fill(null),boundaries=new Map(),unique=new Map(),details=[];
 let triangles=0;
 const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
 for(let slot=0;slot<t.cullState[0];slot++){
  const raw=records.readBigUInt64LE(slot*stride),pool=Number(raw>>41n),limit=t.poolPages*256;
  const page=pool<limit?pool>>>8:t.poolPages+((pool-limit)>>>6),cluster=pool<limit?pool&255:(pool-limit)&63;
  const data=page<t.poolPages?stream.subarray(page*131072,(page+1)*131072):roots.subarray((page-t.firstRoot)*32768,(page-t.firstRoot+1)*32768);
  const count=data.readUInt32LE(0)&65535,numTris=data.readUInt32LE(16+cluster*16+4)&255;
  details.push({slot,page,cluster,numTris,count});
  for(let tri=0;tri<numTris;tri++){
   const decoded=decodeTriangle(data,cluster,tri);triangles++;
   const v=decoded.vertices.map(vertex=>{
    const key=vertex.position.join(',');
    const binding=new Map();for(const i of vertex.influences)if(i.weight!==0)binding.set(i.bone,(binding.get(i.bone)||0)+i.weight);
    const weights=[...binding].sort((a,b)=>a[0]-b[0]);
    if(!unique.has(key))unique.set(key,new Set());unique.get(key).add(JSON.stringify(weights));
    const f=Math.fround,p=[0,0,0];
    for(const influence of vertex.influences){const m=t.bones[influence.bone].map(f);
     for(let j=0;j<3;j++){const q=f(f(f(f(vertex.position[0]*m[j])+f(vertex.position[1]*m[4+j]))+f(vertex.position[2]*m[8+j]))+m[12+j]);p[j]=f(p[j]+f(q*influence.weight));}}
    const world=mul([...p,1],t.localToWorld).map((v,j)=>v+([40,25,15,0][j])*(vertex.color[j]??0));
    const clip=mul(world,t.worldToClip).map(f);assert(clip[3]>0);
    return {key,x:Math.round((clip[0]/clip[3]+1)*t.viewWidth/2*256)/256,y:Math.round((1-clip[1]/clip[3])*t.viewHeight/2*256)/256,z:clip[2]/clip[3]};
   });
   for(let j=0;j<3;j++){const edge=[v[j].key,v[(j+1)%3].key].sort().join(';');boundaries.set(edge,(boundaries.get(edge)||0)+1);}
   const area=cross(v[0],v[1],v[2].x,v[2].y);if(Math.abs(area)<1e-9)continue;
   const xmin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.x))-.51)/8)),xmax=Math.min(t.width-1,Math.floor((Math.max(...v.map(a=>a.x))-.49)/8));
   const ymin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.y))-.51)/8)),ymax=Math.min(t.height-1,Math.floor((Math.max(...v.map(a=>a.y))-.49)/8));
   for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
    const w=[cross(v[1],v[2],x*8+.5,y*8+.5),cross(v[2],v[0],x*8+.5,y*8+.5),cross(v[0],v[1],x*8+.5,y*8+.5)].map(a=>a/area);
    if(w.some(a=>a<0))continue;const depth=w.reduce((s,a,j)=>s+a*v[j].z,0),i=y*t.width+x;
    if(!raster[i]||depth>raster[i].depth)raster[i]={slot,tri,depth};
   }
  }
 }
 const missing=[],extra=[];let expected=0,covered=0;
 for(let i=0;i<raster.length;i++){if(raster[i])expected++;if(t.pixels[i*12])covered++;if(raster[i]&&!t.pixels[i*12])missing.push({x:i%t.width,y:Math.floor(i/t.width),...raster[i]});if(!raster[i]&&t.pixels[i*12])extra.push({x:i%t.width,y:Math.floor(i/t.width)});}
 return {step:t.step,triangles,expected,covered,missing,extra,details,duplicateWeights:[...unique].filter(([k,s])=>s.size>1).map(([k,s])=>({position:k,weights:[...s]})),boundaryEdges:[...boundaries].filter(([k,n])=>n===1).length,nonmanifold:[...boundaries].filter(([k,n])=>n>2),raster:raster.map(Boolean)};
}
// Compare the real failing payload and the rebuilt package, keeping the native
// selected triangles as an independent check of the GPU's raster coverage.
const previous=path.join(__dirname,'results/nanite-skinning/failure-budget-cracks/browser.json');
const current=path.join(__dirname,'results/nanite-skinning-budget/browser.json');
const before=JSON.parse(fs.readFileSync(previous)),after=JSON.parse(fs.readFileSync(current));
assert(!before.pass&&before.failure.includes('31 !== 0'));assert(after.pass);
assert.equal(after.package.sha256,audit(path.join(__dirname,'build/nanite-browser/package.json')).sha256);
const baseline=before.budgets[0].tests.slice(0,3).map(check),rebuilt=after.budgets[0].tests.slice(0,3).map(check);
assert.equal(baseline.length,3);assert.equal(rebuilt.length,3);
for(const step of [...baseline,...rebuilt]){
 assert.deepEqual(step.missing,[]);assert.deepEqual(step.extra,[]);assert.equal(step.expected,step.covered);
}
assert(baseline[0].duplicateWeights.length>0&&baseline[2].duplicateWeights.length>0,'original coarse geometry must reproduce split bindings');
for(const step of rebuilt)assert.equal(step.duplicateWeights.length,0,`rebuilt step ${step.step} must retain one bone binding per position`);
const result={pass:true,source:audit(__filename),decoder:audit(path.join(__dirname,'verify-nanite-material-inputs.cjs')),
 inputs:[audit(previous),audit(current)],package:after.package,baseline,rebuilt};
fs.writeFileSync(path.join(__dirname,'results/nanite-skinning/weld-browser.json'),JSON.stringify(result,null,2));
console.log({pass:true,before:baseline.map(s=>({step:s.step,splitBindings:s.duplicateWeights.length})),after:rebuilt.map(s=>({step:s.step,splitBindings:s.duplicateWeights.length,covered:s.covered}))});
