'use strict';
const assert=require('node:assert/strict');
const f16=b=>{const s=b&32768?-1:1,e=(b>>10)&31,m=b&1023;return s*(e===31?(m?NaN:Infinity):e?2**(e-15)*(1+m/1024):2**-14*m/1024);};
const transform=(p,m)=>[0,1,2].map(c=>[...p,1].reduce((s,v,r)=>s+v*m[r*4+c],0));

// Angular tangents and intersection with the near plane form an independent
// CPU reference for the shader's algebraic projected-sphere calculation.
function projected(bounds,mode,matrix,parameters) {
  if(mode===2)return [1,1];
  const [x,y,z]=transform(bounds.slice(0,3),matrix),r=bounds[3]*parameters[2],near=parameters[3];
  if(z+r<=near)return [0,0];
  const radial=Math.hypot(x,y),distance=Math.hypot(radial,z),inside=distance<r;
  const theta=Math.atan2(radial,z),alpha=Math.asin(Math.min(1,r/Math.max(distance,1e-30)));
  const tangentDistance=Math.sqrt(Math.max(0,distance*distance-r*r));
  let low=Math.cos(theta+alpha),high=Math.cos(theta-alpha);
  const intersection=Math.sqrt(Math.max(0,r*r-(near-z)**2));
  if(inside||low*tangentDistance<near)low=Math.cos(Math.atan2(radial+intersection,near));
  if(inside||high*tangentDistance<near)high=Math.cos(Math.atan2(Math.max(radial-intersection,0),near));
  if(r*r-radial*radial>=Math.max(near-z,0)**2)high=1;
  return [Math.max(z-r,near)*low,Math.max(z+r,near)*high];
}

function select(input,page,hierarchy,hierarchyOffset=0,pageIndex=0) {
  const n=page.readUInt32LE(0)&65535;assert.equal(n,15,'This oracle uses the single-node sphere fixture');
  const selected=[];
  for(let child=0;child<4;child++) {
    const at=hierarchyOffset+child*16,bounds=Array.from({length:4},(_,c)=>hierarchy.readFloatLE(at+c*4));
    const errors=hierarchy.readUInt32LE(at+64+12),min=f16(errors>>>16),max=f16(errors&65535);
    const first=hierarchy.readUInt32LE(at+128+12)&255;
    const children=(hierarchy.readUInt32LE(hierarchyOffset+192+child*12+4)>>>16)&511;
    const edge=projected(bounds,input.lodMode,input.localToView,input.lodParameters),scale=input.lodParameters[0]*input.lodParameters[1];
    if(edge[0]>scale*max||edge[1]<scale*min)continue;
    for(let cluster=first;cluster<first+children;cluster++) {
      const field=(v,c)=>16+(v*n+cluster)*16+c*4;
      const flags=page.readUInt32LE(field(4,3)),error=f16(page.readUInt32LE(field(3,3))&65535);
      const sphere=Array.from({length:4},(_,c)=>page.readFloatLE(field(2,c)));
      if(!(flags&2)&&projected(sphere,input.lodMode,input.localToView,input.lodParameters)[0]<=scale*error)continue;
      selected.push((pageIndex<<8)|cluster);
    }
  }
  return selected.sort((a,b)=>a-b);
}
module.exports={projected,select};
