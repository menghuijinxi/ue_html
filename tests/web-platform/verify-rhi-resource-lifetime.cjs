'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const root=path.resolve(__dirname,'../..'),engine=path.join(root,'reference-engine');
const output=path.join(__dirname,'results/rhi-resource-lifetime');fs.mkdirSync(output,{recursive:true});
const header='Engine/Source/Runtime/RHI/Public/RHIResources.h',source='Engine/Source/Runtime/RHI/Private/RHIResources.cpp';
const baseline='a81426dc1';
function block(text,start) {
  const at=text.indexOf(start);assert(at>=0,start);const open=text.indexOf('{',at);let depth=1,end=open+1;
  for(;depth;++end){if(text[end]==='{')++depth;if(text[end]==='}')--depth;assert(end<text.length);}
  return text.slice(at,end);
}
const reports=[];
for(const variant of ['baseline','web-fixed','web-fixed-no-check','non-web-control']) {
  const dir=path.join(output,variant);fs.mkdirSync(dir,{recursive:true});
  const h=variant==='baseline'?cp.execFileSync('git',['-C',engine,'show',`${baseline}:${header}`],{encoding:'utf8'}):fs.readFileSync(path.join(engine,header),'utf8');
  const s=variant==='baseline'?cp.execFileSync('git',['-C',engine,'show',`${baseline}:${source}`],{encoding:'utf8'}):fs.readFileSync(path.join(engine,source),'utf8');
  fs.writeFileSync(path.join(dir,'RHIResources.input.h'),h);fs.writeFileSync(path.join(dir,'RHIResources.input.cpp'),s);
  const methods=['inline uint32 AddRef() const','inline uint32 Release() const','inline uint32 GetRefCount() const'].map(m=>block(h,m));
  const flags=block(h,'class FAtomicFlags').replace('std::atomic_uint','ObservedAtomic');
  const mark=block(s,'void FRHIResource::MarkForDelete() const').replace('FRHIResource::','');
  const enqueue=s.includes('void FRHIResource::EnqueueForDelete() const')?`#if PLATFORM_WEB\n${block(s,'void FRHIResource::EnqueueForDelete() const').replace('FRHIResource::','')}\n#endif`:'';
  const generated=path.join(dir,'rhi-resource-lifetime.generated.h');
  fs.writeFileSync(generated,`// Extracted production methods; only the atomic wrapper and queue are instrumented.\nclass FRHIResource { public:\n${flags};\nmutable FAtomicFlags AtomicFlags;\nbool bAllowExtendLifetime=true;\n${methods.join('\n')}\n${mark}\n${enqueue}\n};\n`);
  const sdk=path.join(root,'.tools/emsdk').replaceAll('\\','/'),js=path.join(dir,'probe.cjs'),log=path.join(dir,'compile.log');
  const args=[path.join(sdk,'upstream/emscripten/em++.py'),path.join(__dirname,'rhi-resource-lifetime-probe.cpp'),'-I'+dir,
    '-o',js,'-std=c++20','-O2','-m64','-sMEMORY64=2','-pthread','-fexceptions','-sPTHREAD_POOL_SIZE=8','-sEXIT_RUNTIME=1','-sENVIRONMENT=node',
    '-DDO_CHECK='+(variant==='web-fixed-no-check'?0:1),'-DPLATFORM_WEB='+(variant==='non-web-control'?0:1),'-DEXPECT_FIXED='+(variant.startsWith('web-fixed')?1:0)];
  const compile=cp.spawnSync(path.join(sdk,'python/3.13.3_64bit/python.exe'),args,{windowsHide:true,encoding:'utf8',env:{...process.env,WEB_EMSDK_ROOT:sdk,EM_CONFIG:sdk+'/.emscripten'}});
  fs.writeFileSync(log,(compile.stdout||'')+(compile.stderr||''));assert.equal(compile.status,0,fs.readFileSync(log,'utf8'));
  const run=cp.spawnSync(process.execPath,[js],{windowsHide:true,encoding:'utf8',timeout:60000});
  const runLog=path.join(dir,'run.log');fs.writeFileSync(runLog,(run.stdout||'')+(run.stderr||''));assert.equal(run.status,0,run.error?.message||fs.readFileSync(runLog,'utf8'));
  const result=JSON.parse(run.stdout.trim());assert(result.pass);console.log(JSON.stringify({variant,...result}));
  reports.push({variant,...result,inputs:['RHIResources.input.h','RHIResources.input.cpp'].map(f=>audit(path.join(dir,f))),generated:audit(generated),compileLog:audit(log),runLog:audit(runLog),products:[audit(js),audit(js.replace(/\.cjs$/,'.wasm'))]});
}
const report={date:new Date().toISOString(),pass:true,baseline,variants:reports,sources:[__filename,path.join(__dirname,'rhi-resource-lifetime-probe.cpp'),path.join(engine,header),path.join(engine,source)].map(audit),
  boundary:'Runs extracted production refcount methods in Wasm pthreads with a controlled atomic schedule and logical deletion claims. This proves three state races and the Web fix, not the identity of the resource in the earlier browser crash.'};
fs.writeFileSync(path.join(output,'verified.json'),JSON.stringify(report,null,2)+'\n');
