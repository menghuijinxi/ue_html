'use strict';
const assert=require('node:assert/strict');
const {decodeTriangle}=require('./verify-nanite-material-inputs.cjs');
const {attachment,fixture}=require('./probe-nanite-assembly.cjs');
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0];
const mul=(v,m)=>[0,1,2,3].map(c=>v.reduce((s,x,r)=>s+x*m[r*4+c],0));
function depthInterval(vertices,px,py){
 let min=Infinity,max=-Infinity;
 const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
 for(const a of vertices[0].choices)for(const b of vertices[1].choices)for(const c of vertices[2].choices){
  const area=cross(a,b,c.x,c.y);if(Math.abs(area)<1e-9)continue;
  const weights=[cross(b,c,px,py),cross(c,a,px,py),cross(a,b,px,py)].map(v=>v/area);
  if(weights.some(v=>v<0))continue;const depth=weights.reduce((s,v,j)=>s+v*vertices[j].z,0);
  min=Math.min(min,depth);max=Math.max(max,depth);
 }
 assert(Number.isFinite(min)&&Number.isFinite(max),'selected raster interval');return {min,max};
}

function reference(t){
 const records=Buffer.from(t.visibleRecords,'base64'),stream=Buffer.from(t.streamPages,'base64'),roots=Buffer.from(t.rootPagesData,'base64');
 assert.equal(records.length,t.recordBytes);assert.equal(stream.length,t.streamBytes);assert.equal(roots.length,t.rootBytes);
 assert.equal(t.assemblyCount,4);assert.equal(t.cullState[1],0);
 const pixels=Array(t.width*t.height).fill(null);let triangles=0,mergedTriangles=0,partTriangles=0;
 // The fixture camera is authored at this origin (step 7 moves it back).
 // Cancel its large translation before reproducing the GPU float operations.
 const camera=[t.step===7?99000:100000,0,100000];
 const translated=t.localToWorld.map(Math.fround),projection=t.worldToClip.map(Math.fround);
 for(let j=0;j<3;j++)translated[12+j]=Math.fround(t.localToWorld[12+j]-camera[j]);
 for(let j=0;j<4;j++)projection[12+j]=Math.fround(t.worldToClip[12+j]+camera.reduce((s,x,k)=>s+x*t.worldToClip[k*4+j],0));
 const cross=(a,b,x,y)=>(b.x-a.x)*(y-a.y)-(b.y-a.y)*(x-a.x);
 for(let slot=0;slot<t.cullState[0];slot++){
  const raw=records.readBigUInt64LE(slot*12),pool=Number(raw>>41n),limit=t.poolPages*256;
  const instance=Number((raw>>17n)&0xffffffn);
  const page=pool<limit?pool>>>8:t.poolPages+((pool-limit)>>>6),cluster=pool<limit?pool&255:(pool-limit)&63;
  assert(page<t.poolPages?t.owners[page]===t.firstRoot:page>=t.firstRoot&&page<t.firstRoot+t.rootPages,'selected assembly page ownership');
  const data=page<t.poolPages?stream.subarray(page*131072,(page+1)*131072):roots.subarray((page-t.firstRoot)*32768,(page-t.firstRoot+1)*32768);
  const count=data.readUInt32LE(0)&65535;assert(cluster<count);
  const numTris=data.readUInt32LE(16+cluster*16+4)&255;
  const assembly=records.readUInt32LE(slot*12+8)&0xffffff;
  assert(assembly===0xffffff||assembly<12&&assembly%3===0,'selected assembly triplet index');
  const transform=assembly===0xffffff?null:attachment(fixture.instances[assembly/3],t.bones,true);
  if(transform)partTriangles+=numTris;else mergedTriangles+=numTris;
  for(let tri=0;tri<numTris;tri++){
   const decoded=decodeTriangle(data,cluster,tri);triangles++;
   const v=decoded.vertices.map(vertex=>{
    const f=Math.fround,p=[0,0,0];
    if(transform)p.splice(0,3,...mul([...vertex.position,1],transform).slice(0,3));
    else if(!t.skinning)p.splice(0,3,...vertex.position);
    else {
     assert(vertex.influences.length>0&&vertex.influences.every(i=>i.bone<2),'selected cooked skin bindings');
     for(const influence of vertex.influences){const m=t.bones[influence.bone].map(f);
      for(let j=0;j<3;j++){
       const q=f(f(f(f(vertex.position[0]*m[j])+f(vertex.position[1]*m[4+j]))+f(vertex.position[2]*m[8+j]))+m[12+j]);
       p[j]=f(p[j]+f(q*influence.weight));
      }
     }
    }
    const delta=[40,25,15,0].map((x,j)=>f(x*(vertex.color[j]??0)));
    const relative=mul([...p,1],translated).map(f).map((value,j)=>f(value+delta[j]));
    const clip=mul(relative,projection).map(f);assert(clip[3]>0);
    const unit=2**-24,gamma=8*unit/(1-8*unit),local=[...p,1];
    const relativeError=[0,1,2].map(c=>gamma*(local.reduce((s,x,r)=>s+Math.abs(x*translated[r*4+c]),0)+Math.abs(delta[c])));
    const clipError=[0,1,2,3].map(c=>gamma*relative.reduce((s,x,r)=>s+Math.abs(x*projection[r*4+c]),0)+
     relativeError.reduce((s,x,r)=>s+x*Math.abs(projection[r*4+c]),0));
    const screen=[(clip[0]/clip[3]+1)*t.viewWidth/2,(1-clip[1]/clip[3])*t.viewHeight/2];
    const axes=screen.map((value,c)=>{
     const half=(c?t.viewHeight:t.viewWidth)/2,w=clip[3],ew=clipError[3];
     const error=half*(clipError[c]*w+Math.abs(clip[c])*ew)/(w*(w-ew))+unit*(Math.abs(value)+half);
     const lo=Math.round((value-error)*256),hi=Math.round((value+error)*256);
     assert(hi-lo<=1,'selected raster uncertainty must stay at adjacent subpixel positions');
     return lo===hi?[lo/256]:[lo/256,hi/256];
    });
    return {x:Math.round((clip[0]/clip[3]+1)*t.viewWidth/2*256)/256,
     y:Math.round((1-clip[1]/clip[3])*t.viewHeight/2*256)/256,z:clip[2]/clip[3],choices:axes[0].flatMap(x=>axes[1].map(y=>({x,y})))};
   });
   const area=cross(v[0],v[1],v[2].x,v[2].y);if(Math.abs(area)<1e-9)continue;
   const xmin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.x))-.51)/8)),xmax=Math.min(t.width-1,Math.floor((Math.max(...v.map(a=>a.x))-.49)/8));
   const ymin=Math.max(0,Math.ceil((Math.min(...v.map(a=>a.y))-.51)/8)),ymax=Math.min(t.height-1,Math.floor((Math.max(...v.map(a=>a.y))-.49)/8));
   for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
    const w=[cross(v[1],v[2],x*8+.5,y*8+.5),cross(v[2],v[0],x*8+.5,y*8+.5),cross(v[0],v[1],x*8+.5,y*8+.5)].map(a=>a/area);
    if(w.some(a=>a<0))continue;const depth=w.reduce((s,a,j)=>s+a*v[j].z,0),i=y*t.width+x;
    if(depth<0||depth>1)continue;
    if(!pixels[i]||depth>pixels[i].depth)pixels[i]={slot,tri,instance,depth,vertices:v};
   }
  }
 }
 assert.equal(triangles,t.cullState[3],'selected triangle accounting');
 return {pixels,triangles,mergedTriangles,partTriangles};
}

function verify(t){
 const expected=reference(t);let covered=0,missingCore=0,extraCore=0,maxDepthResidual=0,maxDepthError=0,subpixelChecks=0,maxDepthIntervalWidth=0;
 for(let i=0;i<expected.pixels.length;i++){
  const ref=expected.pixels[i],p=i*12,actual=!!t.pixels[p];
  if(ref&&!actual)missingCore++;if(actual&&!ref)extraCore++;
  if(ref&&actual){
   covered++;assert.equal(t.pixels[p+8],ref.instance,'selected assembly instance');
   const depth=float(t.pixels[p+1]);let residual=Math.abs(depth-ref.depth);maxDepthError=Math.max(maxDepthError,residual);
   if(residual>=1e-7){
    const interval=depthInterval(ref.vertices,(i%t.width)*8+.5,Math.floor(i/t.width)*8+.5);
    residual=Math.max(0,interval.min-depth,depth-interval.max);subpixelChecks++;
    maxDepthIntervalWidth=Math.max(maxDepthIntervalWidth,interval.max-interval.min);
   }
   maxDepthResidual=Math.max(maxDepthResidual,residual);
   assert(residual<1e-7,`selected assembly depth: step ${t.step}, pixel ${i}, error ${residual}, expected ${ref.depth}, actual ${float(t.pixels[p+1])}`);
   assert.equal(t.pixels[p+1],t.pixels[p+10],'selected assembly scene depth');assert(t.pixels[p+2]&1);
  }
 }
 assert.equal(missingCore,0,'selected assembly geometry must not lose coverage');
 assert.equal(extraCore,0,'selected assembly geometry must not add coverage');assert(covered>100);
 return {covered,missingCore,extraCore,maxDepthResidual,maxRasterDepthError:maxDepthError,subpixelChecks,maxDepthIntervalWidth,
  triangles:expected.triangles,mergedTriangles:expected.mergedTriangles,partTriangles:expected.partTriangles};
}

function compare(full,test,budget){
 assert.equal(test.width,full.width);assert.equal(test.height,full.height);
 const selected=verify(test);let referenceCovered=0,differentCoverage=0,maxDepthError=0;
 for(let p=0;p<test.pixels.length;p+=12){
  const a=!!full.pixels[p],b=!!test.pixels[p];if(a)referenceCovered++;if(a!==b)differentCoverage++;
  if(a&&b){
   maxDepthError=Math.max(maxDepthError,Math.abs(float(full.pixels[p+1])-float(test.pixels[p+1])));
   assert.equal(test.pixels[p+3],full.pixels[p+3],'assembly budget stencil');
   assert.equal(test.pixels[p+11],full.pixels[p+11],'assembly budget lighting channels');
  }
 }
 // Native coarse assembly clusters bake parts into ordinary skin bindings.
 // Blended attachment matrices use Gram-Schmidt at the detailed part level,
 // while merged clusters use linear vertex skinning. Thus even a silhouette
 // can move by more than one sample under a constrained page pool. Validate
 // every selected triangle independently above; retain the full-detail error
 // here rather than treating a different native representation as a hole.
 const streamingPages=test.totalPages-test.rootPages;assert(streamingPages>0);
 if(budget>=streamingPages){
  assert.equal(differentCoverage,0);assert.equal(maxDepthError,0);assert.equal(test.residentClusters,test.totalClusters);
 }
 return {...selected,referenceCovered,differentCoverage,maxDepthError};
}
module.exports={reference,verify,compare};
