'use strict';
// Package an actual scene from its complete Cook and full target build. Asset
// fixtures used by separate component probes are not dependencies of this scene.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {audit,metadata}=require('./content-file-metadata.cjs');
const {validateCook}=require('./cached-cook-validation.cjs');
const {writeVersions}=require('./asset-versions.cjs');
const {applyAcceptedDefaults}=require('./web-accepted-defaults.cjs');
const root=__dirname,defaultScene=process.argv.includes('--default-scene');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const stageFile=path.join(root,'results',defaultScene?'web-engine-webgpu-sm5-default-stage-results.json':'web-project-nanite-full-scene-desktop-stage-results.json');
const stage=read(stageFile);assert(stage.pass&&stage.mode==='WebGPU-SM5');
[...stage.sourceFiles,stage.cookReport,stage.pack,stage.manifest,stage.configBundle].forEach(verify);
const cook=read(stage.cookReport.file);validateCook(cook,false,{});
assert(cook.naniteCookData&&cook.exitCode===0&&!cook.disabledSkyLight);
assert.equal(cook.map,defaultScene?'/Engine/Maps/Templates/Template_Default':'/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla');
verify(cook.shaderInventory.artifact);const inventory=read(cook.shaderInventory.artifact.file);
for(const [name,count] of [['FWebNaniteRasterVS',1],['FWebNaniteRasterPS',1],['FWebNaniteScalarRasterPS',2],
 ['FWebNaniteMicroRasterCS',3],['FWebNaniteVisibleClustersCS',1],['FWebNaniteHierarchyCull_CS',4],['FWebNaniteOcclusionCS',4]])
 assert(inventory.types.some(t=>t.name===name&&t.permutations===count),'Missing complete scene shader: '+name);
let sceneConversion;
if(defaultScene){verify(cook.defaultSamples);assert(read(cook.defaultSamples.file).nanite);}
else{
 assert(cook.useProjectSettings);
 const file=path.join(root,'results/nanite-full-scene-conversion-verified.json'),r=read(file);assert(r.pass);
 [...r.sources,...r.originalFiles,...r.convertedFiles,r.report,r.log].forEach(verify);sceneConversion=audit(file);
}
const buildFile=path.join(root,'build/nanite-browser-runtime/build.json'),build=read(buildFile);
assert(build.pass&&build.fullTargetBuild);[...build.sources,...build.products,build.fullEngineBuild].forEach(verify);
const full=read(build.fullEngineBuild.file);assert(full.pass&&full.fullLinkVerified);
// Ordinary scene targets must not acquire the experimental Groom dependency.
const link=fs.readFileSync(full.linkResponse.file,'utf8');verify(full.linkResponse);
assert(!/[/\\](?:HairStrandsCore|HairStrandsRuntime)[/\\]/.test(link),'Unexpected Groom module in ordinary scene runtime');
const uploaderFile=path.join(read(path.join(root,'results/nanite-core/uploaders.json')).single,'verified.json');
const uploader=read(uploaderFile);assert(uploader.pass);uploader.sources.forEach(verify);uploader.products.forEach(verify);verify(uploader.runtimeShaderArchive);
const streamingFile=path.join(root,'results/nanite-streaming-shaders/verified.json'),streaming=read(streamingFile);assert(streaming.pass);
[...streaming.sources,streaming.archive,streaming.binary,...streaming.logs].forEach(verify);
for(const name of ['FTranscodePageToGPU_CS','FClearStreamingRequestCount_CS','FScatterUpdates_CS'])
 assert(!inventory.types.some(t=>t.name===name&&t.permutations>0),'Supplement already present in scene Cook: '+name);
const manifest=read(stage.manifest.file);assert.equal(manifest.shaderPlatform,'SP_WEBGPU_SM5');
const global=manifest.files.find(f=>f.path==='/Engine/GlobalShaderCache-SP_WEBGPU_SM5.bin');assert(global);
const original=Buffer.alloc(global.size),fd=fs.openSync(stage.pack.file,'r');
try{assert.equal(fs.readSync(fd,original,0,global.size,global.offset),global.size);}finally{fs.closeSync(fd);}
const transcode=fs.readFileSync(uploader.runtimeShaderArchive.file),fixups=fs.readFileSync(streaming.archive.file);
assert.equal(transcode.readInt32LE(),1);assert.equal(fixups.readInt32LE(),2);
const merged=Buffer.concat([original,transcode.subarray(4),fixups.subarray(4)]);
merged.writeInt32LE(original.readInt32LE()+3);
const output=path.join(root,'build',defaultScene?'nanite-core-default':'nanite-core-scene');fs.mkdirSync(output,{recursive:true});
const pack=path.join(output,'content.bin');fs.copyFileSync(stage.pack.file,pack);
const offset=fs.statSync(pack).size;fs.appendFileSync(pack,merged);
manifest.files=manifest.files.filter(f=>f.path!==global.path);
manifest.files.push({path:global.path,offset,size:merged.length,sha256:crypto.createHash('sha256').update(merged).digest('hex')});
manifest.pack=metadata(pack,'content.bin');fs.writeFileSync(path.join(output,'content-files.json'),JSON.stringify(manifest));
fs.copyFileSync(stage.configBundle.file,path.join(output,'config-files.json'));
const helpers=['web-content-io.js','web-content-worker.js','web-engine-host.js','web-engine-worker.js'];
for(const name of helpers)fs.copyFileSync(path.join(root,name),path.join(output,name));
for(const p of build.products)fs.copyFileSync(p.file,path.join(output,path.basename(p.file)));
const runtime=build.products.map(p=>path.basename(p.file));
const pageSource=path.join(root,'web-default-template.html');
const pageTemplate=defaultScene?pageSource:path.join(root,'build/villa-default-20261107/index.html');
const baseline=fs.readFileSync(pageTemplate,'utf8');let html=fs.readFileSync(pageSource,'utf8');
const assets=defaultScene?{threads:true,renderer:'desktop',distanceFields:!!cook.distanceFields}:JSON.parse(baseline.match(/const localRuntimeAssets = (\{[^\n]*\});/)[1]);
Object.assign(assets,{versions:Object.fromEntries([...runtime,...helpers].map(n=>[n,audit(path.join(output,n)).sha256])),
 runtime:'UEWebEngineThreads.js',wasm:metadata(path.join(output,'UEWebEngineThreads.wasm'),'UEWebEngineThreads.wasm')});
assert(assets.threads&&assets.renderer==='desktop');
html=html.replace('const localRuntimeAssets = {};','const localRuntimeAssets = '+JSON.stringify(assets)+';');
const args=baseline.match(/arguments: \[[^\n]+\]/);assert(args);
html=html.replace(/arguments: \[[^\n]+\]/,args[0]).replace('arguments: [','arguments: ["-WebNaniteScene",');
fs.writeFileSync(path.join(output,'index.html'),html);
const performanceProfile=applyAcceptedDefaults(output);
const products=['index.html','content.bin','content-files.json','config-files.json',...helpers,...runtime].map(n=>audit(path.join(output,n)));
products.push(writeVersions(output,products));
const report={date:new Date().toISOString(),pass:true,output,defaultScene,fullScene:!defaultScene,sceneConversion,performanceProfile,
 build:audit(buildFile),native:audit(uploaderFile),archive:uploader.runtimeShaderArchive,streamingShaders:audit(streamingFile),
 sceneCook:{stage:audit(stageFile),cook:stage.cookReport,inventory:cook.shaderInventory.artifact,streamingArchiveApplied:true},
 sources:[__filename,pageSource,pageTemplate,...['cached-cook-validation.cjs','web-accepted-defaults.cjs','asset-versions.cjs',...helpers].map(n=>path.join(root,n))].map(audit),products,
 boundary:'Full ordinary Nanite scene package. Requires browser image, lifecycle, streaming and performance acceptance before delivery.'};
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,output});
