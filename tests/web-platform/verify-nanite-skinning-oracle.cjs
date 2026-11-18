'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {audit}=require('./content-file-metadata.cjs'),{verify}=require('./probe-nanite-skinning.cjs');
const input=path.join(__dirname,'results/nanite-skinning/browser.json'),captured=JSON.parse(fs.readFileSync(input));
assert(captured.pass);
const report={pass:false,source:audit(__filename),verifier:audit(require.resolve('./probe-nanite-skinning.cjs')),input:audit(input),checks:[],streamingChecks:[]};
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0],word=v=>new Uint32Array(new Float32Array([v]).buffer)[0];
function reject(name,step,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>t.step===step));mutate(t);
 let failure;try{verify(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.checks.push({name,step,rejected:true,failure});
}
for(const step of [3,10,13,26,31])reject('coherent-wrong-depth-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  const w=word(float(t.pixels[i*12+1])+1e-4);t.pixels[i*12+1]=w;t.pixels[i*12+10]=w;t.gbuffer[i*28+1]=w;
 }
},/skinning depth residual/);
reject('wrong-bone-pose',2,t=>{t.entries.find(e=>e.component===0).bones[1][12]+=20;},/coverage|skinning depth residual/);
for(const step of [3,5,6,31])reject('reversed-deformed-normal-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.gbuffer[i*28])for(const j of [8,9,10])t.gbuffer[i*28+j]=word(1-float(t.gbuffer[i*28+j]));
},/skinning normal/);
reject('missing-deformed-velocity',22,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;
},/skinning must emit velocity/);
reject('wrong-depth-velocity',25,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;
},/skinning depth velocity/);
const streamingVerifier=path.join(__dirname,'probe-nanite-skinning-streaming.cjs'),streamingInput=path.join(__dirname,'results/nanite-skinning-streaming/browser.json');
report.streamingVerifier=audit(streamingVerifier);report.streamingInput=audit(streamingInput);
report.geometryDecoder=audit(require.resolve('./verify-nanite-material-inputs.cjs'));
vm.runInNewContext(fs.readFileSync(streamingVerifier,'utf8').split('(async()=>')[0]+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(streamingInput)}));assert(captured.pass&&captured.skinning);
function reject(name,mutate,pattern){
 const t=JSON.parse(JSON.stringify(captured.tests.find(t=>!t.cameraCut)));mutate(t);
 let failure;try{verifyVelocity(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.streamingChecks.push({name,rejected:true,failure});
}
reject('streaming-missing-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;},/velocity must be written/);
reject('streaming-wrong-depth-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;},/depth velocity/);
reject('streaming-stale-bone-pose',t=>{t.bones[1]=t.bones[0].slice();},/XY velocity|depth velocity/);
`,{require,__dirname,__filename:streamingVerifier,process,console,Buffer,oracleReport:report});
assert.equal(report.checks.length,12);assert.equal(report.streamingChecks.length,3);report.pass=true;
fs.writeFileSync(path.join(__dirname,'results/nanite-skinning/oracle-rejection.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:report.pass,checks:report.checks.length,streamingChecks:report.streamingChecks.length});
