'use strict';
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const file=path.join(__dirname,'verify-decode.cjs'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
m._compile(fs.readFileSync(file,'utf8').split('(async()=>{')[0]+'\nmodule.exports={decode,read};',file);
const {decode,read}=m.exports,results=[],groom=process.argv.includes('--groom'),root=path.join(__dirname,groom?'groom-gpu':'fixtures');
for(const name of fs.readdirSync(root)){
 const dir=path.join(root,name),pageFile=path.join(dir,'gpu-pages.bin');if(!fs.existsSync(pageFile))continue;
 const input=read(path.join(dir,'gpu-inputs.json')),data=fs.readFileSync(pageFile),install=fs.readFileSync(path.join(dir,'install.bin'));
 let tested=0,outside=0,maxOutside=0;const examples=[];
 for(let i=0;i<input.fixture.clusters;i++){
  const page=data.subarray(install.readUInt32LE(i*16+8)),c=install.readUInt32LE(i*16)&255,n=page.readUInt32LE(0)&65535;
  const f=(row,col)=>page.readFloatLE(16+(row*n+c)*16+col*4),meta=decode(page,c,0);
  for(let v=0;v<meta.vertices;v++){
   const p=decode(page,c,v);let distance=0;
   // The ribbon can point along any direction perpendicular to its tangent
   // as the camera turns. This is the actual maximum offset on each box axis.
   for(let axis=0;axis<3;axis++){
    const radius=p.radius*Math.sqrt(Math.max(0,1-p.normal[axis]**2));
    distance=Math.max(distance,Math.abs(p.p[axis]-f(3,axis))+radius-f(4,axis));
   }
   assert(Number.isFinite(distance));tested++;
   if(distance>1e-4){outside++;maxOutside=Math.max(maxOutside,distance);if(examples.length<3)examples.push({cluster:i,point:v,outside:distance});}
  }
 }
 results.push({name,tested,outside,maxOutside,examples,inputs:[audit(pageFile),audit(path.join(dir,'gpu-inputs.json'))]});
}
assert.equal(results.length,groom?4:29);const result={pass:results.every(r=>r.outside===0),source:audit(__filename),results};
fs.writeFileSync(path.join(__dirname,(groom?'groom-':'')+'native-bounds.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({pass:result.pass,results:results.map(({inputs,examples,...r})=>r)},null,2));
if(!result.pass)process.exitCode=1;
