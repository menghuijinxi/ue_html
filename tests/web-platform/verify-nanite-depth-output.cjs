'use strict';
const assert = require('node:assert/strict');

module.exports = function verifyDepth(result) {
  const {step,width,height,before,after} = result;
  assert(step>=20&&step<=24);assert(width>100&&height>50&&result.stride===4);
  assert.equal(result.entries,step===23?0:2);assert.equal(result.registered,step===23?0:2);
  assert.equal(result.rejected,0); assert.equal(result.depthFormat,'DepthStencil');
  if(step===20) assert.equal(result.inputRejections,5);
  assert.equal(before.length,width*height*4);assert.equal(after.length,before.length);
  const floats=new Float32Array(1), bits=new Uint32Array(floats.buffer);
  const asFloat=b=>{bits[0]=b;return floats[0];};
  let nanite=0, ordinary=0, nearerOrdinary=0, nearerNanite=0, overlap=0, unchangedBackground=0, maxError=0;
  for(let i=0;i<before.length;i+=4) {
    assert.equal(before[i],after[i],'visibility ID changed during export');
    assert.equal(before[i+1],after[i+1],'visibility depth changed during export');
    assert.equal(before[i+3],0);assert.equal(after[i+3],0);
    const oldDepth=asFloat(before[i+2]), newDepth=asFloat(after[i+2]), naniteDepth=asFloat(before[i+1]);
    assert(Number.isFinite(oldDepth)&&oldDepth>=0&&oldDepth<=1);
    assert(Number.isFinite(newDepth)&&newDepth>=0&&newDepth<=1);
    const valid=(before[i]>>>8)!==0;
    if(valid) {++nanite;assert(Number.isFinite(naniteDepth)&&naniteDepth>=0&&naniteDepth<=1);}
    else assert.equal(before[i+1],0);
    if(oldDepth>0) ++ordinary;
    const expected=valid?Math.max(oldDepth,naniteDepth):oldDepth;
    const error=Math.abs(newDepth-expected);maxError=Math.max(maxError,error);
    assert(error<2e-7,`step ${step}, pixel ${i/4}: before ${oldDepth}, Nanite ${naniteDepth}, after ${newDepth}`);
    if(!valid) {assert.equal(after[i+2],before[i+2],'empty visibility must preserve scene depth');++unchangedBackground;}
    if(valid&&oldDepth>0) ++overlap;
    if(valid&&oldDepth>naniteDepth+1e-6) {++nearerOrdinary;assert.equal(after[i+2],before[i+2]);}
    if(valid&&naniteDepth>oldDepth+1e-6) ++nearerNanite;
  }
  assert(unchangedBackground>1000);
  if(step===23) {assert.equal(nanite,0);assert(ordinary>50);}
  else assert(nanite>100,'actual Nanite depth coverage required');
  if(step===20) {assert(overlap>50);assert(nearerOrdinary>50,'foreground ordinary mesh must occlude Nanite');}
  if(step===21) {assert(overlap>50);assert(nearerNanite>100,'Nanite must replace background ordinary mesh depth');}
  if(step===22) {assert(nearerOrdinary>20);assert(nearerNanite>20,'partial overlap must keep both contributors');}
  if(step===24) {assert.equal(ordinary,0,'ordinary mesh hidden');assert(nearerNanite>100);}
  return {pass:true,samples:width*height,nanite,ordinary,nearerOrdinary,nearerNanite,overlap,unchangedBackground,maxError};
};
