'use strict';
const assert=require('node:assert/strict');
const {triangleMaterial}=require('./verify-nanite-material-inputs.cjs');

// Rebuild every expected tile from a full-resolution, pre-GBuffer visibility /
// scene-depth readback and independently decoded page material slots. No GPU
// compaction output supplies membership or expected draw counts.
module.exports=function verifyMaterialTiles(result,page) {
  const {rect,entries,materialTiles:bins,tilePixels:pixels,before}=result;
  const width=rect[2]-rect[0],height=rect[3]-rect[1],gx=Math.ceil(width/8),gy=Math.ceil(height/8);
  assert.equal(result.tilePixelCount,width*height);assert.equal(pixels.length%4,0);
  const bindings=entries.flatMap((e,index)=>e.bindingCurrent?(e.materials||[{slot:e.materialSlot}]).map(m=>({entry:index,slot:m.slot})):[]);
  const expected=new Map(bindings.map(b=>[b.entry+'/'+b.slot,new Set()])),cache=new Map(),lookup=new Map();
  let occluded=0,unbound=0,owned=0,last=-1;
  for(let i=0;i<pixels.length;i+=4) {
    const [pixel,id,depth,sceneDepth]=pixels.slice(i,i+4);
    assert(Number.isInteger(pixel)&&pixel>last&&pixel<width*height);last=pixel;assert(id!==0);
    lookup.set(pixel,[id,depth,sceneDepth]);
    const slot=(id>>>8)-1,entryIndex=entries.findIndex(e=>slot>=e.clusterBase&&slot<e.clusterBase+e.state[0]);
    assert(entryIndex>=0);const entry=entries[entryIndex],key=entry.keys[slot-entry.clusterBase],tri=id&255;
    const k=(key&255)*128+tri;
    if(!cache.has(k)) cache.set(k,triangleMaterial(page,key&255,tri));
    if(depth!==sceneDepth) {++occluded;continue;}
    const tiles=expected.get(entryIndex+'/'+cache.get(k));
    if(!tiles) {++unbound;continue;}
    ++owned;tiles.add(Math.floor(pixel/width/8)*gx+Math.floor((pixel%width)/8));
  }
  // Cross-check sparse omission and the independent sampled snapshot.
  for(let y=0;y<result.materialHeight;++y) for(let x=0;x<result.materialWidth;++x) {
    const pixel=y*result.materialStride*width+x*result.materialStride,offset=(y*result.materialWidth+x)*28;
    const full=lookup.get(pixel);
    if(before[offset]) assert.deepEqual(full,before.slice(offset,offset+3));
    else assert.equal(full,undefined);
  }
  assert.deepEqual(bins.map(b=>b.entry+'/'+b.slot).sort(),bindings.map(b=>b.entry+'/'+b.slot).sort());
  let tileCount=0,emptyBins=0,edgeTiles=0;
  for(const bin of bins) {
    assert.equal(bin.gridWidth,gx);assert.equal(bin.gridHeight,gy);
    assert.equal(bin.tiles.length,gx*gy*2);
    const expectedTiles=[...expected.get(bin.entry+'/'+bin.slot)].sort((a,b)=>a-b),count=expectedTiles.length;
    assert.deepEqual(bin.arguments,[6,count,0,0],'GPU-generated draw arguments');
    const actual=[];
    for(let i=0;i<count;++i) {
      const x=bin.tiles[i*2],y=bin.tiles[i*2+1];assert(x<gx&&y<gy);actual.push(y*gx+x);
      if((width%8&&x===gx-1)||(height%8&&y===gy-1)) ++edgeTiles;
    }
    assert.deepEqual(actual.sort((a,b)=>a-b),expectedTiles,'exact compacted tile membership');
    assert(bin.tiles.slice(count*2).every(v=>v===0),'unused tile capacity must remain clear');
    tileCount+=count;if(!count)++emptyBins;
  }
  if(result.step===1) assert.equal(result.tileInputRejections,8);
  if(result.step===4) assert.equal(bins.length,0);
  if(result.step===5) assert.equal(emptyBins,1);
  if(result.step===11) {assert.equal(tileCount,0);assert.equal(emptyBins,2);assert(occluded>1000);}
  if(result.step===12) {assert(width%8||height%8);assert(edgeTiles>0);}
  if(![4,11,19].includes(result.step)) {assert(tileCount>0);assert(tileCount<gx*gy*bins.length/4);}
  if(result.step===19)assert.equal(bins.length,0);
  if(result.step>=13&&result.step<=18) {
    assert.equal(bins.length,({13:8,14:8,15:6,16:6,17:3,18:1})[result.step]);
    assert.equal(emptyBins,0);
  }
  let offsetValidation;
  if(result.step===12) {
    const offsetRect=bins[0].offsetRect;assert(offsetRect[0]>rect[0]&&offsetRect[1]>rect[1]);
    const ow=offsetRect[2]-offsetRect[0],oh=offsetRect[3]-offsetRect[1],cropped=[];
    for(let i=0;i<pixels.length;i+=4) {
      const p=pixels[i],x=p%width+rect[0],y=Math.floor(p/width)+rect[1];
      if(x>=offsetRect[0]&&x<offsetRect[2]&&y>=offsetRect[1]&&y<offsetRect[3])
        cropped.push((y-offsetRect[1])*ow+x-offsetRect[0],...pixels.slice(i+1,i+4));
    }
    offsetValidation=module.exports({...result,step:0,rect:offsetRect,tilePixelCount:ow*oh,tilePixels:cropped,
      materialWidth:0,materialHeight:0,materialTiles:bins.map(b=>{
        assert.deepEqual(b.offsetRect,offsetRect);
        return {...b,gridWidth:Math.ceil(ow/8),gridHeight:Math.ceil(oh/8),tiles:b.offsetTiles,arguments:b.offsetArguments};
      })},page);
    assert(offsetValidation.edgeTiles>0);
  }
  return {pass:true,pixels:width*height,nanitePixels:pixels.length/4,owned,occluded,unbound,bins:bins.length,
    tileCount,emptyBins,edgeTiles,fullScreenTiles:gx*gy*bins.length,indirectVertices:tileCount*6,...(offsetValidation?{offsetValidation}: {})};
};
