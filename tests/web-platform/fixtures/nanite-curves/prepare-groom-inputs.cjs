'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const root=path.join(__dirname,'groom'),output=path.join(__dirname,'groom-gpu');
const f=Math.fround,sub=(a,b)=>a.map((v,j)=>f(v-b[j])),length=v=>f(Math.sqrt(f(f(f(v[0]*v[0])+f(v[1]*v[1]))+f(v[2]*v[2]))));
const normalize=v=>{const n=length(v);return v.map(x=>f(x/n));};
const results=[];
for(const name of ['NaniteGroomSmall','NaniteGroomStreaming','NaniteGroomLong256','NaniteGroomStreamingB']){
 const dir=path.join(root,name),dest=path.join(output,name),groom=JSON.parse(fs.readFileSync(path.join(dir,'groom.json')));
 assert(groom.pass&&groom.class==='GroomAsset'&&groom.groups===2&&groom.materials===2);assert(groom.builderVersion.endsWith('_CURVES_1'));
 const authored=fs.readFileSync(path.join(dir,'authored-position-width.bin')),count=groom.authoredCurves,authoredN=groom.authoredPointsPerCurve;
 assert.equal(authored.length,count*authoredN*16);assert(authoredN===8||authoredN===32||authoredN===256);
 assert.equal(groom.builderMaxPointsPerCurve,256);
 // Native Groom import keeps at most 255 authored control points, then Nanite
 // resamples to a power of two. Thus a 256-point source becomes 128 samples;
 // the separate direct Builder fixtures exercise actual 256-point clusters.
 const n=Math.min(authoredN,255),m=Math.min(2**Math.floor(Math.log2(n)),groom.builderMaxPointsPerCurve);
 const points=Buffer.alloc(count*m*44),materials=Buffer.alloc(count*4),side=Math.ceil(Math.sqrt(count));
 for(let c=0;c<count;c++){
  const p=Array.from({length:n},(_,i)=>Array.from({length:3},(_,j)=>authored.readFloatLE((c*authoredN+i)*16+j*4)));
  const radius=Array.from({length:n},(_,i)=>f(authored.readFloatLE((c*authoredN+i)*16+12)*.5));
  const distances=[0];for(let i=1;i<n;i++)distances.push(f(distances[i-1]+length(sub(p[i],p[i-1]))));
  const u=distances.map(d=>f(d/distances[n-1]));
  const tangents=p.map((v,i)=>normalize(i===0?sub(p[1],v):i===n-1?sub(v,p[i-1]):normalize(sub(v,p[i-1])).map((x,j)=>f(x+normalize(sub(p[i+1],v))[j]))));
  materials.writeInt32LE(c<count/2?0:1,c*4);
  for(let i=0;i<m;i++){
   const t=f(i/(m-1));let lower=0;while(lower<n-2&&!(u[lower]<=t&&t<=u[lower+1]))lower++;
   const s=f(f(t-u[lower])/Math.max(f(u[lower+1]-u[lower]),1e-4)),b=f(1-s),d=length(sub(p[lower+1],p[lower]));
   assert(s>=0&&s<=1);
   const controls=[p[lower],p[lower].map((v,j)=>f(v+f(f(tangents[lower][j]*d)*.25))),
    p[lower+1].map((v,j)=>f(v-f(f(tangents[lower+1][j]*d)*.25))),p[lower+1]];
   const position=[0,1,2].map(j=>f(b**3*controls[0][j]+3*b*b*s*controls[1][j]+3*b*s*s*controls[2][j]+s**3*controls[3][j]));
   const tangent=normalize([0,1,2].map(j=>f(3*b*b*(controls[1][j]-controls[0][j])+6*b*s*(controls[2][j]-controls[1][j])+3*s*s*(controls[3][j]-controls[2][j]))));
   const r=f(radius[lower]+s*f(radius[lower+1]-radius[lower]));
   const values=[...position,...tangent,r,t,0,f((c%side)/side),f(Math.floor(c/side)/side)];
   values.forEach((v,j)=>points.writeFloatLE(v,(c*m+i)*44+j*4));
  }
 }
 fs.mkdirSync(dest,{recursive:true});
 const copies=['roots.bin','hierarchy.bin','page-states.bin','page-dependencies.bin',...(groom.pages>groom.rootPages?['streaming.bin']:[])];
 for(const file of copies)fs.copyFileSync(path.join(dir,file),path.join(dest,file));
 fs.writeFileSync(path.join(dest,'source-points.bin'),points);fs.writeFileSync(path.join(dest,'source-materials.bin'),materials);
 const hierarchy=fs.readFileSync(path.join(dest,'hierarchy.bin')),hierarchyNodes=hierarchy.length/240,children=new Set();
 for(let node=0;node<hierarchyNodes;node++)for(let child=0;child<4;child++){
  if(hierarchy.readUInt32LE(node*240+192+child*12)===0xffffffff)children.add(hierarchy.readUInt32LE(node*240+128+child*16+12));
 }
 const roots=Array.from({length:hierarchyNodes},(_,i)=>i).filter(i=>!children.has(i));assert.equal(roots.length,1);assert.equal(groom.rootNodes,1);
 const fixture={...groom,groom:true,curves:count,points:count*m,pointsPerCurve:m,sourceStrideFloats:11,variableRadius:true,
  streaming:groom.pages>groom.rootPages,pageStateStride:20,hierarchyNodes,rootNode:roots[0]};
 fs.writeFileSync(path.join(dest,'fixture.json'),JSON.stringify(fixture,null,2)+'\n');
 results.push({name,inputs:['groom.json','authored-position-width.bin',...copies].map(file=>audit(path.join(dir,file))),outputs:['fixture.json','source-points.bin','source-materials.bin',...copies].map(file=>audit(path.join(dest,file)))});
}
const hair=path.join(process.env.UE_ENGINE_ROOT||'D:/UE_5.8/Engine','Plugins/Runtime/HairStrands/Source/HairStrandsCore');
const nativeSources=['Private/NaniteGroomBuilder.cpp','Private/GroomBuilder.cpp'].map(file=>audit(path.join(hair,file)));
nativeSources.push(audit(path.join(process.env.UE_ENGINE_ROOT||'D:/UE_5.8/Engine','Shaders/Shared/HairStrandsDefinitions.h')));
fs.writeFileSync(path.join(__dirname,'groom-inputs.json'),JSON.stringify({pass:true,source:audit(__filename),nativeSources,results},null,2)+'\n');
console.log({pass:true,fixtures:results.length});
