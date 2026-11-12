'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit,metadata}=require('./content-file-metadata.cjs'),{writeVersions}=require('./asset-versions.cjs');
const [baseName,name]=process.argv.slice(2);assert([baseName,name].every(n=>/^[a-z0-9-]+$/.test(n)));
const base=path.join(__dirname,'build',baseName),output=path.join(__dirname,'build',name);
assert(!fs.existsSync(output));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const verify=p=>assert.equal(audit(p.file).sha256,p.sha256,p.file);
const parentFile=path.join(base,'package.json'),parent=read(parentFile);assert(parent.pass);parent.products.forEach(verify);
const buildFile=path.join(__dirname,'results/web-engine-full-thread-build-results.json'),build=read(buildFile);
assert(build.pass&&build.fullLinkVerified&&build.threads&&!build.trace&&!build.simd&&build.lowerMemory64);
[...build.sourceFiles,...build.products,build.log,build.linkResponse].forEach(verify);
fs.mkdirSync(output);
const runtime=['UEWebEngineThreads.js','UEWebEngineThreads.wasm','web-engine-worker.js'];
for(const p of parent.products){const n=path.basename(p.file);if(![...runtime,'index.html','asset-versions.json'].includes(n))fs.linkSync(p.file,path.join(output,n));}
for(const name of runtime){const source=name==='web-engine-worker.js'?path.join(__dirname,name):build.products.find(p=>path.basename(p.file)===name)?.file;assert(source);fs.copyFileSync(source,path.join(output,name));}
let html=fs.readFileSync(path.join(base,'index.html'),'utf8');const match=html.match(/const localRuntimeAssets = (\{[^\n]*\});/);assert(match);
const assets=JSON.parse(match[1]);for(const n of runtime)assets.versions[n]=audit(path.join(output,n)).sha256;
assets.wasm=metadata(path.join(output,'UEWebEngineThreads.wasm'),'UEWebEngineThreads.wasm');
html=html.replace(match[0],'const localRuntimeAssets = '+JSON.stringify(assets)+';');fs.writeFileSync(path.join(output,'index.html'),html);
const products=fs.readdirSync(output).map(n=>audit(path.join(output,n)));products.push(writeVersions(output,products));
const snapshot=path.join(output,'runtime-build.json');fs.copyFileSync(buildFile,snapshot);
const report={date:new Date().toISOString(),pass:true,output,fullScene:parent.fullScene,performanceProfile:parent.performanceProfile,
  parent:audit(parentFile),build:audit(snapshot),source:audit(__filename),worker:audit(path.join(__dirname,'web-engine-worker.js')),products,
  boundary:'Same immutable Cook/configuration with a separately verified complete target build. Requires scene and performance verification.'};
fs.writeFileSync(path.join(output,'package.json'),JSON.stringify(report,null,2)+'\n');console.log({pass:true,output});
