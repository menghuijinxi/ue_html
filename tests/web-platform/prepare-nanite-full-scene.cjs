'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const file=path.join(__dirname,'results/web-project-nanite-full-scene-prepare-results.json');
const prepared=JSON.parse(fs.readFileSync(file,'utf8'));
assert(prepared.pass&&prepared.originalProjectUnmodified&&prepared.useProjectSettings);
const root=path.dirname(prepared.project);assert.equal(root,path.join(__dirname,'build/projects/nanite-full-scene'));
for(const i of [...prepared.sourceFiles,...prepared.copiedFiles,prepared.descriptor]){
  assert.equal(audit(i.file).sha256,i.sha256,i.file);
  if(i.file.startsWith(root+path.sep))assert.equal(fs.statSync(i.file).nlink,1,'conversion must not write through hard links');
}
const marker=path.join(root,'.web-nanite-project-copy.json');assert(!fs.existsSync(marker),'Do not reset an already converted project');
fs.writeFileSync(marker,JSON.stringify({source:audit(__filename),preparation:audit(file),original:prepared.originalProject,project:prepared.project,originalProjectUnmodified:true},null,2));
console.log(JSON.stringify({pass:true,marker:audit(marker)}));
