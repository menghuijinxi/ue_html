'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
function activate(host){
 const file=path.join(__dirname,'results/native-nanitebuilder-build-results.json'),build=read(file);
 const valid=i=>fs.existsSync(i.file)&&audit(i.file).sha256===i.sha256;
 assert(build.pass&&build.installedInputsUnmodified&&[...build.sourceFiles,...build.products,...build.installedInputs].every(valid),'Rebuild native NaniteBuilder before Cook');
 const directory=path.join(path.resolve(host),'Binaries/Win64');
 assert(fs.realpathSync(directory).toLowerCase().startsWith(root.toLowerCase()+path.sep),'NaniteBuilder destination must be local to the workspace');
 const source=build.products.find(p=>path.basename(p.file)==='UnrealEditor-NaniteBuilder.dll');assert(source);
 const destination=path.join(directory,'UnrealEditor-NaniteBuilder.dll'),manifest=path.join(directory,'web-nanite-builder.json');
 if(fs.existsSync(destination)&&audit(destination).sha256!==source.sha256){
  const previous=fs.existsSync(manifest)?read(manifest):null;
  const installed=build.installedInputs.find(p=>path.basename(p.file)==='UnrealEditor-NaniteBuilder.dll');
  const current=audit(destination);assert(current.sha256===installed?.sha256||current.sha256===previous?.binary?.sha256,'Unexpected NaniteBuilder DLL');
  // Remove only the workspace directory entry, so a hardlink never writes to
  // the installed engine. The replacement is an independent file.
  fs.unlinkSync(destination);
 }
 if(!fs.existsSync(destination))fs.copyFileSync(source.file,destination);
 assert.equal(fs.statSync(destination).nlink,1);assert.equal(audit(destination).sha256,source.sha256);
 assert(build.installedInputs.every(valid));
 const result={pass:true,build:audit(file),binary:audit(destination),activation:audit(__filename)};
 fs.writeFileSync(manifest,JSON.stringify(result,null,2));return result;
}
module.exports={activate};
if(require.main===module){assert(process.argv[2],'Pass an isolated workspace Engine directory');console.log(activate(process.argv[2]));}
