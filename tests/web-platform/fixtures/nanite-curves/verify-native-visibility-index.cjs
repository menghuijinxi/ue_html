'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const source=path.resolve(__dirname,'failure-native-curves/NaniteRasterizer.usf');
const sourceText=fs.readFileSync(source,'utf8');
const fixed=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/NaniteRasterizer.usf');
assert(fs.readFileSync(fixed,'utf8').includes('const uint SourceVertIndex = PointIt;'));
assert(sourceText.includes('const uint PointIt = GroupThreadIndex + LoopIt * ThreadGroupSize;'));
assert(sourceText.includes('const uint CurveIt = PointIt / NumPointPerCurve;'));
assert(sourceText.includes('const uint SourceVertIndex = min(CurveIt*NumPointPerCurve + PointIt, NANITE_MAX_CLUSTER_TRIANGLES /*127u*/);'));
const definitions=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Shared/NaniteDefinitions.h');
assert.match(fs.readFileSync(definitions,'utf8'),/#define NANITE_MAX_CLUSTER_TRIANGLES_BITS\s+7/);
const decoder=path.resolve(__dirname,'../../../../reference-engine/Engine/Shaders/Private/Nanite/NaniteDataDecode.ush');
const decoderText=fs.readFileSync(decoder,'utf8');
assert(decoderText.includes('Out.x = TriIndex;')&&decoderText.includes('Out.y = TriIndex + 1;')&&decoderText.includes('OutTriIndex = Unpacked & 0xFF;'));
const fixtures=[];
for(const name of fs.readdirSync(path.join(__dirname,'fixtures'))){
 const dir=path.join(__dirname,'fixtures',name),file=path.join(dir,'gpu-inputs.json');if(!fs.existsSync(file))continue;
 const input=JSON.parse(fs.readFileSync(file)),data=fs.readFileSync(path.join(dir,'pages.bin'));let segments=0,wrongSegment=0,clamped=0,boundaryOrOutOfRange=0,aliasCount=0;const examples=[];
 for(const page of input.pages)for(let c=0;c<page.clusters;c++){
  // Disk raw data contains the GPU page header before the cluster SOA.
  const base=page.sourceOffset+20+page.clusters*40+16;
  const word=(row,col)=>data.readUInt32LE(base+(row*page.clusters+c)*16+col*4);
  const verts=word(0,0)&16383,curves=word(6,2)&255,points=(word(6,2)>>>8&255)||256;
  assert(curves>0&&points>=2&&points<=256);assert.equal(points,input.fixture.pointsPerCurve);assert.equal(verts,curves*points);
  const ids=new Set();
  for(let point=0;point<verts;point++){
   if(point%points===points-1)continue;const curve=Math.floor(point/points);
   const id=Math.min(curve*points+point,128);segments++;
   if(id!==point){wrongSegment++;if(examples.length<3)examples.push({page:page.page,cluster:c,curves,points,point,encoded:id});}
   if(curve*points+point>128)clamped++;
   if(id+1>=verts||id%points===points-1)boundaryOrOutOfRange++;
   if(ids.has(id))aliasCount++;ids.add(id);
   // The intended identity is the first point of this valid segment. All
   // segment starts fit the native visibility record's existing eight bits.
   const corrected=point&255;assert.equal(corrected,point);assert(corrected+1<verts&&corrected%points<points-1);
  }
 }
 assert(wrongSegment>0&&clamped>0&&aliasCount>0);
 fixtures.push({name,segments,wrongSegment,clamped,boundaryOrOutOfRange,aliasCount,examples,input:audit(file),pageData:audit(path.join(dir,'pages.bin'))});
}
assert.equal(fixtures.length,29);
const result={pass:true,diagnosis:'Native curve raster computes a global point index, adds its curve offset again, then clamps to the triangle capacity. The native decoder interprets the visibility ID as the unmodified global segment start. Real encoded curve clusters demonstrate wrong-segment IDs and aliases.',sources:[source,fixed,definitions,decoder,__filename].map(audit),fixtures};
fs.writeFileSync(path.join(__dirname,'native-visibility-index.json'),JSON.stringify(result,null,2)+'\n');
console.log({pass:true,fixtures:fixtures.length,segments:fixtures.reduce((n,r)=>n+r.segments,0),wrongSegment:fixtures.reduce((n,r)=>n+r.wrongSegment,0),aliases:fixtures.reduce((n,r)=>n+r.aliasCount,0)});
