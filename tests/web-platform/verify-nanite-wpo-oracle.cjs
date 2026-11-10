'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const verifier=path.join(__dirname,'probe-nanite-wpo.cjs');
const runFile=path.join(__dirname,'results/nanite-wpo/browser.json');
const code=fs.readFileSync(verifier,'utf8').split('(async()=>')[0];
assert(code.includes('function verify(t)'));
const report={pass:false,source:audit(__filename),verifier:audit(verifier),input:audit(runFile),checks:[]};
const context={require,__dirname,__filename:verifier,process,console,oracleReport:report};
vm.runInNewContext(code+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(runFile)}));assert(captured.pass);
const word=v=>new Uint32Array(new Float32Array([v]).buffer)[0];
const sample=t=>{const front=t.entries.find(e=>e.component===0);for(let i=0;i<t.width*t.height;i++)
  if(t.pixels[i*12]&&t.pixels[i*12+8]===front.instance)return i;throw new Error('No front surface');};
function reject(name,step,mutate,pattern){
  const t=JSON.parse(JSON.stringify(captured.tests.find(t=>t.step===step)));mutate(t);
  let failure;try{verify(t);}catch(e){failure=e.message;}
  assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.checks.push({name,step,rejected:true,failure});
}
for(const step of [2,33,34,35,36])reject('wrong-depth-'+step,step,t=>{
  // Preserve agreement between the visibility, scene-depth and GBuffer copies.
  // Only an independent geometry comparison can reject this coherent corruption.
  for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
    const w=word(float(t.pixels[i*12+1])+1e-4);t.pixels[i*12+1]=w;t.pixels[i*12+10]=w;t.gbuffer[i*28+1]=w;
  }
},/WPO depth residual/);
reject('missing-deformed-velocity',3,t=>{const i=sample(t);t.pixels[i*12+4]=t.pixels[i*12+5]=0;},/WPO must emit velocity/);
reject('wrong-depth-velocity',34,t=>{
  for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12])t.pixels[i*12+6]=t.pixels[i*12+7]=0;
},/WPO depth velocity/);
reject('undersized-rotated-bounds',4,t=>{const e=t.entries.find(e=>e.component===0);e.localWPOExtent=e.localWPOExtent.map(v=>v*.5);},/culling bounds/);
reject('stale-component-distance',10,t=>{t.entries.find(e=>e.component===0).evaluateWPO=true;},/WPO component.distance policy/);
oracleReport.pass=true;
`,context);
assert(report.pass&&report.checks.length===9);
const streamingVerifier=path.join(__dirname,'probe-nanite-streaming.cjs'),streamingInput=path.join(__dirname,'results/nanite-wpo-streaming/browser.json');
report.streamingVerifier=audit(streamingVerifier);report.streamingInput=audit(streamingInput);
report.geometryDecoder=audit(path.join(__dirname,'verify-nanite-material-inputs.cjs'));report.streamingChecks=[];
vm.runInNewContext(fs.readFileSync(streamingVerifier,'utf8').split('(async()=>')[0]+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(streamingInput)}));assert(captured.pass&&captured.wpo);
function reject(name,mutate,pattern){
 const t=JSON.parse(JSON.stringify(captured.tests[0]));mutate(t);
 let failure;try{verifyVelocity(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.streamingChecks.push({name,rejected:true,failure});
}
reject('streaming-missing-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;},/velocity must be written/);
reject('streaming-wrong-depth-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;},/depth velocity/);
reject('streaming-stale-camera-transform',t=>{t.previousWorldToClip[12]+=2;},/XY velocity/);
`,{require,__dirname,__filename:streamingVerifier,process,console,Buffer,oracleReport:report});
assert.equal(report.streamingChecks.length,3);
const file=path.join(__dirname,'results/nanite-wpo/oracle-rejection.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log({pass:true,file,checks:report.checks.length,streamingChecks:report.streamingChecks.length});
