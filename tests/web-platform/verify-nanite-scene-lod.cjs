'use strict';
const assert=require('node:assert/strict');
const verifyCull=require('./verify-nanite-scene-cull-output.cjs'),verifyRaster=require('./verify-nanite-raster-output.cjs');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');
module.exports=function verifyLOD(result,page,hierarchy,previous,precision) {
  assert(result.step>=26&&result.step<=35);
  assert.equal(result.pixelsPerEdge,result.step===35?2:1);
  assert(result.lodViewHeight>0&&result.projection.length===16&&result.worldToView.length===16);
  for(const entry of result.entries) {
    const m=entry.localToWorld,scale=[0,1,2].map(row=>Math.hypot(...m.slice(row*4,row*4+3)));
    const projection=result.projection,near=projection[15]<1?projection[14]:(1-projection[14])/projection[10];
    const params=[.5*projection[5]*result.lodViewHeight/result.pixelsPerEdge,Math.min(...scale),Math.max(...scale),near].map(Math.fround);
    // JSON round trips discard the sign of zero; both represent the same near plane.
    assert.equal(entry.lodParameters.length,params.length);
    entry.lodParameters.forEach((value,index)=>assert(value===params[index],
      'LOD parameters must use actual view resolution and transform scale'));
    const expected=Array.from({length:16},(_,i)=>Math.fround([0,1,2,3].reduce((n,k)=>n+m[Math.floor(i/4)*4+k]*result.worldToView[k*4+i%4],0)));
    entry.localToView.forEach((v,i)=>assert(Math.abs(v-expected[i])<1e-4,'Camera-relative matrix '+i));
  }
  const references=verifyCull(result,page,previous,hierarchy),meshes=new Map();
  const counts=[];
  for(const {component,keys} of references) {
    const values=[];
    for(const key of keys) {const c=key&255,n=page.readUInt32LE(16+c*16+4)&255;
      for(let t=0;t<n;t++)for(const v of decodeTriangle(page,c,t).vertices)values.push(...v.position);}
    const bytes=Buffer.alloc(values.length*4);values.forEach((v,i)=>bytes.writeFloatLE(v,i*4));meshes.set(component,bytes);
    counts.push({component,clusters:keys.length,triangles:values.length/9,keys});
  }
  // Expected geometry is decoded from independently selected CPU LOD keys,
  // never the GPU-visible list or pixels being tested.
  const raster=verifyRaster(result,null,page,precision,meshes);
  return {pass:true,counts,raster};
};
