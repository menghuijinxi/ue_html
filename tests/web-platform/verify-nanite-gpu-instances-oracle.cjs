'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('node:vm');
const {audit}=require('./content-file-metadata.cjs'),{verify}=require('./probe-nanite-gpu-instances.cjs');
const input=path.join(__dirname,'results/nanite-gpu-instances/browser.json'),captured=JSON.parse(fs.readFileSync(input));
assert(captured.pass);
const report={pass:false,source:audit(__filename),verifier:audit(require.resolve('./probe-nanite-gpu-instances.cjs')),input:audit(input),checks:[]};
const word=value=>new Uint32Array(new Float32Array([value]).buffer)[0];
const float=value=>new Float32Array(new Uint32Array([value]).buffer)[0];
function reject(name,step,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>t.step===step));mutate(t);
 let failure;try{verify(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.checks.push({name,step,rejected:true,failure});
}
reject('cpu-transform-substitution',1,t=>{t.entries.find(e=>e.component===0).localToWorld[12]=100400;},/CPU transform mirror/);
reject('stale-gpu-projection',2,t=>{t.gpuInstances[12]=word(float(t.gpuInstances[12])+1);},/GPUScene projection matrix/);
reject('ignored-gpu-hidden-flag',13,t=>{t.gpuInstances[84+80]=1;},/GPU instance flags/);
reject('ignored-gpu-pixel-distance',5,t=>{t.gpuInstances[82]^=1;},/GPU instance flags/);
reject('stale-writer-allocation',7,t=>{t.writerFirst++;},/GPU writer allocation/);
reject('stale-writer-frame',7,t=>{t.writerRenderFrame--;},/current render frame/);
reject('wrong-gpu-normal',3,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  for(const j of [8,9,10])t.gbuffer[i*28+j]=word(1-float(t.gbuffer[i*28+j]));
 }
},/GPU instance normal/);
reject('coherent-wrong-depth',1,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  const depth=word(float(t.pixels[i*12+1])+1e-4);
  t.pixels[i*12+1]=t.pixels[i*12+10]=t.gbuffer[i*28+1]=depth;
 }
},/depth residual/);
reject('orthographic-three-ulp-depth',25,t=>{
 const back=t.entries.find(e=>e.component===1).instance;
 let changed=0;
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]&&t.pixels[i*12+8]===back){
  const depth=t.pixels[i*12+1]+3;
  t.pixels[i*12+1]=t.pixels[i*12+10]=t.gbuffer[i*28+1]=depth;changed++;
 }
 assert(changed>20,'orthographic corruption must cover the rigid reference surface');
},/depth residual/);
reject('missing-gpu-motion',1,t=>{
 const ids=new Set(t.entries.filter(e=>e.component===0).map(e=>e.instance));
 for(let i=0;i<t.width*t.height;i++)if(ids.has(t.pixels[i*12+8]))t.pixels[i*12+4]=t.pixels[i*12+5]=0;
},/must emit velocity/);
reject('stale-previous-pose',3,t=>{t.previousPhase-=1;},/velocity/);
reject('wrong-gpu-instance-owner',1,t=>{
 const front=t.entries.filter(e=>e.component===0);
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12+8]===front[0].instance)t.pixels[i*12+8]=front[1].instance;
},/GPU instance owner/);
reject('missing-gpu-surface',1,t=>{
 const ids=new Set(t.entries.filter(e=>e.component===0).map(e=>e.instance));
 for(let i=0;i<t.width*t.height;i++)if(ids.has(t.pixels[i*12+8])){
  t.pixels.fill(0,i*12,i*12+12);t.gbuffer.fill(0,i*28,i*28+28);
 }
},/coverage/);
const streamingVerifier=path.join(__dirname,'probe-nanite-streaming.cjs'),streamingInput=path.join(__dirname,'results/nanite-gpu-streaming/browser.json');
report.streamingVerifier=audit(streamingVerifier);report.streamingInput=audit(streamingInput);report.streamingChecks=[];
vm.runInNewContext(fs.readFileSync(streamingVerifier,'utf8').split('(async()=>')[0]+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(streamingInput)}));assert(captured.pass&&captured.gpuInstances);
function reject(name,mutate,pattern){
 const t=JSON.parse(JSON.stringify(captured.tests[2]));mutate(t);
 let failure;try{verifyVelocity(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.streamingChecks.push({name,rejected:true,failure});
}
reject('streaming-cpu-transform-substitution',t=>{t.localToWorld[0]=.55;},/CPU transform mirror/);
reject('streaming-stale-writer-allocation',t=>{t.writerFirst++;},/GPU writer allocation/);
reject('streaming-missing-gpu-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;},/velocity must be written/);
`,{require,__dirname,__filename:streamingVerifier,process,console,Buffer,oracleReport:report});
assert.equal(report.streamingChecks.length,3);report.pass=true;
fs.writeFileSync(path.join(__dirname,'results/nanite-gpu-instances/oracle-rejection.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:true,checks:report.checks.length,streamingChecks:report.streamingChecks.length});
