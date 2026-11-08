'use strict';
const assert = require('node:assert/strict');
const transform = (p, m) => [0,1,2,3].map(c => p.reduce((s,v,r) => s+v*m[r*4+c], 0));
const distances = p => [p[3]+p[0],p[3]-p[0],p[3]+p[1],p[3]-p[1],p[2],p[3]-p[2]];
function clip(triangle) {
  let polygon = triangle;
  for (let plane = 0; plane < 6 && polygon.length; ++plane) {
    const next = [];
    for (let i = 0; i < polygon.length; ++i) {
      const a = polygon[i], b = polygon[(i+1)%polygon.length];
      const da = distances(a)[plane], db = distances(b)[plane];
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) next.push(a.map((v,k) => v+(b[k]-v)*da/(da-db)));
    }
    polygon = next;
  }
  return polygon;
}

// Independent source-mesh reference: no cull keys or Nanite page positions are
// used to generate expected coverage/depth. Quantization matches the cooked
// fixture's explicitly recorded position precision. Six-plane homogeneous
// clipping includes triangles crossing the eye/near plane.
module.exports = function verifyRaster(result, source, page, precision) {
  const {rasterWidth:width, rasterHeight:height, visibility:pixels, entries} = result;
  assert.equal(width,192); assert.equal(height,128); assert.equal(pixels.length,width*height*2);
  const rect = [7,5,185,123], depth = new Float64Array(width*height), owner = new Int32Array(width*height).fill(-1);
  const edge = new Uint8Array(width*height), scale = 2**precision;
  const rasterize = (tri, entryIndex) => {
    const p = tri.map(v => [rect[0]+(v[0]/v[3]+1)*.5*(rect[2]-rect[0]),
      rect[1]+(1-v[1]/v[3])*.5*(rect[3]-rect[1]),v[2]/v[3]]);
    // This Windows/Edge run uses D3D12's 8 fractional subpixel bits. Snapping
    // affects interpolation as well as coverage, especially orthographic depth.
    // https://learn.microsoft.com/en-us/windows/win32/direct3d12/constants
    p.forEach(v=>{v[0]=Math.round(v[0]*256)/256;v[1]=Math.round(v[1]*256)/256;});
    const cross = (a,b,x,y) => (b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);
    const area = cross(p[0],p[1],p[2][0],p[2][1]); if (Math.abs(area)<1e-12) return;
    const sign = Math.sign(area);
    const lens = [0,1,2].map(i => Math.hypot(p[(i+2)%3][0]-p[(i+1)%3][0],p[(i+2)%3][1]-p[(i+1)%3][1]));
    const minX = Math.max(rect[0],Math.floor(Math.min(...p.map(v=>v[0]))-.02));
    const maxX = Math.min(rect[2]-1,Math.ceil(Math.max(...p.map(v=>v[0]))+.02));
    const minY = Math.max(rect[1],Math.floor(Math.min(...p.map(v=>v[1]))-.02));
    const maxY = Math.min(rect[3]-1,Math.ceil(Math.max(...p.map(v=>v[1]))+.02));
    for(let y=minY;y<=maxY;++y) for(let x=minX;x<=maxX;++x) {
      const e=[0,1,2].map(i=>cross(p[(i+1)%3],p[(i+2)%3],x+.5,y+.5)*sign);
      const index=y*width+x;
      // Only a narrow 0.02-pixel edge band permits subpixel coverage differences.
      if(e.every((v,i)=>v>=-.02*lens[i]) && e.some((v,i)=>v<=.02*lens[i])) edge[index]=1;
      if(e.some(v=>v<0)) continue;
      const z=e.reduce((s,v,i)=>s+v*p[i][2],0)/Math.abs(area);
      if(owner[index]<0 || z>depth[index]+1e-12 || (Math.abs(z-depth[index])<=1e-12 &&
          entries[entryIndex].clusterBase>entries[owner[index]].clusterBase)) {
        depth[index]=z; owner[index]=entryIndex;
      }
    }
  };
  if(!result.invalidCullState) entries.forEach((entry,index) => {
    const m=[...Array(16)].map((_,i)=>Math.fround([0,1,2,3].reduce((s,k)=>
      s+entry.localToWorld[Math.floor(i/4)*4+k]*result.worldToClip[k*4+i%4],0)));
    for(let offset=0;offset<source.length;offset+=36) {
      const tri=[0,1,2].map(v=>transform([...Array(3)].map((_,c)=>Math.round(source.readFloatLE(offset+v*12+c*4)*scale)/scale).concat(1),m));
      const polygon=clip(tri);
      for(let i=1;i+1<polygon.length;++i) rasterize([polygon[0],polygon[i],polygon[i+1]],index);
    }
  });
  const floats=new Float32Array(1), bits=new Uint32Array(floats.buffer);
  let covered=0, referenceCovered=0, edgeDifferences=0, maxDepthError=0, depthChecked=0;
  const byComponent={};
  const clusterCount=page.readUInt32LE(0)&65535;
  for(let i=0;i<width*height;++i) {
    const id=pixels[i*2], zbits=pixels[i*2+1]; bits[0]=zbits; const z=floats[0];
    const expected=owner[i]>=0; if(expected) ++referenceCovered;
    if(!!id!==expected) {assert(edge[i],`coverage pixel ${i%width},${Math.floor(i/width)}: GPU ${id}, CPU ${owner[i]}`); ++edgeDifferences;}
    if(!id) {assert.equal(zbits,0,`empty pixel ${i}`); continue;}
    ++covered; assert(Number.isFinite(z)&&z>=0&&z<=1);
    const slot=(id>>>7)-1;
    const found=entries.findIndex(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.keys.length);
    assert(found>=0,`unknown visible slot ${slot}`);
    const entry=entries[found], local=slot-entry.clusterBase;
    assert(local<entry.state[0] && entry.state[1]===0);
    const cluster=entry.keys[local]&255, triangle=id&127;
    assert(cluster<clusterCount && triangle<(page.readUInt32LE(16+cluster*16+4)&255));
    byComponent[entry.component]=(byComponent[entry.component]||0)+1;
    if(expected && !edge[i]) {
      ++depthChecked;
      const error=Math.abs(z-depth[i]); maxDepthError=Math.max(maxDepthError,error);
      assert(error<3e-5,`depth pixel ${i}: GPU ${z}, CPU ${depth[i]}`);
      assert.equal(found,owner[i],`winning instance pixel ${i}`);
    }
  }
  assert(edgeDifferences<=Math.max(4,referenceCovered*.01),`too many edge differences: ${edgeDifferences}`);
  if([4,7,9].includes(result.step)||result.step>=14) assert.equal(covered,0);
  else {assert(covered>50,`step ${result.step} must draw geometry`); assert(depthChecked>covered*.25,'insufficient interior depth/owner checks');}
  if(result.step===11) assert.deepEqual(Object.keys(byComponent),['0'],'near instance must occlude far instance');
  if(result.step===12) assert.deepEqual(Object.keys(byComponent),[String(entries.reduce((a,b)=>a.clusterBase>b.clusterBase?a:b).component)]);
  return {pass:true, covered, referenceCovered, edgeDifferences, depthChecked, maxDepthError, byComponent};
};
