'use strict';
const assert=require('node:assert/strict');
module.exports=function verifyViews(test,page,triangles,precision){
 assert.equal(test.sceneCapture,true);assert(test.step>=1&&test.step<=10);
 assert.equal(test.perspective,![5,6].includes(test.step));assert(test.viewKey>0);
 const count=[5,2,3,0,5,5,5,0,5,5][test.step-1];
 const base=require('./verify-nanite-instances.cjs')(test,page,triangles,precision,{expectedCount:count,empty:[4,6,8].includes(test.step)});
 assert.equal(test.sceneWidth,test.step===10?160:128);assert.equal(test.sceneHeight,test.step===10?80:96);
 assert.equal(test.scenePixels.length,test.sceneWidth*test.sceneHeight*4);
 const f=new Float32Array(1),u=new Uint32Array(f.buffer);let covered=0,maxError=0;
 for(let i=0;i<test.scenePixels.length;i+=4){
  const [id,z,d,guard]=test.scenePixels.slice(i,i+4);assert.equal(guard,0);
  if(!id){assert.equal(z,0);continue;}covered++;
  u[0]=z;const nanite=f[0];u[0]=d;const depth=f[0];assert(nanite>0&&nanite<=1&&depth>=nanite-2e-6);
  maxError=Math.max(maxError,Math.abs(nanite-depth));
 }
 if([4,6,8].includes(test.step))assert.equal(covered,0);else assert(covered>20);
 assert(maxError<2e-6,'Capture attachment must contain actual Nanite depth');
 return {...base,sceneCovered:covered,sceneDepthError:maxError};
};
