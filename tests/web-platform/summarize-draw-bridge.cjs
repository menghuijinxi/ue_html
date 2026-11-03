'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const dir=__dirname,read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const median=a=>[...a].sort((a,b)=>a-b)[a.length>>1];
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const audit=f=>({file:path.relative(dir,f),sha256:hash(f)});
const microFile=path.resolve(process.argv[2]),villaFile=path.resolve(process.argv[3]),checkFile=path.resolve(process.argv[4]),apiFile=path.resolve(process.argv[5]),output=path.resolve(process.argv[6]);
const micro=read(microFile),villa=read(villaFile),check=read(checkFile),api=read(apiFile);
assert(micro.pass&&villa.pass&&check.pass&&api.pass&&!micro.validateCalls&&api.validateCalls);
for(const item of [...micro.sources,...micro.baselineSources])assert.equal(hash(path.resolve(dir,item.file)),item.sha256,'Micro source or binary changed: '+item.file);
for(const item of villa.packageFiles)assert.equal(hash(item.file),item.sha256,'UE package changed');
const summarize=r=>{
 const cases=[];
 for(const variant of r.variants)for(const draws of [1000,3200,10000])for(let mode=0;mode<4;mode++){
  const rounds=r.runs.filter(run=>run.variant===variant).map(run=>{
   const c=run.cases.find(c=>c.mode===mode&&c.draws===draws);assert(c.outputVerified);
   const totals=c.setup.samplesMs.map((v,i)=>v+c.drawLoop.samplesMs[i]+c.finish.samplesMs[i]+c.submit.samplesMs[i]);
   return {round:run.round,drawMs:c.drawLoop.medianMs,totalFrontendMs:median(totals),gpuMs:c.gpu.medianMs,wallMs:c.batch3WallMsPerFrame};
  });
  cases.push({variant,draws,mode,medians:Object.fromEntries(['drawMs','totalFrontendMs','gpuMs','wallMs'].map(k=>[k,median(rounds.map(v=>v[k]))])),rounds});
 }return cases;
};
const ablations=['draw-bridge-ablation-v1','draw-bridge-f64-v1'].map(tag=>{const file=path.join(dir,'results',tag+'.json'),r=read(file);assert(r.pass);return {raw:audit(file),sources:r.sources,cases:summarize(r)};});
const profilesFile=check.profile+'-analysis.json',profile=read(profilesFile);
const environments=[microFile.replace(/\.json$/,'-environment.jsonl'),path.join(dir,'results/villa-command-stream-v36-environment.jsonl')].map(file=>({file:audit(file),samples:fs.readFileSync(file,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line.replace(/^\uFEFF/,'')))}));
const result={date:new Date().toISOString(),pass:true,
 micro:{raw:audit(microFile),rounds:micro.rounds,browser:micro.browser,sources:micro.sources,baselineSources:micro.baselineSources,boundary:micro.boundary,cases:summarize(micro)},
 apiEquivalence:{raw:audit(apiFile),pass:true,passesPerVariant:api.runs[0].apiRecords.length,description:'Per-pass method-order/argument hash and method count agree with the original build. Instrumented timings excluded.'},
 ablations,
 villa:{raw:audit(villaFile),source:villa.source,packageFiles:villa.packageFiles,browser:villa.browser,boundary:villa.boundary,summary:villa.summary,
  runs:villa.runs.map(({bridge,fps,rhiWorkMs,frameMs,workload,before,after,errors})=>({bridge,fps,rhiWorkMs,frameMs,workload,before,after,errors}))},
 correctness:{raw:audit(checkFile),pass:true,streamConfirmed:check.streamConfirmed,views:check.views,before:check.before,after:check.after,errors:check.errors},
 profile:{raw:audit(profilesFile),boundary:profile.boundary,profiles:profile.profiles.map(p=>({role:p.role,durationMs:p.durationMs,categories:p.categories,self:p.self.slice(0,20),inclusive:p.inclusive.slice(0,30)}))},
 environments};
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.table(result.micro.cases.filter(c=>c.draws===3200&&c.mode===1).map(c=>({variant:c.variant,...c.medians})));
console.log(JSON.stringify(villa.summary));
