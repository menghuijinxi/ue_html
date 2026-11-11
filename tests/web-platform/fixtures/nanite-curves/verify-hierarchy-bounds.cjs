'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const file=path.join(__dirname,'verify-decode.cjs'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
m._compile(fs.readFileSync(file,'utf8').split('(async()=>{')[0]+'\nmodule.exports={decode,read};',file);
const {decode,read}=m.exports,results=[],groom=process.argv.includes('--groom'),root=path.join(__dirname,groom?'groom-gpu':'fixtures');
for(const name of fs.readdirSync(root)){
 const dir=path.join(root,name),pageFile=path.join(dir,'gpu-pages.bin');if(!fs.existsSync(pageFile))continue;
 const input=read(path.join(dir,'gpu-inputs.json')),data=fs.readFileSync(pageFile),hierarchy=fs.readFileSync(path.join(dir,'hierarchy.bin'));
 const states=fs.readFileSync(path.join(dir,'page-states.bin')),roots=fs.readFileSync(path.join(dir,'roots.bin'));
 const stream=input.fixture.streaming?fs.readFileSync(path.join(dir,'streaming.bin')):Buffer.alloc(0);
 assert.equal(hierarchy.length,input.fixture.hierarchyNodes*240);
 const node=(index,child)=>{
  assert(index<input.fixture.hierarchyNodes&&child<4);const at=index*240;
  const vec=offset=>[0,1,2].map(a=>hierarchy.readFloatLE(at+offset+child*16+a*4));
  return {center:vec(64),extent:vec(128),ref:hierarchy.readUInt32LE(at+128+child*16+12),
   range:hierarchy.readUInt32LE(at+192+child*12),count:(hierarchy.readUInt32LE(at+192+child*12+4)>>>16)&511};
 };
 const parents=new Map(),leaves=new Map();
 for(let n=0;n<input.fixture.hierarchyNodes;n++)for(let child=0;child<4;child++){
  const b=node(n,child);if(b.range===0xffffffff){
   assert(b.ref<input.fixture.hierarchyNodes);assert(!parents.has(b.ref),'Hierarchy must be a tree');parents.set(b.ref,{index:n,child});
  }
 }
 for(let page=0;page<input.fixture.pages;page++){
  const offset=states.readUInt32LE(page*20),size=states.readUInt32LE(page*20+4),bytes=states.readUInt32LE(page*20+8);
  const chunk=(page<input.fixture.rootPages?roots:stream).subarray(offset,offset+size-bytes);
  const groups=chunk.readUInt16LE(2),parts=chunk.readUInt16LE(4),parentCount=chunk.readUInt32LE(12),locations=chunk.readUInt32LE(16);
  const partBase=24+groups*16,locationBase=partBase+parts*12+parentCount*10;
  assert(locationBase+locations*4<=chunk.length);
  for(let part=0;part<parts;part++){
   const at=partBase+part*12,p=chunk.readUInt16LE(at),start=chunk[at+2],first=chunk.readUInt32LE(at+4),count=chunk.readUInt32LE(at+8);
   assert(p<input.fixture.pages&&first+count<=locations);
   for(let k=0;k<count;k++){
    const packed=chunk.readUInt32LE(locationBase+(first+k)*4),index=packed>>>2,child=packed&3,b=node(index,child);
    assert(b.range!==0xffffffff&&b.count>0);
    for(let c=start;c<start+b.count;c++){
     const key=p+':'+c,chain=leaves.get(key)||new Map();chain.set(index+':'+child,{index,child});leaves.set(key,chain);
    }
   }
  }
 }
 let tested=0,outside=0,maxOutside=0,clusters=0;const examples=[];
 const tolerance=Math.max(1e-4,2**-input.fixture.positionPrecision);
 for(const page of input.pages){
  const gpu=data.subarray(page.gpuOffset);
  for(let c=0;c<page.clusters;c++){
   const chains=leaves.get(page.page+':'+c);assert(chains?.size,'Every cluster must belong to a hierarchy leaf');clusters++;
   const bounds=new Map(chains);
   for(const leaf of chains.values()){
    let current=leaf.index;const visited=new Set();
    while(parents.has(current)){
     assert(!visited.has(current));visited.add(current);const parent=parents.get(current);
     bounds.set(parent.index+':'+parent.child,parent);current=parent.index;
    }
    assert.equal(current,input.fixture.rootNode,'Cluster must reach the resource root');
   }
   const meta=decode(gpu,c,0);
   for(let v=0;v<meta.vertices;v++){
    const point=decode(gpu,c,v);
    for(const ref of bounds.values()){
     const b=node(ref.index,ref.child);let distance=0;
     for(let a=0;a<3;a++)distance=Math.max(distance,Math.abs(point.p[a]-b.center[a])+
      point.radius*Math.sqrt(Math.max(0,1-point.normal[a]**2))-b.extent[a]);
     tested++;assert(Number.isFinite(distance));
     if(distance>tolerance){outside++;maxOutside=Math.max(maxOutside,distance);if(examples.length<3)examples.push({page:page.page,cluster:c,vertex:v,...ref,distance});}
    }
   }
  }
 }
 assert.equal(clusters,input.fixture.clusters);
 results.push({name,clusters,tested,outside,maxOutside,tolerance,examples,inputs:[pageFile,'hierarchy.bin','roots.bin','page-states.bin'].map(f=>audit(path.isAbsolute(f)?f:path.join(dir,f)))});
}
assert.equal(results.length,groom?4:29);const result={pass:results.every(r=>r.outside===0),source:audit(__filename),results};
fs.writeFileSync(path.join(__dirname,(groom?'groom-':'')+'hierarchy-bounds.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:result.pass,results:results.map(({inputs,examples,...r})=>r)},null,2));
if(!result.pass)process.exitCode=1;
