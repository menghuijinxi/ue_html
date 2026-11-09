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
function sampleTexture(index, uv, dx, dy, lodOffset=0) {
  const size=index?64:128, maxMip=index?6:7;
  // D3D orthogonalizes the projected footprint before isotropic LOD selection.
  // Its major-axis length is the largest singular value of the UV Jacobian.
  // Direct3D functional specification, section 7.18.11 (LOD Calculations).
  const a=dot(dx,dx),b=dot(dy,dy),c=dot(dx,dy);
  const major=Math.sqrt((a+b+Math.hypot(a-b,2*c))/2);
  const lod=Math.max(0,Math.min(maxMip,Math.log2(major*size)+lodOffset));
  const level=mip=>{
    const n=size>>mip, x=uv[0]*n-.5, y=uv[1]*n-.5, ix=Math.floor(x), iy=Math.floor(y), fx=x-ix, fy=y-iy;
    const texel=(x,y)=>{
      x=((x%n)+n)%n;y=((y%n)+n)%n;
      const block=Math.max(1,n/8), rgb=[(Math.floor(x/block)+Math.floor(y/block))%2?224:48,
        48+Math.floor(160*y/Math.max(1,n-1)),32+24*mip+16*index];
      return rgb.map(v=>index?v/255:linear(v/255));
    };
    const a=texel(ix,iy),b=texel(ix+1,iy),c=texel(ix,iy+1),d=texel(ix+1,iy+1);
    return a.map((v,j)=>(v*(1-fx)+b[j]*fx)*(1-fy)+(c[j]*(1-fx)+d[j]*fx)*fy);
  };
  const lo=Math.floor(lod),hi=Math.min(maxMip,lo+1),t=lod-lo,low=level(lo),high=level(hi);
  return {color:low.map((v,c)=>v*(1-t)+high[c]*t),lod,maxMip};
}
function textureReference(index,uv,dx,dy,base,actual) {
  const ideal=sampleTexture(index,uv,dx,dy);
  // The D3D specification permits approximations of the footprint transform.
  // Bound that separately from filtering precision: one COMMON LOD offset must
  // explain all RGB channels within two codes, at most 1/4 mip from the ideal.
  // This is this probe's acceptance limit, not a claimed cross-vendor guarantee.
  // Quantized RGB acceptance intervals can be narrower than 1/1024 mip at a
  // mip boundary. Refine the search before rejecting; keep both bounds fixed.
  for(const resolution of [1024,16384]) for(let i=0;i<=resolution/2;++i) {
    const offset=i===0?0:Math.ceil(i/2)/resolution*(i%2?1:-1);
    const sample=i===0?ideal:sampleTexture(index,uv,dx,dy,offset);
    const color=base.map((v,c)=>v*sample.color[c]);
    if(color.every((v,c)=>Math.abs(srgb(actual[c])*255-Math.round(srgb(v)*255))<=2))
      return {...ideal,color,offset};
  }
  assert.fail(`texture ${index}: RGB does not match any common LOD within 1/4 mip of ${ideal.lod}; actual ${actual}`);
}
module.exports=function verifyGBuffer(result,page) {
  const {before,after,materialInputs:inputs,entries,step}=result;
  const count=result.materialWidth*result.materialHeight;
  assert(step>=1&&step<=19);assert.equal(result.materialStride,8);assert.equal(result.rejected,0);
  assert(result.srgbBaseColor);assert(['FloatR11G11B10','FloatRGBA'].includes(result.colorFormat));
  assert.equal(before.length,count*28);assert.equal(after.length,before.length);
  // Full-resolution projected edges amplify float arithmetic more than the
  // 192x128 offscreen probe. Position tolerance remains below 1/256 source unit.
  // Material boundaries reorder triangle vertices in the rebuilt page. Float
  // barycentrics near silhouettes can differ from the double solve by 0.0012;
  // retain a half-source-quantum position bound (precision 8) for this fixture.
  // The radius-50 sphere's normal interpolation uses the corresponding angular
  // bound. This fixture-specific allowance is smaller than GBuffer quantization.
  const inputTolerances={position:step>=13?1/512:.001,normal:step>=13?1/25600:.000025,uv:.000008,color:.000001};
  const inputValidation=verifyInputs({...result,sampledVisibility:Array.from({length:count},(_,i)=>before[i*28])},page,inputTolerances);
  let written=0,occluded=0,unbound=0,background=0,changed=0;
  const byComponent={},bySlot={},maxError={normal:0,baseColor:0,baseColorCode:0,parameters:0,emissive:0};
  const textures={samples:0,srgb:0,linear:0,magnified:0,minified:0,clampedLastMip:0,minLOD:null,maxLOD:null,mips:[],maxCodeError:0,maxLODAdjustment:0};
  const mips=new Set();
  const near=(actual,expected,tolerance,label)=>{assert(Number.isFinite(actual));const error=Math.abs(actual-expected);assert(error<=tolerance,`${label}: ${actual}, expected ${expected}`);return error;};
  for(let i=0;i<count;++i) {
    const o=i*28,a=i*16,id=before[o];
    assert.deepEqual(after.slice(o,o+4),before.slice(o,o+4),'GBuffer pass must preserve visibility, depth and pre-exposure');
    let entry;
    if(id) {const slot=(id>>>8)-1;entry=entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);assert(entry);}
    const material=entry&&(entry.materials ? entry.materials.find(m=>m.slot===inputs[a+2]) : entry.materialSlot===inputs[a+2]?entry:null);
    const bound=entry&&entry.bindingCurrent&&material;
    const winner=id&&before[o+1]===before[o+2];
    if(!id||!winner||!bound) {
      assert.deepEqual(after.slice(o+4,o+28),before.slice(o+4,o+28),`unowned sample ${i} changed`);
      if(!id) ++background;else if(!winner) ++occluded;else ++unbound;
      continue;
    }
    ++written;byComponent[entry.component]=(byComponent[entry.component]||0)+1;
    const slotKey=entry.component+'/'+inputs[a+2];bySlot[slotKey]=(bySlot[slotKey]||0)+1;
    if(after.slice(o+4,o+28).some((v,j)=>v!==before[o+4+j])) ++changed;
    const m=entry.localToWorld, rows=[m.slice(0,3),m.slice(4,7),m.slice(8,11)];
    const cofactors=[cross(rows[1],rows[2]),cross(rows[2],rows[0]),cross(rows[0],rows[1])];
    const sign=Math.sign(dot(rows[0],cofactors[0]));assert(sign!==0);
    const local=[8,9,10].map(c=>f(inputs[a+c]));
    const world=normalize([0,1,2].map(c=>sign*local.reduce((s,v,r)=>s+v*cofactors[r][c],0)));
    let baseColor=material.baseColor, textured=material.textureIndex>=0;
    if(textured) {
      const s=verifyInputs.sampleUV(result,page,i),t=material.uvScaleBias;
      const uv=s.uv.map((v,c)=>v*t[c]+t[c+2]),dx=s.dx.map((v,c)=>v*t[c]),dy=s.dy.map((v,c)=>v*t[c]);
      const sample=textureReference(material.textureIndex,uv,dx,dy,baseColor,[0,1,2].map(c=>f(after[o+16+c])));
      baseColor=sample.color;
      textures.maxLODAdjustment=Math.max(textures.maxLODAdjustment,Math.abs(sample.offset));
      ++textures.samples;++textures[material.textureIndex?'linear':'srgb'];
      ++textures[sample.lod===0?'magnified':'minified'];
      if(sample.lod===sample.maxMip) ++textures.clampedLastMip;
      textures.minLOD=textures.minLOD===null?sample.lod:Math.min(textures.minLOD,sample.lod);
      textures.maxLOD=textures.maxLOD===null?sample.lod:Math.max(textures.maxLOD,sample.lod);
      mips.add(Math.floor(sample.lod));
    }
    for(let c=0;c<3;++c) {
      const expected=Math.round((world[c]*.5+.5)*1023)/1023;
      maxError.normal=Math.max(maxError.normal,near(f(after[o+8+c]),expected,1.1/1023,`normal sample ${i}, channel ${c}`));
      const code=Math.round(srgb(baseColor[c])*255),actualColor=f(after[o+16+c]);
      // Hardware sRGB conversion may approximate the ideal transfer curve.
      // Demand the same nearest 8-bit sRGB code, rather than exact linear bits.
      const codeError=near(srgb(actualColor)*255,code,textured?2:.5,`sRGB code sample ${i}, channel ${c}`);
      maxError.baseColorCode=Math.max(maxError.baseColorCode,codeError);
      if(textured) textures.maxCodeError=Math.max(textures.maxCodeError,codeError);
      maxError.baseColor=Math.max(maxError.baseColor,Math.abs(actualColor-linear(code/255)));
      const emissive=material.emissive[c]*f(before[o+3]);assert(f(before[o+3])>0);
      const relativeTolerance=result.colorFormat==='FloatRGBA'?.0015:.035;
      maxError.emissive=Math.max(maxError.emissive,near(f(after[o+4+c]),emissive,Math.max(6e-8,emissive*relativeTolerance),`emissive sample ${i}, channel ${c}`));
    }
    near(f(after[o+7]),result.colorFormat==='FloatRGBA'?0:1,1e-6,'scene color alpha');
    near(f(after[o+11]),0,1e-6,'per-object flags');
    for(const [c,value] of [material.metallic,material.specular,material.roughness,1/255].entries()) {
      // Float32 UNORM conversion rounds a halfway code to the even integer;
      // JS Math.round instead always rounds a positive halfway value upward.
      const scaled=Math.fround(Math.fround(value)*255),lo=Math.floor(scaled);
      const code=scaled-lo===.5?lo+(lo%2):Math.round(scaled);
      maxError.parameters=Math.max(maxError.parameters,near(f(after[o+12+c]),code/255,1e-6,`material parameter ${c}`));
    }
    near(f(after[o+19]),0,1e-6,'indirect irradiance');
    for(let c=0;c<4;++c) {near(f(after[o+20+c]),0,1e-6,'custom data');near(f(after[o+24+c]),1,1e-6,'precomputed shadow factors');}
  }
  assert(background>1000);
  if(step===4||step===19) {assert.equal(written,0);assert(unbound>10);}
  else if(step===11) {assert.equal(written,0);assert(occluded>100);}
  else {assert(written>10);assert.equal(changed,written);}
  if([1,3].includes(step)) assert(occluded>10);
  if(step===2) assert.equal(occluded,0);
  if(step===5) {assert(unbound>10);assert.deepEqual(Object.keys(byComponent),['1']);}
  if(step===6) {assert.equal(occluded,0);assert.deepEqual(Object.keys(byComponent),['0']);}
  if(step===1) assert.equal(result.inputRejections,16);
  if(step>=7&&step<=12&&step!==11) {assert(textures.samples>50);assert(textures.linear>20);}
  if(step>=13) {
    assert.deepEqual(inputValidation.materialSlots,[0,7,31,63]);
    const expected=entries.flatMap(e=>e.bindingCurrent?e.materials.map(m=>e.component+'/'+m.slot):[]).sort();
    assert.deepEqual(Object.keys(bySlot).sort(),expected,'every bound material must shade its own pixels');
    for(const count of Object.values(bySlot))assert(count>5);
    if(step>=15)assert(unbound>10);
    if(step===16)assert.equal(result.slotInputRejections,10);
  }
  if(step===7) {assert(textures.srgb>20);assert(textures.minified>20);}
  if(step===8) {assert(textures.magnified>20);assert(textures.minified>20);}
  if(step===9) assert(textures.clampedLastMip>10);
  if(step===10) {assert.equal(textures.srgb,0);assert(textures.samples<written);}
  textures.mips=[...mips].sort((a,b)=>a-b);
  return {pass:true,samples:count,written,changed,occluded,unbound,background,byComponent,bySlot,maxError,textures,inputTolerances,inputValidation};
};

// Ensure the bounded LOD allowance still detects missing/wrong bindings and UVs.
module.exports.verifyTextureMutations=function(result,page) {
  assert(result.step>=7&&result.step<=10);
  let rejected=0;
  const reject=change=>{
    const bad={...result,entries:structuredClone(result.entries)};change(bad.entries);
    assert.throws(()=>module.exports(bad,page));++rejected;
  };
  reject(es=>es.forEach(e=>e.textureIndex=-1));
  reject(es=>es.forEach(e=>{if(e.textureIndex>=0)e.textureIndex=1-e.textureIndex;}));
  reject(es=>es.forEach(e=>e.uvScaleBias[2]+=.2));
  if(result.step===8||result.step===9) reject(es=>es.forEach(e=>e.uvScaleBias=[1,1,0,0]));
  return rejected;
};
