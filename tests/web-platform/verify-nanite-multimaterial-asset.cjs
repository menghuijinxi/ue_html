'use strict';
const assert=require('node:assert/strict');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');
// Match every full-detail Nanite triangle against source positions AND the
// source polygon's material assignment, independently of the shader decoder.
module.exports=function(page,source,materials) {
  assert.equal(source.length,960*9*4);assert.equal(materials.length,960*4);
  const key=vertices=>vertices.map(p=>p.map(v=>Math.round(v*256)).join(',')).sort().join(';');
  const expected=new Map(),slots=new Set();
  for(let i=0;i<960;++i) {
    const slot=materials.readUInt32LE(i*4);slots.add(slot);
    const vertices=Array.from({length:3},(_,v)=>Array.from({length:3},(_,c)=>source.readFloatLE((i*9+v*3+c)*4)));
    const k=key(vertices)+'/'+slot;expected.set(k,(expected.get(k)||0)+1);
  }
  assert.deepEqual([...slots].sort((a,b)=>a-b),[0,7,31,63]);
  const count=page.readUInt32LE(0)&65535,byMaterial={};let leafTriangles=0,slowClusters=0,mixedClusters=0;
  const word=(cluster,v,c)=>page.readUInt32LE(16+(v*count+cluster)*16+c*4);
  for(let cluster=0;cluster<count;++cluster) {
    if(!(word(cluster,4,3)&4)) continue;
    if(word(cluster,5,3)>=0xfe000000)++slowClusters;
    const clusterSlots=new Set();
    for(let tri=0;tri<(word(cluster,0,1)&255);++tri) {
      const decoded=decodeTriangle(page,cluster,tri),k=key(decoded.vertices.map(v=>v.position))+'/'+decoded.material;
      assert((expected.get(k)||0)>0,`Nanite source/material mismatch: ${k}`);
      expected.set(k,expected.get(k)-1);++leafTriangles;clusterSlots.add(decoded.material);
      byMaterial[decoded.material]=(byMaterial[decoded.material]||0)+1;
    }
    if(clusterSlots.size>1)++mixedClusters;
  }
  assert.equal(leafTriangles,960);assert([...expected.values()].every(n=>n===0));
  assert(mixedClusters>0);assert(slowClusters>0,'fixture must exercise the material range table');
  return {pass:true,leafTriangles,byMaterial,mixedClusters,slowClusters};
};
