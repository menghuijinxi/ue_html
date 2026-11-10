'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {audit}=require('./content-file-metadata.cjs'),{verify}=require('./probe-nanite-assembly.cjs');
const staticAssembly=process.argv.includes('--static'),kind=staticAssembly?'static':'skin';
const input=path.join(__dirname,`results/nanite-assembly/${kind}-scene/browser.json`);
const captured=JSON.parse(fs.readFileSync(input));assert(captured.pass);
const report={pass:false,staticAssembly,source:audit(__filename),verifier:audit(require.resolve('./probe-nanite-assembly.cjs')),input:audit(input),checks:[],streamingChecks:[]};
const float=w=>new Float32Array(new Uint32Array([w]).buffer)[0],word=v=>new Uint32Array(new Float32Array([v]).buffer)[0];
function reject(name,step,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>t.step===step));assert(t);mutate(t);
 let failure;try{verify(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.checks.push({name,step,rejected:true,failure});
}
for(const step of [3,10,13,26,31])reject('coherent-wrong-depth-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.pixels[i*12]){
  const w=word(float(t.pixels[i*12+1])+1e-4);t.pixels[i*12+1]=w;t.pixels[i*12+10]=w;t.gbuffer[i*28+1]=w;
 }
},/skinning depth residual/);
reject(staticAssembly?'wrong-component-transform':'wrong-attachment-pose',2,t=>{
 const e=t.entries.find(e=>e.component===0);
 if(staticAssembly)e.localToWorld[12]+=40;else e.bones[1][12]+=40;
},/coverage|depth residual|authored assembly instance|material slot/);
for(const step of [3,5,6,31])reject('reversed-part-normal-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.gbuffer[i*28])for(const j of [8,9,10])t.gbuffer[i*28+j]=word(1-float(t.gbuffer[i*28+j]));
},/skinning normal/);
reject('missing-assembly-velocity',22,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;
},/skinning must emit velocity/);
reject('wrong-depth-velocity',25,t=>{
 for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;
},/skinning depth velocity/);
reject('wrong-valid-part-index',3,t=>{
 for(let i=2;i<t.visibleRecords.length;i+=3){
  const old=t.visibleRecords[i]&0xffffff;if(old===0xffffff)continue;
  const entry=t.entries.find(e=>old>=e.assemblyBase&&old<e.assemblyBase+12);assert(entry);
  t.visibleRecords[i]=(t.visibleRecords[i]&0xff000000)|(entry.assemblyBase+(old-entry.assemblyBase+3)%12);
 }
},/visible record selects the authored assembly instance/);
for(const step of [33,34])reject('wrong-material-slot-'+step,step,t=>{
 for(let i=0;i<t.width*t.height;i++)if(t.gbuffer[i*28])for(const j of [16,17,18])t.gbuffer[i*28+j]=word(0);
},/assembly material slot/);
const streamingVerifier=path.join(__dirname,'probe-nanite-assembly-streaming.cjs');
const streamingInput=path.join(__dirname,`results/nanite-assembly/${kind}-streaming/browser.json`);
report.streamingVerifier=audit(streamingVerifier);report.streamingInput=audit(streamingInput);
report.geometryDecoder=audit(require.resolve('./verify-nanite-material-inputs.cjs'));
vm.runInNewContext(fs.readFileSync(streamingVerifier,'utf8').split('(async()=>')[0]+`
const captured=JSON.parse(fs.readFileSync(${JSON.stringify(streamingInput)}));assert(captured.pass&&captured.assembly);
function reject(name,mutate,pattern){
 const t=structuredClone(captured.tests.find(t=>!t.cameraCut));mutate(t);
 let failure;try{verifyVelocity(t);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),name+': '+failure);oracleReport.streamingChecks.push({name,rejected:true,failure});
}
reject('streaming-missing-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+4]=t.pixels[i+5]=0;},/velocity must be written/);
reject('streaming-wrong-depth-velocity',t=>{for(let i=0;i<t.pixels.length;i+=12)t.pixels[i+6]=t.pixels[i+7]=0;},/depth velocity/);
reject('streaming-stale-transform',t=>{if(staticAssembly)t.localToWorld[12]+=40;else t.bones[1]=t.bones[0].slice();},/XY velocity|depth velocity/);
`,{require,__dirname,__filename:streamingVerifier,process,console,Buffer,structuredClone,oracleReport:report});
const budgetInput=path.join(__dirname,`results/nanite-assembly/${kind}-budget/browser.json`);
const budget=require('./verify-nanite-assembly-budget.cjs'),budgetCapture=JSON.parse(fs.readFileSync(budgetInput));assert(budgetCapture.pass);
report.budgetInput=audit(budgetInput);report.budgetVerifier=audit(require.resolve('./verify-nanite-assembly-budget.cjs'));report.budgetChecks=[];
function rejectBudget(name,step,mutate,pattern){
 const group=budgetCapture.budgets[0],t=structuredClone(group.tests.find(t=>t.step===step));assert(t);
 mutate(t);let failure;try{if(step===2)budget.verify(t);else budget.compare(group.tests[1],t,group.budget);}catch(e){failure=e.message;}
 assert(failure&&pattern.test(failure),`${name}: ${failure}`);report.budgetChecks.push({name,step,rejected:true,failure});
}
const covered=t=>t.pixels.findIndex((v,i)=>i%12===0&&v!==0);
rejectBudget('missing-selected-interior',3,t=>{
 const w=t.width,i=t.pixels.findIndex((v,p)=>p%12===0&&v&&[-w,w,-1,1].every(d=>t.pixels[p+d*12]));assert(i>=0);t.pixels.fill(0,i,i+12);
},/must not lose coverage/);
rejectBudget('added-selected-coverage',3,t=>{assert.equal(t.pixels[0],0);t.pixels[0]=t.pixels[covered(t)];},/must not add coverage/);
rejectBudget('coherent-wrong-selected-depth',3,t=>{const p=covered(t),d=word(float(t.pixels[p+1])+1e-4);t.pixels[p+1]=t.pixels[p+10]=d;},/selected assembly depth/);
rejectBudget('stale-selected-component',3,t=>{t.localToWorld[12]+=40;},/selected assembly depth|must not .* coverage/);
rejectBudget('stale-selected-attachment',2,t=>{if(staticAssembly)t.localToWorld[12]+=40;else t.bones[1][12]+=40;},/selected assembly depth|must not .* coverage/);
rejectBudget('foreign-selected-page',3,t=>{t.owners.fill(0xffffffff);},/page ownership/);
rejectBudget('missing-selected-cluster',3,t=>{t.cullState[0]--;},/triangle accounting/);
rejectBudget('wrong-selected-part',2,t=>{
 const b=Buffer.from(t.visibleRecords,'base64');let changed=0;
 for(let i=0;i<t.cullState[0];i++){const index=b.readUInt32LE(i*12+8)&0xffffff;if(index===0xffffff)continue;
  // Parts share one mesh. Cycling every index only permutes the same geometry;
  // collapse the nonzero placements onto the first valid part instead.
  if(index!==0){b.writeUInt32LE(0,i*12+8);changed++;}}
 assert(changed);t.visibleRecords=b.toString('base64');
},/selected assembly depth|must not .* coverage/);
rejectBudget('wrong-budget-stencil',3,t=>{const full=budgetCapture.budgets[0].tests[1];
 const p=t.pixels.findIndex((v,i)=>i%12===0&&v&&full.pixels[i]);assert(p>=0);t.pixels[p+3]^=2;
},/assembly budget stencil/);
assert.equal(report.checks.length,15);assert.equal(report.streamingChecks.length,3);assert.equal(report.budgetChecks.length,9);report.pass=true;
fs.writeFileSync(path.join(__dirname,`results/nanite-assembly/${kind}-oracle-rejection.json`),JSON.stringify(report,null,2)+'\n');
console.log({pass:true,staticAssembly,checks:report.checks.length,streamingChecks:report.streamingChecks.length,budgetChecks:report.budgetChecks.length});
