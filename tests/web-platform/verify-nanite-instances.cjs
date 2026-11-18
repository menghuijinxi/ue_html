'use strict';
const assert=require('node:assert/strict');
const transform=(p,m)=>[0,1,2,3].map(c=>p.reduce((s,v,r)=>s+v*m[r*4+c],0));
module.exports=function verifyInstances(test,page,triangles,precision,options) {
  if(!options)assert(test.step>=1&&test.step<=13);assert.equal(test.pendingPSOs,0);assert.equal(test.rejected,0);
  assert.equal(test.expected.length,options?options.expectedCount:[5,5,4,5,2,5,2,50,48,2,0,48,0][test.step-1]);
  assert.equal(test.entries.length,test.expected.length);
  assert.equal(new Set(test.entries.map(e=>e.instanceId)).size,test.entries.length);
  const unmatched=[...test.expected],count=page.readUInt32LE(0)&65535;
  let transformError=0,selected=0;
  for(const e of test.entries){
    assert.equal(e.state[1],0);
    // HISM may reorder instances for its tree. Match component and complete world
    // transform against game-thread GetInstanceTransform, independently of the
    // render-thread instance buffer addressing and GPUScene allocation order.
    const i=unmatched.findIndex(x=>x.component===e.component&&x.localToWorld.every((v,k)=>Math.abs(v-e.localToWorld[k])<.0002));
    assert(i>=0,'Unexpected render instance transform');
    transformError=Math.max(transformError,...unmatched[i].localToWorld.map((v,k)=>Math.abs(v-e.localToWorld[k])));unmatched.splice(i,1);
    const keys=[];let tris=0;
    for(let c=0;c<count;++c){
      const at=(v,a)=>16+(v*count+c)*16+a*4;
      if(!(page.readUInt32LE(at(4,3))&4))continue;
      const corners=Array.from({length:8},(_,k)=>transform(transform([0,1,2].map(a=>page.readFloatLE(at(3,a))+((k>>a)&1?1:-1)*page.readFloatLE(at(4,a))).concat(1),e.localToWorld),test.worldToClip));
      const distance=p=>[p[3]+p[0],p[3]-p[0],p[3]+p[1],p[3]-p[1],p[2],p[3]-p[2]];
      if([0,1,2,3,4,5].some(p=>corners.every(c=>distance(c)[p]<-1e-5)))continue;
      keys.push((e.page<<8)|c);tris+=page.readUInt32LE(at(0,1))&255;
    }
    assert.deepEqual(e.keys.slice(0,e.state[0]).sort((a,b)=>a-b),keys);assert.equal(e.state[3],tris);
    assert(e.keys.slice(keys.length).every(k=>k===0xffffffff));selected+=keys.length;
  }
  assert.equal(unmatched.length,0);
  // Reuse the original-triangle oracle without its old single-component scenario
  // ordinal assertions. Geometry, winning instance, depth and attributes remain
  // checked with exactly the same tolerances.
  const generic={...test,step:test.entries.length&&!options?.empty?100+test.step:4};
  const raster=require('./verify-nanite-raster-output.cjs')(generic,triangles,page,precision);
  const material=require('./verify-nanite-material-inputs.cjs')({...generic,raster},page,{position:1/512,normal:1/25600,uv:.000008,color:.000001});
  let hardwareComparison;
  if(test.hardwareVisibility) {
    assert.equal(test.microSpan,[0,1,4,8][(test.step-1)%4]);
    const hardwareRaster=require('./verify-nanite-raster-output.cjs')({...generic,visibility:test.hardwareVisibility},triangles,page,precision);
    assert.equal(test.visibility.length,test.hardwareVisibility.length);
    let covered=0,maxDepthError=0;
    const floats=new Float32Array(2),words=new Uint32Array(floats.buffer);
    for(let i=0;i<test.visibility.length;i+=2) {
      assert.equal(test.visibility[i],test.hardwareVisibility[i],'Mixed/hardware winning ID at pixel '+i/2);
      words[0]=test.visibility[i+1];words[1]=test.hardwareVisibility[i+1];
      assert(Number.isFinite(floats[0])&&Number.isFinite(floats[1]));
      maxDepthError=Math.max(maxDepthError,Math.abs(floats[0]-floats[1]));if(test.visibility[i])covered++;
    }
    assert(maxDepthError<2e-6,'Mixed/hardware depth mismatch');
    hardwareComparison={pass:true,span:test.microSpan,covered,maxDepthError,hardwareRaster};
  }
  return {...(hardwareComparison?{hardwareComparison}:{}),pass:true,instances:test.entries.length,selected,transformError,raster,material};
};
