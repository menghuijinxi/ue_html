'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')),verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const name='nanite-core-lifecycle-20261111',dir=path.join(__dirname,'evidence',name);fs.mkdirSync(dir,{recursive:true});
const artifacts=[],seen=new Set();function archive(f){f=path.resolve(f);if(seen.has(f))return;seen.add(f);
 const bytes=fs.readFileSync(f),gz=zlib.gzipSync(bytes,{level:9});assert(zlib.gunzipSync(gz).equals(bytes));
 const target=path.join(dir,artifacts.length+'-'+path.basename(f)+'.gz');fs.writeFileSync(target,gz);artifacts.push({original:audit(f),archive:audit(target),encoding:'gzip'});}
const proofFile=path.join(__dirname,'evidence/nanite-disocclusion-20261111.json'),proof=read(proofFile);assert(proof.pass);proof.artifacts.forEach(a=>verify(a.archive));archive(proofFile);
const runs=[];
for(const isDefault of [true,false])for(const scalar of [false,true]){
 const scene=isDefault?'default':'villa',mode=scalar?'scalar':'packed',f=path.join(__dirname,`results/nanite-core-lifecycle/${scene}-${mode}-12.json`),r=read(f);
 assert(r.pass);assert.equal(r.defaultScene,isDefault);assert.equal(r.scalar,scalar);assert.equal(r.pages,12);assert.equal(r.runs.length,2);assert.deepEqual(r.errors,[]);
 verify(r.source);verify(r.package);assert.equal(r.package.sha256,proof.packages[isDefault?'nanite-core-default':'nanite-core-scene'].package.sha256);
 const pkg=read(r.package.file);assert(pkg.pass);pkg.products.forEach(verify);archive(r.package.file);
 assert(r.profile.startsWith('C:\\Users\\wap80\\.cache\\ue-html-build-archive\\nanite-core-browser\\')||r.profile.startsWith('C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/'));
 assert.equal(r.recovery.generation,2);assert.equal(r.recovery.attempts,1);assert.equal(r.recovery.events.filter(e=>e.kind==='device-lost'&&e.reason==='unknown').length,1);
 assert(r.comparison.covered>100&&r.comparison.maxSpecularDifference<=1/255+1e-7);
 for(const [i,g] of r.runs.entries()){
  assert.equal(g.generation,i+1);assert(g.clock.materialTimeFrozen&&!g.clock.renderTimeFrozen);assert(g.frames>2000);
  assert.deepEqual(g.gpu.errors,[]);assert.equal(g.gpu.features.includes('atomic-vec2u-min-max'),!scalar);
  assert.equal(g.tests.length,isDefault?5:6);assert.equal(g.rhi.asyncPrecacheRequested,g.rhi.asyncPrecacheCompleted);assert.equal(g.rhi.asyncPrecacheFailed||0,0);
  const active=g.tests.filter(t=>t.entries>0);assert(active.some(t=>t.poolOwners.some(o=>o!==0xffffffff)));
  for(const t of active){assert(t.materialComplete&&t.rejected===0&&t.covered>100);assert.equal(t.poolPages,12);assert.equal(t.poolOwners.length,12);
   assert.equal(t.allocatedPoolBytes,Math.ceil(t.poolBytes/65536)*65536);assert(g.gpu.buffers.some(b=>b.size===t.allocatedPoolBytes));
   assert(t.poolOwners.every(o=>o===0xffffffff||(o>=12&&o<1036)));}
 }
 archive(f);archive(r.source.file);runs.push({scene,mode,frames:r.runs.reduce((s,g)=>s+g.frames,0),cameraCaptures:r.runs.reduce((s,g)=>s+g.tests.length,0),comparison:r.comparison,report:audit(f)});
}
for(const n of ['lifecycle-pool-allocation-failure.cjs','lifecycle-pool-allocation-failure.json','lifecycle-pool-alignment-observed-failure.cjs','lifecycle-pool-alignment-observed-failure.json'])archive(path.join(__dirname,'results/nanite-core',n));
for(const f of ['../ue-web-smoke/Source/UEWebEngine/Private/WebNaniteAutomaticSceneTest.cpp','../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
 '../../reference-engine/Engine/Source/Runtime/RenderCore/Private/RenderGraphResourcePool.cpp','web-engine-host.js','web-engine-worker.js'])archive(path.resolve(__dirname,f));
archive(__filename);
const report={pass:true,date:new Date().toISOString(),runtimeEvidence:audit(proofFile),source:audit(__filename),runs,artifacts,
 boundary:'Actual Template_Default and Villa packages, fresh isolated browser profiles, 12-page Nanite streaming budgets and GPU page-owner readback. Each atomic configuration undergoes one real GPU-process crash, runtime recreation and repeated camera sweeps. Final depth and material samples match across recovery, including the existing one-level specular tolerance. This is a bounded scene/device lifecycle test, not a claim of unlimited runtime or every experimental Nanite feature.'};
const output=path.join(__dirname,'evidence',name+'.json');fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log({pass:true,file:output,runs,artifacts:artifacts.length});
