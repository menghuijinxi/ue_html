'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),stock=process.env.UE_ENGINE_ROOT||'D:/UE_5.8/Engine';
const host=path.join(root,'.tools/ue58-web-native-build-host/Engine');
const report={pass:false,host,installedEngine:stock,installedInputs:[],sourceFiles:[]};
const read=f=>fs.readFileSync(f,'utf8').replace(/\r\n/g,'\n');
const safe=f=>assert(fs.realpathSync(path.dirname(f)).toLowerCase().startsWith(root.toLowerCase()+path.sep),'workspace output: '+f);
function independentCopy(source,target){
 safe(target);
 if(fs.existsSync(target)&&fs.statSync(target).nlink>1){assert.equal(audit(target).sha256,audit(source).sha256);fs.unlinkSync(target);}
 if(fs.existsSync(target))assert.equal(fs.statSync(target).nlink,1);
 if(!fs.existsSync(target)||audit(target).sha256!==audit(source).sha256){if(fs.existsSync(target))fs.chmodSync(target,0o666);fs.copyFileSync(source,target);}
}
function replace(text,before,after){assert.equal(text.split(before).length,2,before);return text.replace(before,()=>after);}
try{
 assert.equal(audit(path.join(stock,'Build/Build.version')).sha256,audit(path.join(host,'Build/Build.version')).sha256,'native host version');
 const developer=path.join(host,'Source/Developer');
 if(fs.lstatSync(developer).isSymbolicLink()){
  assert.equal(fs.realpathSync(developer),fs.realpathSync(path.join(stock,'Source/Developer')));
  // Unlink the junction itself; never recurse into installed engine sources.
  fs.unlinkSync(developer);fs.mkdirSync(developer);
 }
 assert.equal(fs.realpathSync(developer),path.resolve(developer));
 for(const entry of fs.readdirSync(path.join(stock,'Source/Developer'),{withFileTypes:true})){
  const source=path.join(stock,'Source/Developer',entry.name),target=path.join(developer,entry.name);
  if(entry.name==='NaniteBuilder'){
   if(!fs.existsSync(target))fs.cpSync(source,target,{recursive:true});
   assert.equal(fs.realpathSync(target),path.resolve(target));
  }else if(!fs.existsSync(target)){
   if(entry.isDirectory())fs.symlinkSync(source,target,'junction');else fs.copyFileSync(source,target);
  }
 }
 const relative='Source/Developer/NaniteBuilder/Private/';
 for(const name of ['Cluster.cpp','NaniteBuilder.cpp']){
  const installed=path.join(stock,relative,name),reference=path.join(root,'reference-engine/Engine',relative,name),target=path.join(host,relative,name);
  report.installedInputs.push(audit(installed));report.sourceFiles.push(audit(reference));
  let text=read(installed);const modified=read(reference);
  if(name==='Cluster.cpp'){
   const operations=[
    ['#include "MeshUtilitiesCommon.h"','#include "MeshUtilitiesCommon.h"\n#include "NaniteSkinningWeld.h"'],
    ['\tFMeshSimplifier Simplifier( Verts.Array.GetData(), Verts.Num(), Indexes.GetData(), Indexes.Num(), MaterialIndexes.GetData(), NumAttributes );',
     '\tconst FSkinningWeld SkinningWeld(Verts);\n\tFMeshSimplifier Simplifier( Verts.Array.GetData(), Verts.Num(), Indexes.GetData(), Indexes.Num(), MaterialIndexes.GetData(), NumAttributes );\n\tSkinningWeld.LockSeams(Simplifier);'],
    ['\tVerts.SetNum( Simplifier.GetRemainingNumVerts() );','\tVerts.SetNum( Simplifier.GetRemainingNumVerts() );\n\tSkinningWeld.Restore(Verts);']
   ];
   for(const [before,after]of operations){assert(modified.includes(after));text=replace(text,before,after);}
  }else{
   const after='\tstatic const FString WeldedVersionString = VersionString + TEXT("_SKINNING_WELD_2");\n\treturn WeldedVersionString;';
   assert(modified.includes(after));text=replace(text,'\treturn VersionString;',after);
  }
  safe(target);assert.equal(fs.statSync(target).nlink,1);fs.chmodSync(target,0o666);fs.writeFileSync(target,text);
  report.sourceFiles.push(audit(target));
 }
 const helper=path.join(root,'reference-engine/Engine',relative,'NaniteSkinningWeld.h'),target=path.join(host,relative,'NaniteSkinningWeld.h');
 independentCopy(helper,target);report.sourceFiles.push(audit(helper),audit(target),audit(__filename));
 for(const extension of ['dll','pdb']){
  const source=path.join(stock,`Binaries/Win64/UnrealEditor-NaniteBuilder.${extension}`),target=path.join(host,`Binaries/Win64/UnrealEditor-NaniteBuilder.${extension}`);
  if(fs.existsSync(source)){report.installedInputs.push(audit(source));if(!fs.existsSync(target)||fs.statSync(target).nlink>1)independentCopy(source,target);}
 }
 report.pass=true;
}catch(e){report.failure=e.stack;process.exitCode=1;}
fs.writeFileSync(path.join(__dirname,'results/native-nanitebuilder-host-results.json'),JSON.stringify(report,null,2));
console.log({pass:report.pass,host,failure:report.failure});
