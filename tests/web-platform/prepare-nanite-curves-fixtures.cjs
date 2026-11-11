'use strict';
// Keep fixture generators and the independent GPU references under source
// control; materialize their writable native project and results separately.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),source=path.join(__dirname,'fixtures/nanite-curves');
const output=path.join(__dirname,'results/nanite-curves'),copies=[];
function copyTree(from,to,filter=()=>true){
 fs.mkdirSync(to,{recursive:true});assert.equal(fs.realpathSync(to),path.resolve(to));
 for(const e of fs.readdirSync(from,{withFileTypes:true})){
  const src=path.join(from,e.name),dst=path.join(to,e.name);if(!filter(src,e))continue;
  assert(!e.isSymbolicLink(),'Unexpected fixture link: '+src);
  if(e.isDirectory()){copyTree(src,dst,filter);continue;}
  const input=audit(src);
  if(fs.existsSync(dst))assert.equal(fs.statSync(dst).nlink,1,'Refuse hard-linked output: '+dst);
  if(!fs.existsSync(dst)||audit(dst).sha256!==input.sha256)fs.copyFileSync(src,dst);
  const copied=audit(dst);assert.equal(input.sha256,copied.sha256);copies.push({source:input,copied});
 }
}
copyTree(source,output);
// Reuse the current shader compiler plugin, including its native build. Never
// archive or rebuild an installed engine plugin as part of fixture staging.
copyTree(path.join(root,'tests/ue-shader-host/Plugins/WebGPUShader'),
 path.join(output,'fixture-host/Plugins/WebGPUShader'),(file,e)=>!e.isDirectory()||e.name!=='Intermediate');
// This host runs the native D3D12 RHI and the shader format commandlets. The
// separate uploader/RHI probe module belongs to ue-shader-host and resolves
// repository-relative build dependencies from that project's location.
const descriptorFile=path.join(output,'fixture-host/Plugins/WebGPUShader/WebGPUShader.uplugin');
const descriptor=JSON.parse(fs.readFileSync(descriptorFile,'utf8'));
assert(descriptor.Modules.some(m=>m.Name==='WebGPURHI'));
descriptor.Modules=descriptor.Modules.filter(m=>m.Name!=='WebGPURHI');
fs.writeFileSync(descriptorFile,JSON.stringify(descriptor,null,2)+'\n');
const descriptorCopy=copies.find(c=>c.copied.file===descriptorFile);assert(descriptorCopy);
descriptorCopy.copied=audit(descriptorFile);descriptorCopy.transform='Native shader fixture excludes the separate WebGPURHI uploader probe';
const report={pass:true,source:audit(__filename),output,copies};
fs.writeFileSync(path.join(output,'fixture-preparation.json'),JSON.stringify(report,null,2)+'\n');
console.log({pass:true,files:copies.length,output});
