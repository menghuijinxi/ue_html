'use strict';
// Independent scalar reference for the authored spline surface. Inputs are
// native packed parameters; no Nanite visibility, barycentrics or deformed
// positions are used to construct reference geometry.
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize=a=>{const n=Math.hypot(...a);if(n<1e-20)throw new Error('Degenerate spline frame');return a.map(v=>v/n);};
const half=word=>{
  const sign=word&0x8000?-1:1,e=(word>>>10)&31,m=word&1023;
  return sign*(e===0?m*2**-24:e===31?(m?NaN:Infinity):(1+m/1024)*2**(e-15));
};
const pair=word=>[half(word&65535),half(word>>>16)];
const snorm=word=>(word&65535)/65535*2-1;
const asFloat=word=>new Float32Array(new Uint32Array([word]).buffer)[0];
function unpack(words){
  if(words.length!==28)throw new Error('Expected seven packed spline float4s');
  const f=words.map(asFloat),[x,y,z,w]=[snorm(words[26]),snorm(words[26]>>>16),snorm(words[27]),snorm(words[27]>>>16)];
  const rotation=[
    [1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y)],
    [2*(x*y-w*z),1-2*(x*x+z*z),2*(y*z+w*x)],
    [2*(x*z+w*y),2*(y*z-w*x),1-2*(x*x+y*y)]
  ];
  return {start:f.slice(0,3),end:f.slice(4,7),startTangent:f.slice(8,11),endTangent:[f[3],f[7],f[11]],
    startOffset:f.slice(12,14),endOffset:f.slice(14,16),roll:pair(words[16]),startScale:pair(words[17]),endScale:pair(words[18]),
    zScale:f[20],zOffset:f[21],deformScale:pair(words[22]),up:[snorm(words[24]),snorm(words[24]>>>16),snorm(words[25])],
    boundsScale:half((words[25]>>>16)&32767),smooth:!!(words[25]>>>31),dir:rotation[0],axisX:rotation[1],axisY:rotation[2]};
}
function slice(p,position){
  const t=dot(position,p.dir)*p.zScale+p.zOffset,t2=t*t,t3=t2*t;
  const center=p.start.map((v,j)=>(2*t3-3*t2+1)*v+(t3-2*t2+t)*p.startTangent[j]+
    (t3-t2)*p.endTangent[j]+(-2*t3+3*t2)*p.end[j]);
  const tangent=normalize(p.start.map((v,j)=>(6*t2-6*t)*v+(3*t2-4*t+1)*p.startTangent[j]+
    (3*t2-2*t)*p.endTangent[j]+(-6*t2+6*t)*p.end[j]));
  const baseX=normalize(cross(p.up,tangent)),baseY=cross(tangent,baseX);
  const clamped=Math.max(0,Math.min(1,t)),alpha=p.smooth?clamped*clamped*(3-2*clamped):t;
  const mix=(a,b)=>a+(b-a)*alpha,roll=mix(...p.roll),s=Math.sin(roll),c=Math.cos(roll);
  const x=baseX.map((v,j)=>c*v-s*baseY[j]),y=baseY.map((v,j)=>c*v+s*baseX[j]);
  const scale=p.startScale.map((v,j)=>mix(v,p.endScale[j])),offset=p.startOffset.map((v,j)=>mix(v,p.endOffset[j]));
  return {t,center:center.map((v,j)=>v+offset[0]*baseX[j]+offset[1]*baseY[j]),tangent,x,y,scale};
}
function deform(p,position,normal){
  const frame=slice(p,position),cx=dot(position,p.axisX)*frame.scale[0],cy=dot(position,p.axisY)*frame.scale[1];
  const result={position:frame.center.map((v,j)=>v+cx*frame.x[j]+cy*frame.y[j])};
  if(normal){
    const along=dot(normal,p.dir),nx=dot(normal,p.axisX)*(frame.scale[0]<0?-1:1),ny=dot(normal,p.axisY)*(frame.scale[1]<0?-1:1);
    result.normal=normalize(frame.tangent.map((v,j)=>along*v+nx*frame.x[j]+ny*frame.y[j]));
  }
  return result;
}
module.exports={unpack,slice,deform};
