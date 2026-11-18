'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const groom=process.argv.includes('--groom'),root=path.join(__dirname,groom?'groom-gpu':'fixtures'),fixtures=[];
for(const name of fs.readdirSync(root)){
 const dir=path.join(root,name),json=path.join(dir,'fixture.json');if(!fs.existsSync(json))continue;
 const fixture=JSON.parse(fs.readFileSync(json)),states=fs.readFileSync(path.join(dir,'page-states.bin'));
 const roots=fs.readFileSync(path.join(dir,'roots.bin')),streaming=fixture.streaming?fs.readFileSync(path.join(dir,'streaming.bin')):Buffer.alloc(0);
 const rawDependencies=fs.readFileSync(path.join(dir,'page-dependencies.bin'));
 const streamPages=fixture.pages-fixture.rootPages;
 assert.equal(fixture.pageStateStride,20);assert.equal(fixture.dependencyStride,2);assert.equal(states.length,fixture.pages*20);
 const gpuIndex=p=>p<fixture.rootPages?streamPages+p:p-fixture.rootPages;
 const gpuOffset=p=>p<streamPages?p*131072:streamPages*131072+(p-streamPages)*32768;
 const chunks=[],pages=[],dependencies=[],installs=[];let sourceOffset=0;
 for(let p=0;p<fixture.pages;p++){
  const s=p*20,offset=states.readUInt32LE(s),size=states.readUInt32LE(s+4),bytes=states.readUInt32LE(s+8);
  const start=states.readUInt32LE(s+12),count=states.readUInt16LE(s+16),flags=states[s+19];
  const bulk=p<fixture.rootPages?roots:streaming,fixup=size-bytes;assert(offset+size<=bulk.length&&fixup>=24);
  const data=bulk.subarray(offset+fixup,offset+size),clusters=data.readUInt32LE(0);
  assert.equal(clusters,bulk.readUInt16LE(offset+6));assert(clusters>0&&clusters<=256);
  // Validate the builder's actual packed count before any GPU work. An authored
  // 256-point Groom silently clamped to the default 32 is not a long-curve test.
  for(let c=0;c<clusters;c++){
   const packed=data.readUInt32LE(20+clusters*40+16+(6*clusters+c)*16+8);
   assert((packed&255)>0);assert.equal((packed>>>8&255)||256,fixture.pointsPerCurve,'Native packed curve point count');
  }
  const originalDependencies=Array.from({length:count},(_,i)=>rawDependencies.readUInt16LE((start+i)*2));
  assert(originalDependencies.every(d=>d<fixture.pages&&d!==p));
  const dependencyOffset=dependencies.length;dependencies.push(...originalDependencies.map(gpuIndex));
  pages.push({page:p,gpuPage:gpuIndex(p),gpuOffset:gpuOffset(gpuIndex(p)),clusters,bytes,sourceOffset,dependencyOffset,originalDependencies,flags});
  chunks.push(data);sourceOffset+=data.length;
  const padding=(-sourceOffset)&15;if(padding){chunks.push(Buffer.alloc(padding));sourceOffset+=padding;}
 }
 const ready=new Set(),passes=[];let clusterCount=0;
 while(ready.size<fixture.pages){
  const batch=pages.filter(p=>!ready.has(p.page)&&p.originalDependencies.every(d=>ready.has(d)));
  assert(batch.length>0,'Cyclic curve page dependencies');const first=clusterCount;
  for(const p of batch){
   for(let c=0;c<p.clusters;c++)installs.push((p.gpuPage<<8)|c,p.sourceOffset,p.gpuOffset,p.dependencyOffset);
   clusterCount+=p.clusters;
  }
  batch.forEach(p=>ready.add(p.page));passes.push({start:first,count:clusterCount-first,pages:batch.map(p=>p.page)});
 }
 assert.equal(clusterCount,fixture.clusters);
 const writes={'pages.bin':Buffer.concat(chunks),'install.bin':Buffer.from(new Uint32Array(installs).buffer),'dependencies.bin':Buffer.from(new Uint32Array(dependencies.length?dependencies:[0]).buffer)};
 for(const [file,bytes]of Object.entries(writes))fs.writeFileSync(path.join(dir,file),bytes);
 const result={pass:true,name,fixture,source:audit(__filename),inputs:['fixture.json','roots.bin','page-states.bin','page-dependencies.bin','source-points.bin','source-materials.bin',...(fixture.streaming?['streaming.bin']:[])].map(f=>audit(path.join(dir,f))),
  pages,passes,streamPages,gpuBytes:streamPages*131072+fixture.rootPages*32768,products:Object.keys(writes).map(f=>audit(path.join(dir,f)))};
 fs.writeFileSync(path.join(dir,'gpu-inputs.json'),JSON.stringify(result,null,2)+'\n');fixtures.push({name,clusters:clusterCount,pages:fixture.pages,passes:passes.length});
}
assert.equal(fixtures.length,groom?4:29);console.log(JSON.stringify({pass:true,fixtures},null,2));
