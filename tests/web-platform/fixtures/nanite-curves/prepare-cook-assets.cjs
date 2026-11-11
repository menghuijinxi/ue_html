'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('../../content-file-metadata.cjs');
const platform=path.resolve(__dirname,'../..'),root=path.resolve(platform,'../..');
const cook=JSON.parse(fs.readFileSync(path.join(platform,'results/web-project-nanite-streaming-desktop-cook-results.json'),'utf8').replace(/^\uFEFF/,''));
const project=path.resolve(cook.project);assert(project.startsWith(path.join(platform,'build/projects')+path.sep));
const descriptor=JSON.parse(fs.readFileSync(project,'utf8')),before=audit(project);
descriptor.Plugins||=[];let plugin=descriptor.Plugins.find(p=>p.Name==='HairStrands');
if(plugin)plugin.Enabled=true;else descriptor.Plugins.push({Name:'HairStrands',Enabled:true});
assert.equal(fs.statSync(project).nlink,1);fs.writeFileSync(project,JSON.stringify(descriptor,null,2)+'\n');
const output=path.join(path.dirname(project),'Content/WebNaniteCurves'),input=path.join(__dirname,'fixture-host/Content/WebNaniteCurves');
fs.mkdirSync(output,{recursive:true});assert.equal(fs.realpathSync(output),path.resolve(output));
const names=['NaniteGroomSmall','NaniteGroomStreaming','NaniteGroomLong256','NaniteGroomStreamingB'];
const assets=names.flatMap(n=>[n,n+'Material0',n+'Material1']).concat(Array.from({length:5},(_,i)=>'NaniteCurveMaterial'+(i||'')));
const copies=[];for(const name of assets){
 const source=path.join(input,name+'.uasset'),target=path.join(output,name+'.uasset');
 if(fs.existsSync(target))assert.equal(fs.statSync(target).nlink,1);fs.copyFileSync(source,target);
 const a=audit(source),b=audit(target);assert.equal(a.sha256,b.sha256);copies.push({source:a,copied:b,package:'/Game/WebNaniteCurves/'+name});
}
const report={pass:true,source:audit(__filename),before,project:audit(project),copies};
fs.writeFileSync(path.join(__dirname,'cook-assets.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,assets:copies.length});
