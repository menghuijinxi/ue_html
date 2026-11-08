'use strict';
const assert=require('node:assert/strict');
const verifyInputs=require('./verify-nanite-material-inputs.cjs');
const bits=new DataView(new ArrayBuffer(4));
const f=b=>{bits.setUint32(0,b,true);return bits.getFloat32(0,true);};
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const normalize=a=>{const n=Math.hypot(...a);assert(n>0);return a.map(x=>x/n);};
const srgb=v=>v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055;
const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
module.exports=function verifyGBuffer(result,page) {
  const {before,after,materialInputs:inputs,entries,step}=result;
  const count=result.materialWidth*result.materialHeight;
  assert(step>=1&&step<=6);assert.equal(result.materialStride,8);assert.equal(result.rejected,0);
  assert(result.srgbBaseColor);assert(['FloatR11G11B10','FloatRGBA'].includes(result.colorFormat));
  assert.equal(before.length,count*28);assert.equal(after.length,before.length);
  // Full-resolution projected edges amplify float arithmetic more than the
  // 192x128 offscreen probe. Position tolerance remains below 1/256 source unit.
  const inputTolerances={position:.001,normal:.000025,uv:.000008,color:.000001};
  const inputValidation=verifyInputs({...result,sampledVisibility:Array.from({length:count},(_,i)=>before[i*28])},page,inputTolerances);
  let written=0,occluded=0,unbound=0,background=0,changed=0;
  const byComponent={},maxError={normal:0,baseColor:0,baseColorCode:0,parameters:0,emissive:0};
  const near=(actual,expected,tolerance,label)=>{assert(Number.isFinite(actual));const error=Math.abs(actual-expected);assert(error<=tolerance,`${label}: ${actual}, expected ${expected}`);return error;};
  for(let i=0;i<count;++i) {
    const o=i*28,a=i*16,id=before[o];
    assert.deepEqual(after.slice(o,o+4),before.slice(o,o+4),'GBuffer pass must preserve visibility, depth and pre-exposure');
    let entry;
    if(id) {const slot=(id>>>8)-1;entry=entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);assert(entry);}
    const bound=entry&&entry.bindingCurrent&&entry.materialSlot===inputs[a+2];
    const winner=id&&before[o+1]===before[o+2];
    if(!id||!winner||!bound) {
      assert.deepEqual(after.slice(o+4,o+28),before.slice(o+4,o+28),`unowned sample ${i} changed`);
      if(!id) ++background;else if(!winner) ++occluded;else ++unbound;
      continue;
    }
    ++written;byComponent[entry.component]=(byComponent[entry.component]||0)+1;
    if(after.slice(o+4,o+28).some((v,j)=>v!==before[o+4+j])) ++changed;
    const m=entry.localToWorld, rows=[m.slice(0,3),m.slice(4,7),m.slice(8,11)];
    const cofactors=[cross(rows[1],rows[2]),cross(rows[2],rows[0]),cross(rows[0],rows[1])];
    const sign=Math.sign(dot(rows[0],cofactors[0]));assert(sign!==0);
    const local=[8,9,10].map(c=>f(inputs[a+c]));
    const world=normalize([0,1,2].map(c=>sign*local.reduce((s,v,r)=>s+v*cofactors[r][c],0)));
    for(let c=0;c<3;++c) {
      const expected=Math.round((world[c]*.5+.5)*1023)/1023;
      maxError.normal=Math.max(maxError.normal,near(f(after[o+8+c]),expected,1.1/1023,`normal sample ${i}, channel ${c}`));
      const code=Math.round(srgb(entry.baseColor[c])*255),actualColor=f(after[o+16+c]);
      // Hardware sRGB conversion may approximate the ideal transfer curve.
      // Demand the same nearest 8-bit sRGB code, rather than exact linear bits.
      maxError.baseColorCode=Math.max(maxError.baseColorCode,near(srgb(actualColor)*255,code,.5,`sRGB code sample ${i}, channel ${c}`));
      maxError.baseColor=Math.max(maxError.baseColor,Math.abs(actualColor-linear(code/255)));
      const emissive=entry.emissive[c]*f(before[o+3]);assert(f(before[o+3])>0);
      const relativeTolerance=result.colorFormat==='FloatRGBA'?.0015:.035;
      maxError.emissive=Math.max(maxError.emissive,near(f(after[o+4+c]),emissive,Math.max(6e-8,emissive*relativeTolerance),`emissive sample ${i}, channel ${c}`));
    }
    near(f(after[o+7]),result.colorFormat==='FloatRGBA'?0:1,1e-6,'scene color alpha');
    near(f(after[o+11]),0,1e-6,'per-object flags');
    for(const [c,value] of [entry.metallic,entry.specular,entry.roughness,1/255].entries())
      maxError.parameters=Math.max(maxError.parameters,near(f(after[o+12+c]),Math.round(value*255)/255,1e-6,`material parameter ${c}`));
    near(f(after[o+19]),0,1e-6,'indirect irradiance');
    for(let c=0;c<4;++c) {near(f(after[o+20+c]),0,1e-6,'custom data');near(f(after[o+24+c]),1,1e-6,'precomputed shadow factors');}
  }
  assert(background>1000);
  if(step===4) {assert.equal(written,0);assert(unbound>10);}
  else {assert(written>10);assert.equal(changed,written);}
  if([1,3].includes(step)) assert(occluded>10);
  if(step===2) assert.equal(occluded,0);
  if(step===5) {assert(unbound>10);assert.deepEqual(Object.keys(byComponent),['1']);}
  if(step===6) {assert.equal(occluded,0);assert.deepEqual(Object.keys(byComponent),['0']);}
  if(step===1) assert.equal(result.inputRejections,11);
  return {pass:true,samples:count,written,changed,occluded,unbound,background,byComponent,maxError,inputTolerances,inputValidation};
};
