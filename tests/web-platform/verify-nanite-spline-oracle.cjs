'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {audit}=require('./content-file-metadata.cjs'),{verify}=require('./probe-nanite-spline.cjs');
const input=path.join(__dirname,'results/nanite-spline/browser.json'),captured=JSON.parse(fs.readFileSync(input));
assert(captured.pass);
const report={pass:false,source:audit(__filename),verifier:audit(require.resolve('./probe-nanite-spline.cjs')),input:audit(input),checks:[],streamingChecks:[]};
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0],word=v=>new Uint32Array(new Float32Array([v]).buffer)[0];
function reject(name,step,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>t.step===step));mutate(t);
 let failure;try{verify(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.checks.push({name,step,rejected:true,failure});
}
for(const step of [3,10,19,26,31])reject('coherent-wrong-depth-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  const w=word(float(t.pixels[i*12+1])+1e-4);t.pixels[i*12+1]=w;t.pixels[i*12+10]=w;t.gbuffer[i*28+1]=w;
 }
},/spline depth residual/);
reject('wrong-spline-shape',2,t=>{const p=t.entries.find(e=>e.component===0).splineParams;p[4]=word(float(p[4])+20);},/coverage|spline depth residual/);
for(const step of [3,5,6,31])reject('reversed-deformed-normal-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.gbuffer[i*28])for(const j of [8,9,10])t.gbuffer[i*28+j]=word(1-float(t.gbuffer[i*28+j]));
},/spline normal/);
reject('missing-deformed-velocity',20,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;
},/spline must emit velocity/);
reject('wrong-depth-velocity',25,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;
},/spline depth velocity/);
const streamingVerifier=path.join(__dirname,'probe-nanite-streaming.cjs'),streamingInput=path.join(__dirname,'results/nanite-spline-streaming/browser.json');
report.streamingVerifier=audit(streamingVerifier);report.streamingInput=audit(streamingInput);
report.geometryReference=audit(require.resolve('./nanite-spline-reference.cjs'));
vm.runInNewContext(fs.readFileSync(streamingVerifier,'utf8').split('(async()=>')[0]+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(streamingInput)}));assert(captured.pass&&captured.spline);
function reject(name,mutate,pattern){
 const t=JSON.parse(JSON.stringify(captured.tests.find(t=>!t.cameraCut)));mutate(t);
 let failure;try{verifyVelocity(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.streamingChecks.push({name,rejected:true,failure});
}
reject('streaming-missing-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;},/velocity must be written/);
reject('streaming-wrong-depth-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;},/depth velocity/);
reject('streaming-stale-spline-shape',t=>{t.spline=false;},/XY velocity|depth velocity/);
`,{require,__dirname,__filename:streamingVerifier,process,console,Buffer,oracleReport:report});
assert.equal(report.checks.length,12);assert.equal(report.streamingChecks.length,3);report.pass=true;
fs.writeFileSync(path.join(__dirname,'results/nanite-spline/oracle-rejection.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:report.pass,checks:report.checks.length,streamingChecks:report.streamingChecks.length});
