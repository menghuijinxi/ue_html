'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs'),{verify}=require('./probe-nanite-distance.cjs');
const input=path.join(__dirname,'results/nanite-distance/browser.json'),captured=JSON.parse(fs.readFileSync(input));
assert(captured.pass);
const report={pass:false,source:audit(__filename),verifier:audit(require.resolve('./probe-nanite-distance.cjs')),input:audit(input),checks:[]};
const word=value=>new Uint32Array(new Float32Array([value]).buffer)[0];
const float=value=>new Float32Array(new Uint32Array([value]).buffer)[0];
function reject(name,step,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>t.step===step));mutate(t);
 let failure;try{verify(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.checks.push({name,step,rejected:true,failure});
}
reject('stale-pixel-distance-policy',2,t=>{const e=t.entries.find(e=>e.component===0);e.pixelProgrammable=!e.pixelProgrammable;},/pixel distance policy/);
reject('ignored-wpo-debug-control',13,t=>{t.entries.find(e=>e.component===0).evaluateWPO=false;},/WPO distance policy/);
reject('coherent-wrong-depth',2,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  const depth=word(float(t.pixels[i*12+1])+1e-4);
  t.pixels[i*12+1]=t.pixels[i*12+10]=t.gbuffer[i*28+1]=depth;
 }
},/WPO depth residual/);
reject('missing-wpo-velocity',10,t=>{
 const front=t.entries.find(e=>e.component===0);
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12+8]===front.instance)t.pixels[i*12+4]=t.pixels[i*12+5]=0;
},/WPO must emit velocity/);
reject('stale-instance-transform',23,t=>{t.entries.find(e=>e.component===0).localToWorld[12]+=100;},/distance policy|coverage|depth residual/);
reject('missing-fallback-surface',2,t=>{
 const front=t.entries.find(e=>e.component===0);
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12+8]===front.instance){
  t.pixels.fill(0,i*12,i*12+12);t.gbuffer.fill(0,i*28,i*28+28);
 }
},/coverage/);
report.pass=true;
fs.writeFileSync(path.join(__dirname,'results/nanite-distance/oracle-rejection.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:true,checks:report.checks.length});
