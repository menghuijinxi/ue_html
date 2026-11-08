'use strict';
const assert = require('node:assert/strict');
const normalize = v => {const length=Math.hypot(...v);assert(length>0);return v.map(x=>x/length);};
const transform = (p,m) => [0,1,2,3].map(c=>p.reduce((s,v,r)=>s+v*m[r*4+c],0));
const floatBits = new DataView(new ArrayBuffer(4));
const asFloat = bits => {floatBits.setUint32(0,bits,true);return floatBits.getFloat32(0,true);};

// CPU decoder of the serialized GPU page. No GPU-decoded attributes are used
// as expected values. The separate raster oracle still compares coverage and
// depth to the original, non-Nanite source mesh.
function triangle(page, cluster, tri) {
  const count=page.readUInt32LE(0)&65535;
  assert(cluster<count);
  const word=(v,c)=>page.readUInt32LE(16+(v*count+cluster)*16+c*4);
  const extract=(x,n,offset)=>Math.floor(x/2**offset)%2**n;
  const readBits=(byte,bit,n)=>{
    let value=0;
    for(let i=0;i<n;++i) value+=(page[byte+((bit+i)>>3)]>>((bit+i)&7)&1)*2**i;
    assert(byte+Math.ceil((bit+n)/8)<=page.length); return value;
  };
  const indexBits=(word(1,3)&7)+1, bitsPerTriangle=indexBits+10;
  assert(tri<(word(0,1)&255));
  const indexOffset=word(0,1)>>>8, base=readBits(indexOffset,tri*bitsPerTriangle,indexBits);
  const indices=[base,base+readBits(indexOffset,tri*bitsPerTriangle+indexBits,5),
    base+readBits(indexOffset,tri*bitsPerTriangle+indexBits+5,5)];
  const posBits=[9,14,19].map(n=>extract(word(1,3),5,n));
  const precision=extract(word(1,3),6,3)-20;
  const start=[0,1,2].map(i=>word(1,i)|0), positionOffset=word(0,0)>>>14;
  const attrOffset=extract(word(5,0),22,0), attrBits=word(5,0)>>>22;
  const normalBits=extract(word(1,3),4,24), tangentBits=extract(word(1,3),4,28);
  const hasTangents=extract(word(5,1),1,22), numUVs=extract(word(5,1),3,24);
  const decodeInfo=extract(word(5,1),22,0), colorBits=[0,4,8,12].map(n=>extract(word(0,3),4,n));
  const colorMin=[0,8,16,24].map(n=>extract(word(0,2),8,n));
  const decodeUV = encoded => {
    const mask=2**19-1, negative=encoded<=mask;
    const value=asFloat((0x3f000000+((negative?~encoded:encoded)&mask)*512)>>>0);
    return Math.min(value*2-1,value)*(negative?-1:1);
  };
  const vertices=indices.map(index=>{
    assert(index<(word(0,0)&16383));
    let bit=index*posBits.reduce((a,b)=>a+b,0);
    const position=posBits.map((n,i)=>{const v=(readBits(positionOffset,bit,n)+start[i])*2**-precision;bit+=n;return v;});
    bit=index*attrBits;
    const oct=[0,1].map(()=>{const v=readBits(attrOffset,bit,normalBits)*2/(2**normalBits-1)-1;bit+=normalBits;return v;});
    let normal=[...oct,1-Math.abs(oct[0])-Math.abs(oct[1])];
    const t=Math.min(1,Math.max(0,-normal[2]));
    normal[0]+=normal[0]>=0?-t:t;normal[1]+=normal[1]>=0?-t:t;normal=normalize(normal);
    if(hasTangents) bit+=tangentBits+1;
    const color=colorBits.map((n,i)=>{const v=(readBits(attrOffset,bit,n)+colorMin[i])/255;bit+=n;return v;});
    const uv=[0,1].map(i=>{
      if(!numUVs) return 0;
      const header=page.readUInt32LE(decodeInfo+i*4), n=header&31;
      const value=decodeUV((header>>>5)+readBits(attrOffset,bit,n));bit+=n;return value;
    });
    return {position,normal,color,uv};
  });
  const encoding=word(5,3);let material=0xffffffff;
  if(encoding<0xfe000000) {
    const len0=extract(encoding,7,18)+1, len1=extract(encoding,7,25);
    material=extract(encoding,6,tri<len0?0:tri<len0+len1?6:12);
  } else {
    const offset=extract(encoding,19,0)*4, ranges=extract(encoding,6,19)+1;
    for(let i=0;i<ranges;++i) {const range=page.readUInt32LE(offset+i*4);
      if(tri>=(range&255)&&tri<(range&255)+extract(range,8,8)) {material=extract(range,6,16);break;}}
  }
  assert(material<64); return {vertices,material};
}

module.exports = function verifyMaterialInputs(result, page, tolerances = {position:.0003,normal:.00001,uv:.000004,color:.000001}) {
  const {entries,visibleRecords:records,materialInputs:inputs,materialWidth:width,materialHeight:height}=result;
  const rect=result.rect||[7,5,185,123],stride=result.materialStride;
  assert(stride>0);assert.equal(width,Math.ceil((rect[2]-rect[0])/stride));assert.equal(height,Math.ceil((rect[3]-rect[1])/stride));
  assert.equal(inputs.length,width*height*16);
  const capacity=entries.reduce((n,e)=>n+e.keys.length,0);
  assert.equal(records.length,Math.max(capacity,1)*2);
  let validRecords=0;
  for(const entry of entries) {
    assert(Number.isInteger(entry.instanceId)&&entry.instanceId>=0&&entry.instanceId<2**24);
    for(let slot=0;slot<entry.keys.length;++slot) {
      const offset=(entry.clusterBase+slot)*2;
      const raw=BigInt(records[offset])|(BigInt(records[offset+1])<<32n);
      if(result.invalidCullState||slot>=entry.state[0]) {assert.equal(raw,0n);continue;}
      // Fields cross dword boundaries: flags 5, view 12, instance 24, pool 23.
      // Root pool references use 6 cluster bits, whereas cull keys use 8.
      const pool=Number(raw>>41n), key=entry.keys[slot];
      assert.equal(Number(raw&31n),2);assert.equal(Number((raw>>5n)&4095n),0);
      assert.equal(Number((raw>>17n)&0xffffffn),entry.instanceId);
      assert.equal(pool>>>6,key>>>8);assert.equal(pool&63,key&255);++validRecords;
    }
  }
  if(!capacity) assert(records.every(v=>v===0));
  if(entries.length>1) assert.notEqual(entries[0].instanceId,entries[1].instanceId);
  let covered=0, empty=0;const maxError={position:0,normal:0,uv:0,color:0};
  const materialSlots=new Set(), cache=new Map();
  for(let y=0;y<height;++y) for(let x=0;x<width;++x) {
    const offset=(y*width+x)*16, px=rect[0]+x*stride, py=rect[1]+y*stride;
    const id=result.sampledVisibility ? result.sampledVisibility[y*width+x] : result.visibility[(py*result.rasterWidth+px)*2];
    assert.equal(inputs[offset],id,`material and raster ID at ${x},${y}`);
    if(!id) {assert(inputs.slice(offset,offset+16).every(v=>v===0));++empty;continue;}
    ++covered;
    const slot=(id>>>8)-1, entry=entries.find(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);
    assert(entry); assert.equal(inputs[offset+1],entry.instanceId); assert.equal(inputs[offset+3],0);
    const key=entry.keys[slot-entry.clusterBase], tri=id&255, cacheKey=(key&255)*128+tri;
    if(!cache.has(cacheKey)) cache.set(cacheKey,triangle(page,key&255,tri));
    const decoded=cache.get(cacheKey);assert.equal(inputs[offset+2],decoded.material);materialSlots.add(decoded.material);
    const m=Array.from({length:16},(_,i)=>Math.fround([0,1,2,3].reduce((s,k)=>s+
      entry.localToWorld[Math.floor(i/4)*4+k]*result.worldToClip[k*4+i%4],0)));
    const clip=decoded.vertices.map(v=>transform([...v.position,1],m));
    const ndc=[(px+.5-rect[0])/(rect[2]-rect[0])*2-1,1-(py+.5-rect[1])/(rect[3]-rect[1])*2];
    // Solve homogeneous projected triangle coordinates in double precision;
    // this is independent of the shader's reciprocal-W edge-function formula.
    const a=clip.map(v=>v[0]-ndc[0]*v[3]), b=clip.map(v=>v[1]-ndc[1]*v[3]);
    const weights=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const sum=weights.reduce((s,v)=>s+v,0);assert(Math.abs(sum)>1e-15);
    const bary=weights.map(v=>v/sum);
    for(const [name,channels] of [['position',[4,5,6]],['normal',[8,9,10]],['uv',[7,11]],['color',[12,13,14,15]]]) {
      let expected=channels.map((_,c)=>decoded.vertices.reduce((s,v,i)=>s+v[name][c]*bary[i],0));
      if(name==='normal') expected=normalize(expected);
      channels.forEach((c,i)=>{
        const actual=asFloat(inputs[offset+c]), error=Math.abs(actual-expected[i]);
        assert(Number.isFinite(actual));maxError[name]=Math.max(maxError[name],error);
        assert(error<tolerances[name],`step ${result.step}, ${x},${y} ${name}[${i}]: GPU ${actual}, CPU ${expected[i]}`);
      });
    }
  }
  // The camera-inside/near-plane case may cover every sample in the viewport.
  if(result.raster?.covered>50) assert(covered>0);
  if(result.step===1&&!result.rect) assert.equal(result.materialInputRejections,7);
  return {pass:true,validRecords,covered,empty,maxError,materialSlots:[...materialSlots].sort()};
};
