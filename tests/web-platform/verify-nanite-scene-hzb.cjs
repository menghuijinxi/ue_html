'use strict';
const assert=require('node:assert/strict');
module.exports=function verifyHZB(test) {
  assert(test.step>=1&&test.step<=9);assert.equal(test.pendingPSOs,0);
  assert(test.viewKey>0,'Persistent view must exercise temporal history');
  if(test.step===9){assert.equal(test.entries,0);return {pass:true,hidden:true};}
  assert.equal(test.entries,1);
  if(test.step===1)assert.equal(test.invalidInputRejections,13);
  const keys=prefix=>{const state=test[prefix+'State'],list=test[prefix+'Keys'];
    assert(state?.length===4&&list);assert.equal(state[1],0);assert(state[0]<=list.length);
    const selected=list.slice(0,state[0]);assert.equal(new Set(selected).size,selected.length);
    assert(list.slice(state[0]).every(k=>k===0xffffffff));return selected;};
  const candidate=keys('candidate'),main=keys('main'),final=keys('final');
  assert(candidate.length>0);assert(main.every(k=>candidate.includes(k)));assert(final.every(k=>candidate.includes(k)));
  assert(main.every(k=>final.includes(k)),'Final must preserve every main candidate');
  assert(test.pixels.length===test.width*test.height*4);
  let covered=0;for(let i=0;i<test.pixels.length;i+=4)if(test.pixels[i]) {
    // Scene depth must contain the winning Nanite depth or a nearer occluder.
    assert(test.pixels[i+2]>=test.pixels[i+1]);covered++;
  }
  if([1,3,8].includes(test.step)){assert.equal(main.length,0);assert.equal(final.length,0);assert.equal(covered,0);}
  else {assert(final.length>0);assert(covered>5);}
  if(test.step===2){assert.equal(main.length,0,'The removed occluder must still be present in previous HZB');
    assert.deepEqual([...final].sort((a,b)=>a-b),[...candidate].sort((a,b)=>a-b),'Restore all candidates in the same frame');}
  return {pass:true,candidates:candidate.length,main:main.length,final:final.length,recovered:final.length-main.length,covered};
};
