'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=i=>assert.equal(audit(i.file).sha256,i.sha256,i.file);
const packageFile=path.join(__dirname,'build/nanite-browser/package.json'),pkg=read(packageFile);assert(pkg.pass);
[...pkg.sources,...pkg.products,pkg.build,pkg.native,pkg.hierarchyShaders,pkg.streamingShaders,pkg.multiMaterial.native,pkg.multiMaterial.fixture,pkg.sceneCook.stage,pkg.sceneCook.cook,pkg.sceneCook.inventory].forEach(verify);
const build=read(pkg.build.file);assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);full.sourceFiles.forEach(verify);
const files=['browser.json','browser-scalar.json'].map(f=>path.join(__dirname,'results/nanite-streaming-budget',f)),runs=files.map(read);
for(const [i,r] of runs.entries()){
  assert(r.pass);verify(r.source);verify(r.package);assert.equal(r.package.sha256,audit(packageFile).sha256);
  assert.equal(r.scalarVisibility,i===1);assert.deepEqual(r.errors,[]);assert.deepEqual(r.budgets.map(b=>b.budget),[1,2,4,8,12]);
  for(const b of r.budgets){
    assert.deepEqual(b.gpu.errors,[]);assert.equal(b.gpu.features.includes('atomic-vec2u-min-max'),i===0);
    assert.equal(b.tests.length,9);assert.notEqual(b.tests[4].runtimeID,b.tests[5].runtimeID);
    for(const t of b.tests){assert.equal(t.poolPages,b.budget);assert.equal(t.owners.length,b.budget);assert.equal(t.rejected,0);assert.equal(t.cullState[1],0);}
    const compared=b.tests.filter(t=>t.comparison);assert.equal(compared.length,6);
    for(const t of compared){assert.equal(t.comparison.missingCore,0);assert(t.comparison.core>800);assert(t.comparison.differentCoverage<=50);assert(t.comparison.maxDepthError<.002);}
    if(b.budget===12)for(const t of compared){assert.equal(t.residentClusters,t.totalClusters);assert.equal(t.comparison.maxDepthError,0);assert.equal(t.comparison.differentCoverage,0);}
    else assert(b.tests[2].residentClusters<b.tests[2].totalClusters);
  }
}
const payload=zlib.gzipSync(Buffer.from(JSON.stringify(runs)),{level:9});assert.deepEqual(JSON.parse(zlib.gunzipSync(payload)),runs);
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),package:audit(packageFile),build:build.fullEngineBuild,
  runs:runs.map((r,i)=>({artifact:audit(files[i]),scalarVisibility:r.scalarVisibility,budgets:r.budgets.map(b=>({budget:b.budget,frames:b.frames,
    comparisons:b.tests.filter(t=>t.comparison).map(t=>({step:t.step,residentClusters:t.residentClusters,totalClusters:t.totalClusters,...t.comparison}))}))})),
  payloadEncoding:'gzip-base64-json',payload:payload.toString('base64'),
  boundary:'Two actual WebGPU atomic configurations and five page budgets. Native streamable Cook geometry, resource replacement/reinitialization and pool reset. A bounded cache retains parent geometry under pressure; detailed geometry is exact once the full dependency group fits. This does not replace complete-scene visual/performance acceptance.'};
const file=path.join(__dirname,'evidence/nanite-streaming-budget-20261110.json');fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,file,bytes:fs.statSync(file).size,runs:report.runs.map(r=>({scalar:r.scalarVisibility,frames:r.budgets.reduce((n,b)=>n+b.frames,0)}))}));
