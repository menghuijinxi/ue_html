'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),zlib=require('node:zlib');
const {audit}=require('./content-file-metadata.cjs');
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=a=>assert.equal(audit(a.file).sha256,a.sha256,a.file);
const root=path.join(__dirname,'results'),curves=path.join(root,'nanite-curves');
const bins=read(path.join(root,'nanite-fixed-bins/verified.json'));assert(bins.pass);
[bins.source,bins.production,...bins.results.flatMap(r=>r.files)].forEach(verify);
assert.deepEqual(bins.results.map(r=>[r.cases,r.exitCode]),[[262144,16],[262144,0]]);
const runFile=path.join(curves,'native-preflight/run.json'),run=read(runFile);assert(run.pass&&run.preflight);
[...run.sources,...run.captures,run.log].forEach(verify);
const native=read(path.join(curves,'native-preflight/preflight-small.json'));assert.equal(native.naniteComponents,2);
assert(native.entries.every(e=>e.nanite&&e.curves===64));assert.equal(native.featureLevel,4);assert.equal(native.antiAliasingMethod,0);
assert(!/Error:|Ensure condition failed|Fatal error/.test(fs.readFileSync(run.log.file,'utf8')));
const failFile=path.join(curves,'failure-native-groom-pipeline/native.log');
assert(fs.readFileSync(failFile,'utf8').includes('Assertion failed: !RasterizerPass.ClusterComputeShader.IsNull()'));
const rendererFile=path.join(root,'native-renderer-build-results.json'),renderer=read(rendererFile);
assert(renderer.pass&&renderer.installedInputsUnmodified);[...renderer.sourceFiles,...renderer.products,...renderer.installedInputs,renderer.log].forEach(verify);
assert(run.sources.some(a=>path.basename(a.file)==='UnrealEditor-Renderer.dll'&&a.sha256===renderer.products.find(p=>p.file.endsWith('UnrealEditor-Renderer.dll')).sha256));
const fullFile=path.join(root,'web-engine-full-thread-build-results.json'),full=read(fullFile);assert(full.pass&&full.fullLinkVerified);
full.sourceFiles.forEach(verify);verify(full.log);
const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()).replaceAll('-','');
const output=path.join(__dirname,'evidence','nanite-fixed-bins-'+stamp);fs.mkdirSync(output,{recursive:true});
const files=[],inputs=new Set([__filename,bins.source.file,bins.production.file,runFile,run.log.file,failFile,rendererFile,renderer.log.file,fullFile,full.log.file,
 ...bins.results.flatMap(r=>r.files.map(a=>a.file)),...run.captures.map(a=>a.file),...run.sources.filter(a=>!/\.(dll|pdb)$/.test(a.file)).map(a=>a.file)]);
for(const source of inputs){const raw=fs.readFileSync(source),bytes=zlib.gzipSync(raw,{level:9});assert(zlib.gunzipSync(bytes).equals(raw));
 const target=path.join(output,`${files.length}-${path.basename(source)}.gz`);fs.writeFileSync(target,bytes);files.push({source:audit(source),archive:audit(target),bytes:raw.length});}
const report={pass:true,date:new Date().toISOString(),source:audit(__filename),bins,nativePreflight:audit(runFile),renderer:audit(rendererFile),fullBuild:audit(fullFile),files,
 boundary:'Fixes the disabled voxel slots allocated between triangle and curve fixed bins. Native two-component SM6 Groom preflight and complete Web compile/link pass; browser curve acceptance, all 21 native comparisons and full Nanite completion remain open.'};
const target=path.join(__dirname,'evidence','nanite-fixed-bins-'+stamp+'.json');fs.writeFileSync(target,JSON.stringify(report,null,2)+'\n');console.log({pass:true,target,files:files.length});
