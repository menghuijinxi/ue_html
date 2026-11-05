'use strict';
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline'),assert=require('node:assert/strict');
const {audit}=require('../content-file-metadata.cjs');
const [tag]=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(tag));
const results=path.resolve(__dirname,'../results');
const sum=a=>a.reduce((s,v)=>s+v,0),median=a=>a.toSorted((a,b)=>a-b)[Math.floor(a.length/2)];
async function scopes(file) {
  const result=[];
  for await(const line of readline.createInterface({input:fs.createReadStream(file),crlfDelay:Infinity})) {
    let e;try{e=JSON.parse(line.trim().replace(/,$/,''));}catch{continue;}
    if(e.ph==='X'&&['CompileShaderDXC','ShaderModuleD3D12::Compile','CreatePipelineAsyncEvent::InitializeImpl','tint::hlsl::writer::Generate'].includes(e.name))result.push(e);
  }
  return result;
}
(async()=>{
  const out={date:new Date().toISOString(),pass:false,suites:[],sources:['run-compile-options.cjs','analyze-compile-options.cjs','prepare-shader-variants.cjs','optimize-spirv.cpp','benchmark-same-dxc.cpp'].map(f=>audit(path.join(__dirname,f)))};
  for(const stage of ['native','browser','scheduling'].filter(s=>fs.existsSync(path.join(results,`${tag}-${s}-suite.json`)))) {
    const file=path.join(results,`${tag}-${stage}-suite.json`),suite=JSON.parse(fs.readFileSync(file));assert(suite.pass);
    const entry={stage,suite:audit(file),cases:[]};
    for(const c of suite.cases) {
      const rows=[];
      for(const trial of suite.rounds.filter(r=>r.case===c.name)) {
        assert.equal(audit(trial.report.file).sha256,trial.report.sha256);
        const r=JSON.parse(fs.readFileSync(trial.report.file));
        if(stage==='native') {
          const run=r.rounds[0];assert.equal(run.shaders.length,30);assert(run.shaders.every(s=>s.success));
          if(c.optimization==='O3')assert(run.shaders.every(s=>s.matchesBrowser));
          rows.push({round:trial.round,wall:run.wallMs,dxcSum:sum(run.shaders.map(s=>s.ms)),dxcCpu:sum(run.shaders.map(s=>s.cpuMs)),dxcCount:run.shaders.length,maxDxc:Math.max(...run.shaders.map(s=>s.ms)),matchingHashes:run.shaders.filter(s=>s.matchesBrowser).length});
        } else {
          const run=r.runs[0],events=await scopes(run.trace),dxc=events.filter(e=>e.name==='CompileShaderDXC');
          assert.equal(run.successful,15);assert.equal(run.failed,0);
          if(!c.blobCache)assert.equal(dxc.length,30);
          const points=dxc.flatMap(e=>[[e.ts,1],[e.ts+e.dur,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let active=0,peak=0;
          for(const [,delta] of points){active+=delta;peak=Math.max(peak,active);}
          const total=n=>sum(events.filter(e=>e.name===n).map(e=>e.dur/1000));
          rows.push({round:trial.round,wall:run.pipelineWallMs,moduleReady:run.moduleReadyMs,dxcSum:sum(dxc.map(e=>e.dur/1000)),dxcCpu:sum(dxc.map(e=>e.tdur/1000)),dxcCount:dxc.length,maxDxc:Math.max(...dxc.map(e=>e.dur/1000)),peakDxc:peak,tint:total('tint::hlsl::writer::Generate'),initializationRemainder:total('CreatePipelineAsyncEvent::InitializeImpl')-total('ShaderModuleD3D12::Compile'),trace:audit(run.trace)});
        }
      }
      const medians=Object.fromEntries(Object.keys(rows[0]).filter(k=>typeof rows[0][k]==='number'&&k!=='round').map(k=>[k,median(rows.map(r=>r[k]))]));
      entry.cases.push({...c,rows,median:medians});console.log(JSON.stringify({stage,case:c.name,...medians}));
    }
    out.suites.push(entry);
  }
  out.pass=true;fs.writeFileSync(path.join(results,tag+'-analysis.json'),JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});
