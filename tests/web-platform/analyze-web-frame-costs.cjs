'use strict';
// Reanalyse an existing capture; never run profilers inside a normal FPS test.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [prefix,output]=process.argv.slice(2);assert(prefix&&output&&!fs.existsSync(output));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const targetsFile=prefix+'-targets.json',targets=read(targetsFile);
const api=/^(?:setVertexBuffer|setIndexBuffer|setBindGroup|setPipeline|draw|drawIndexed|drawIndirect|drawIndexedIndirect|dispatchWorkgroups|dispatchWorkgroupsIndirect|beginRenderPass|beginComputePass|createBindGroup|createBuffer|createTexture|createView|writeBuffer|writeTexture|submit|finish|end|copyBufferToBuffer|copyTextureToTexture|copyBufferToTexture|copyTextureToBuffer|setViewport|setScissorRect|setStencilReference|resolveQuerySet|pushDebugGroup|popDebugGroup|insertDebugMarker|executeBundles)$/;
const includes={drawBindings:/FWebGPUDynamicRHI::SetDrawBindings\(/,groups:/FWebGPUDynamicRHI::CreateGroups\(/,
 commandReplay:/^_ueWGPUReplay$/,syncProxy:/proxyToMainThread|proxy_sync/,dpiQuery:/FWebWindow::GetDPIScaleFactor/,
 windowSizeQuery:/FWebApplication::RefreshWindowSize/,rhiFlush:/FRDGBuilder::EndFlushResourcesRHI/};
const result={date:new Date().toISOString(),source:audit(__filename),targets:audit(targetsFile),threads:[],
 boundary:'Existing short Worker stack capture, not a new normal FPS measurement. Inclusive paths overlap. Exclusive categories count sampled leaf residence only, not exact instruction costs. Wasm leaf residence includes platform/backend code; JS/API residence includes browser frontend work, not just ABI overhead. Wasm-to-JS leaf samples miss inlined conversion and do not measure total crossing overhead. Browser GPU process and GPU time are outside this capture. Thread windows differ; do not add percentages or scale them into exact per-frame savings. No low-frame cause established by this capture.'};
for(let index=0;index<targets.length;index++){
 const file=prefix+'-'+index+'.cpuprofile',profile=read(file),nodes=new Map(profile.nodes.map(n=>[n.id,n])),parents=new Map();
 for(const node of profile.nodes)for(const child of node.children||[])parents.set(child,node.id);
 const names=profile.nodes.map(n=>n.callFrame.functionName).join('\n');
 const role=/FRHIThread::WebPump/.test(names)?'RHI':/EngineFrame\(void/.test(names)?'Game':/RenderingThreadMain|FRenderingThread::Run/.test(names)?'Render':null;
 if(!role)continue;
 const exclusive={},inclusive=Object.fromEntries(Object.keys(includes).map(k=>[k,0])),leafs=new Map();let duration=0;
 for(let k=0;k<profile.samples.length;k++){
  const id=profile.samples[k],us=profile.timeDeltas[k],frame=nodes.get(id).callFrame,name=frame.functionName,url=frame.url||'';duration+=us;
  const category=name==='(idle)'?'idle':/futex_wait/.test(name)?'futexWait':name==='(garbage collector)'?'garbageCollector':/^(?:wasm-to-js|js-to-wasm)/.test(name)?'visibleLanguageBoundary':url.startsWith('wasm:')?'wasmLeaf':api.test(name)&&!url?'webgpuApiLeaf':url.startsWith('http')?'scriptLeaf':'otherLeaf';
  exclusive[category]=(exclusive[category]||0)+us;
  const key=JSON.stringify([name,url]);leafs.set(key,(leafs.get(key)||0)+us);
  const stack=[];for(let c=id;c!==undefined;c=parents.get(c))stack.push(nodes.get(c).callFrame.functionName);
  for(const [key,pattern]of Object.entries(includes))if(stack.some(n=>pattern.test(n)))inclusive[key]+=us;
 }
 const metric=us=>({ms:us/1000,percent:us/duration*100});
 assert.equal(Object.values(exclusive).reduce((a,b)=>a+b,0),duration);
 result.threads.push({role,profile:audit(file),durationMs:duration/1000,exclusive:Object.fromEntries(Object.entries(exclusive).map(([k,v])=>[k,metric(v)])),
  inclusive:Object.fromEntries(Object.entries(inclusive).map(([k,v])=>[k,metric(v)])),
  topLeafs:[...leafs].map(([key,us])=>{const [name,url]=JSON.parse(key);return {name,url,...metric(us)};}).sort((a,b)=>b.ms-a.ms).slice(0,30)});
}
assert.deepEqual(result.threads.map(t=>t.role).sort(),['Game','RHI','Render']);
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
for(const t of result.threads)console.log(JSON.stringify({role:t.role,exclusive:t.exclusive,inclusive:t.inclusive}));
