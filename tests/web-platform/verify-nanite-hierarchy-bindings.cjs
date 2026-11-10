'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{audit}=require('./content-file-metadata.cjs');
const baseline=process.argv.includes('--baseline'),read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const out=path.join(__dirname,'results/nanite-assembly'),dir=path.join(__dirname,'results/nanite-hierarchy-shaders/conversion');
const stages=[];
if(baseline){
 const file=path.join(out,'failure-hierarchy-bindings-and-io/rejected-shader.json'),shader=path.join(path.dirname(file),'rejected-shader.wgsl');
 stages.push({permutation:2,input:audit(file),shader:audit(shader),...read(file).metadata,code:fs.readFileSync(shader,'utf8')});
}else{
 for(let permutation=0;permutation<4;permutation++){
  const candidates=fs.readdirSync(dir).map(n=>path.join(dir,n,'input.json')).filter(fs.existsSync).filter(f=>read(f).shader?.startsWith(`WebNaniteHierarchyProbe/FWebNaniteHierarchyCull_CS/${permutation}:`));
  candidates.sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);assert(candidates.length);
  const file=candidates[0],shader=path.join(path.dirname(file),'output.wgsl');
  stages.push({permutation,input:audit(file),shader:audit(shader),...read(file).metadata,code:fs.readFileSync(shader,'utf8')});
 }
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8765/build/motion-blur-storage-formats/index.html');
 const result=await page.evaluate(async stages=>{
  const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:16}}),results=[],errors=[];
  device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
  try{for(const s of stages){
   device.pushErrorScope('validation');const module=device.createShaderModule({code:s.code}),info=await module.getCompilationInfo();
   const shaderErrors=info.messages.filter(m=>m.type==='error').map(m=>m.message);let pipelineError;
   try{await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:s.webEntry}});}catch(e){pipelineError=e.message;}
   const scope=await device.popErrorScope();results.push({permutation:s.permutation,shaderErrors,pipelineError,scopeError:scope?.message||null});
  }return {limit:device.limits.maxStorageBuffersPerShaderStage,results,errors};}finally{device.destroy();}
 },stages);
 assert.deepEqual(result.errors,[]);assert.equal(result.limit,16);
 for(let i=0;i<stages.length;i++){
  const count=stages[i].spirvBindings.filter(b=>b.descriptorType===7).length,r=result.results[i];assert.deepEqual(r.shaderErrors,[]);
  r.storageBuffers=count;
  if(baseline){assert.equal(count,17);assert.match(r.pipelineError||r.scopeError||'',/storage buffers|StorageBuffers|storage buffer/i);}
  else{assert(count<=16);assert.equal(r.pipelineError,undefined);assert.equal(r.scopeError,null);}
 }
 const report={pass:true,baseline,source:audit(__filename),inputs:stages.flatMap(s=>[s.input,s.shader]),...result};
 fs.writeFileSync(path.join(out,baseline?'hierarchy-bindings-baseline.json':'hierarchy-bindings.json'),JSON.stringify(report,null,2)+'\n');
 console.log({pass:true,baseline,limit:result.limit,results:result.results});
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
