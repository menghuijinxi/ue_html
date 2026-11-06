'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const results=path.join(__dirname,'results');
const output=process.argv[2];assert(output&&!fs.existsSync(output));
const buildFile=path.join(results,'mouse-low-new-motion-runtime-20261106.json');
const build=JSON.parse(fs.readFileSync(buildFile,'utf8').replace(/^\uFEFF/,''));
assert(build.pass&&build.buildSucceeded&&build.exitCode===0);
for(const item of [...build.sourceFiles,...build.products])assert.equal(audit(item.file).sha256,item.sha256);
const report={date:new Date().toISOString(),pass:false,performanceAccepted:false,defaultChanged:false,
  physicalPresentationValidated:false,source:audit(__filename),build:audit(buildFile),runs:{},
  boundary:'Correctness regression only. Five static views do not prove absence of transient artifacts during all camera motion. Performance acceptance remains unfulfilled.'};
for(const side of ['control','final']){
  const file=path.join(results,`mouse-low-${side}-validation-20261106.json`);
  const r=JSON.parse(fs.readFileSync(file));assert(r.pass);assert.deepEqual(r.errors,[]);
  assert(r.readbackTest.pass&&r.pipelineDiagnostics.matchesUnsupportedCount);
  assert.deepEqual(r.pipelineDiagnostics.otherLogErrors,[]);
  assert.deepEqual(r.tour.map(v=>v.name),['right','back','left','room','return']);
  const bindingChecks=r.bindingValidationAfter.occlusion.bindingEntriesValidated-r.bindingValidationBefore.occlusion.bindingEntriesValidated;
  assert(bindingChecks>0);
  for(const item of [...r.files,...r.tour.map(v=>v.image)])assert.equal(audit(item.file).sha256,item.sha256);
  report.runs[side]={raw:audit(file),folder:r.folder,bindingChecks,textureReadback:r.readbackTest,
    stagingReadback:r.stagingReadbackTest,poolBefore:r.stagingPoolBefore,poolAfter:r.stagingPoolAfter,
    knownUnsupportedPrecache:r.pipelineDiagnostics.failedCreate,files:r.files,tour:r.tour};
}
const candidate=report.runs.final,control=report.runs.control;
assert(candidate.stagingReadback.pass&&candidate.stagingReadback.rounds===32);
assert(candidate.poolAfter.reused>candidate.poolBefore.reused);
assert(candidate.poolAfter.entries<=64&&candidate.poolAfter.bytes<=32*1024*1024);
for(let i=0;i<control.tour.length;i++)assert.deepEqual(candidate.tour[i].camera,control.tour[i].camera);
for(const name of ['UEWebEngineThreads.js','web-engine-worker.js'])assert.equal(
  candidate.files.find(v=>path.basename(v.file)===name).sha256,control.files.find(v=>path.basename(v.file)===name).sha256);
report.comparison=audit(path.join(results,'mouse-low-validation-comparison-20261106.jpg'));
report.pass=true;fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:report.pass,performanceAccepted:false,bindingChecks:control.bindingChecks+candidate.bindingChecks,staging:candidate.stagingReadback}));
