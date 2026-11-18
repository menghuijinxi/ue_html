'use strict';
const assert=require('node:assert/strict');
const asFloat=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
module.exports=function compare(reference,test,budget){
 assert.equal(test.width,reference.width);assert.equal(test.height,reference.height);
 const {width,height}=test,coveredAt=(image,x,y)=>x>=0&&y>=0&&x<width&&y<height&&!!image.pixels[(y*width+x)*12];
 const interior=(image,x,y)=>coveredAt(image,x,y)&&[[0,-1],[0,1],[-1,0],[1,0]].every(([dx,dy])=>coveredAt(image,x+dx,y+dy));
 let covered=0,referenceCovered=0,core=0,missingCore=0,extraCore=0,differentCoverage=0,maxDepthError=0,outsideEnvelope=0;
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){
  const i=(y*width+x)*12,a=coveredAt(reference,x,y),b=coveredAt(test,x,y);
  if(a)referenceCovered++;if(b)covered++;
  if(interior(reference,x,y)){core++;if(!b)missingCore++;}
  if(!a&&interior(test,x,y))extraCore++;
  if(a!==b){
   differentCoverage++;const opposite=a?test:reference;let nearby=false;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)nearby ||= coveredAt(opposite,x+dx,y+dy);
   if(!nearby)outsideEnvelope++;
  }
  if(a&&b){maxDepthError=Math.max(maxDepthError,Math.abs(asFloat(reference.pixels[i+1])-asFloat(test.pixels[i+1])));
   assert.equal(test.pixels[i+3],reference.pixels[i+3],'shading mask');assert.equal(test.pixels[i+11],reference.pixels[i+11],'stencil');}
 }
 // A finite page pool can select a coarser native surface. Its silhouette may
 // move by one sampling cell, independently of perimeter length/resolution.
 // Interior holes, added interior regions and remote islands remain errors.
 assert(referenceCovered>100);assert(core>referenceCovered*.75);
 assert.equal(missingCore,0,'undersized page pools must retain closed parent geometry');
 assert.equal(extraCore,0,'coarse geometry must not add an interior region');
 assert.equal(outsideEnvelope,0,'coarse silhouette must stay within one sampling cell');
 assert(maxDepthError<.002,'coarse surface must remain close to resident geometry');
 const streamingPages=test.totalPages-test.rootPages;assert(streamingPages>0);
 if(budget>=streamingPages){assert.equal(differentCoverage,0);assert.equal(maxDepthError,0);assert.equal(test.residentClusters,test.totalClusters);}
 return {covered,referenceCovered,core,missingCore,extraCore,differentCoverage,outsideEnvelope,maxSilhouetteDistance:differentCoverage?1:0,maxDepthError};
};
