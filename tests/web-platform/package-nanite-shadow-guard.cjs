'use strict';
// Re-Cooked scene shaders with the exact previous runtime, settings and helpers.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit,metadata}=require('./content-file-metadata.cjs');
const {writeVersions}=require('./asset-versions.cjs');
const option=n=>process.argv.find(a=>a.startsWith('--'+n+'='))?.slice(n.length+3);
const project=option('project'),baseline=option('baseline'),name=option('output');
const defaultScene=process.argv.includes('--default-scene'),hierarchyBatch=process.argv.includes('--hierarchy-batch');
const occlusionBatch=process.argv.includes('--occlusion-batch');
const packBatch=process.argv.includes('--pack-batch');
const microBatch=process.argv.includes('--micro-batch');
// The rigid batch round prepares fixed and micro raster together; its Cook no longer has the separate micro prepare shader.
const rigidBatch=process.argv.includes('--rigid-batch');
const fixedMerge=process.argv.includes('--fixed-merge'),programmableMerge=process.argv.includes('--programmable-merge'),shadeBinning=process.argv.includes('--shade-binning');
assert([baseline,name].every(n=>/^[a-z0-9-]+$/.test(n)));
assert(defaultScene||/^[a-z0-9-]+$/.test(project));
const root=__dirname,base=path.join(root,'build',baseline),output=path.join(root,'build',name);
assert(!fs.existsSync(output),'Candidate must have its own new directory');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const stageFile=path.join(root,'results',defaultScene?'web-engine-webgpu-sm5-default-stage-results.json':`web-project-${project}-desktop-stage-results.json`);
const stage=read(stageFile);assert(stage.pass&&stage.mode==='WebGPU-SM5');
assert(defaultScene?stage.scene==='DefaultTemplate':stage.useProjectSettings);
[...stage.sourceFiles,stage.cookReport,stage.pack,stage.manifest,stage.configBundle].forEach(verify);
const cook=read(stage.cookReport.file);assert(cook.pass&&cook.naniteCookData&&cook.exitCode===0);
[...cook.sourceFiles,...cook.products].forEach(verify);
if(hierarchyBatch){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  assert(inventory.types.some(t=>t.name==='FWebNaniteHierarchyCull_CS'&&t.permutations===5),'Cook must include the new rigid hierarchy batch permutation');}
if(occlusionBatch){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  assert(inventory.types.some(t=>t.name==='FWebNaniteOcclusionCS'&&t.permutations===5),'Cook must include the rigid occlusion batch permutation');}
if(packBatch){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  assert(inventory.types.some(t=>t.name==='FWebNaniteVisibleClustersCS'&&t.permutations===2),'Cook must include both visible-cluster packing permutations');}
if(microBatch){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  for(const [name,permutations] of [['FWebNaniteMicroRasterCS',6],...(rigidBatch?[]:[['FWebNaniteMicroArgumentsCS',1]])])
    assert(inventory.types.some(t=>t.name===name&&t.permutations===permutations),'Cook must include '+name+' with all permutations');}
if(fixedMerge){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  for(const name of ['FWebNaniteFixedBatchArgumentsCS','FWebNaniteFixedBatchVS'])
    assert(inventory.types.some(t=>t.name===name&&t.permutations===1),'Cook must include '+name);}
if(rigidBatch){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  assert(microBatch&&fixedMerge,'The rigid batch serves both the fixed and the micro raster');
  assert(!inventory.types.some(t=>t.name==='FWebNaniteMicroArgumentsCS'),'A rigid batch Cook must not contain the removed micro prepare shader');}
if(programmableMerge){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  assert(inventory.types.some(t=>t.name==='FWebNaniteProgrammableBatchArgumentsCS'&&t.permutations===1),'Cook must include FWebNaniteProgrammableBatchArgumentsCS');}
if(shadeBinning){verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
  for(const [name,permutations] of [['FWebNaniteShadeBinTilesCS',2],['FWebNaniteShadeBinReserveCS',1],['FWebNaniteMaterialBinTilesVS',1]])
    assert(inventory.types.some(t=>t.name===name&&t.permutations===permutations),'Cook must include '+name+' with all permutations');}
const coreFile=path.join(root,'build/nanite-core-scene/package.json'),core=read(coreFile);
assert(core.pass);core.products.forEach(verify);
verify(core.archive);verify(core.streamingShaders);
const streaming=read(core.streamingShaders.file);assert(streaming.pass);verify(streaming.archive);
const versions=read(path.join(base,'asset-versions.json'));
const baselineProducts=Object.keys(versions).map(n=>{
  assert.equal(path.basename(n),n);const a=audit(path.join(base,n));assert.equal(a.sha256,versions[n].sha256);return a;
});
const manifest=read(stage.manifest.file),originalGlobal=manifest.files.find(f=>f.path==='/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin');
assert(originalGlobal);
const data=Buffer.alloc(originalGlobal.size),fd=fs.openSync(stage.pack.file,'r');
try{assert.equal(fs.readSync(fd,data,0,data.length,originalGlobal.offset),data.length);}finally{fs.closeSync(fd);}
const transcode=fs.readFileSync(core.archive.file),fixups=fs.readFileSync(streaming.archive.file);
assert.equal(transcode.readInt32LE(),1);assert.equal(fixups.readInt32LE(),2);
const combined=Buffer.concat([data,transcode.subarray(4),fixups.subarray(4)]);combined.writeInt32LE(data.readInt32LE()+3);
fs.mkdirSync(output);
for(const p of baselineProducts) {
  const n=path.basename(p.file);if(['content.bin','content-files.json','index.html'].includes(n))continue;
  fs.linkSync(p.file,path.join(output,n));
}
fs.copyFileSync(path.join(base,'index.html'),path.join(output,'index.html'));
const pack=path.join(output,'content.bin');fs.copyFileSync(stage.pack.file,pack);
const offset=fs.statSync(pack).size;fs.appendFileSync(pack,combined);
manifest.files=manifest.files.filter(f=>f.path!==originalGlobal.path);
manifest.files.push({path:originalGlobal.path,offset,size:combined.length,
  sha256:require('node:crypto').createHash('sha256').update(combined).digest('hex')});
manifest.pack=metadata(pack,'content.bin');
fs.writeFileSync(path.join(output,'content-files.json'),JSON.stringify(manifest));
const products=baselineProducts.map(p=>audit(path.join(output,path.basename(p.file))));
products.push(writeVersions(output,products));
const old=read(path.join(base,'content-files.json'));
const changes=manifest.files.filter(f=>old.files.find(a=>a.path===f.path)?.sha256!==f.sha256).map(f=>({path:f.path,size:f.size}));
const report={date:new Date().toISOString(),pass:true,output,defaultScene,hierarchyBatch,occlusionBatch,packBatch,microBatch,rigidBatch,fixedMerge,programmableMerge,shadeBinning,baselineProducts,baselineVersions:audit(path.join(base,'asset-versions.json')),
  core:audit(coreFile),stage:audit(stageFile),cook:stage.cookReport,archive:core.archive,streamingArchive:streaming.archive,
  performanceProfile:core.performanceProfile,products,changes,
  sources:[__filename,require.resolve('./prepare-web-cook-shaders.cjs'),
    path.join(root,'../../reference-engine/Engine/Shaders/Private/ShadowDepthPixelShader.usf')].map(audit),
  boundary:'Same existing runtime and configuration. Fresh complete scene Cook; optional hierarchy batch permutation is verified against its shader inventory. '
    +'Reuses the baseline verified Nanite transcode/streaming archive bytes; no change to those shaders. '
    +'Performance and full compatibility acceptance require separate browser reports.'};
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({pass:true,output,changes:changes.length,products:products.length}));
