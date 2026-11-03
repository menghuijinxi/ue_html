'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const [prefix,output]=process.argv.slice(2);assert(prefix&&output&&!fs.existsSync(output));
const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const targets=read(prefix+'-targets.json');
const patterns={tick:/FWebGPUDynamicRHI::RHITick\(/,proxy:/proxy_sync|proxyToMainThread/,
 groups:/FWebGPUDynamicRHI::CreateGroups\(/,drawBindings:/FWebGPUDynamicRHI::SetDrawBindings\(/,
 jsonStorage:/FWebGPUDynamicRHI::ValidateStorage(?:SRV|UAV)Binding\(.*FJsonObject/,
 nativeStorage:/FWebGPUDynamicRHI::ValidateStorage(?:SRV|UAV)Binding\(.*FWebGPUStorageContract/,
 bufferShape:/FWebGPUDynamicRHI::ValidateBufferSRV\(/,jsonLookup:/FindIndexByHash<.*TStringView/,
 access:/FWebGPUDynamicRHI::ValidateAccess\(/,commandReplay:/^_ueWGPUReplay$/};
const result={date:new Date().toISOString(),source:audit(__filename),targets:audit(prefix+'-targets.json'),threads:[],
 boundary:'Separate short sampled Worker stacks. Inclusive metrics overlap; percentages use each thread capture duration and cannot be added or converted to exact saved frame milliseconds. This capture excludes browser GPU process and GPU execution. Normal FPS is measured separately.'};
for(let index=0;index<targets.length;index++){
 const file=prefix+'-'+index+'.cpuprofile',p=read(file),nodes=new Map(p.nodes.map(n=>[n.id,n])),parents=new Map();
 for(const n of p.nodes)for(const child of n.children||[])parents.set(child,n.id);
 const names=p.nodes.map(n=>n.callFrame.functionName).join('\n');
 const role=/FRHIThread::WebPump/.test(names)?'RHI':/EngineFrame\(void/.test(names)?'Game':/RenderingThreadMain|FRenderingThread::Run/.test(names)?'Render':null;
 if(!role)continue;
 const inclusive=Object.fromEntries(Object.keys(patterns).map(k=>[k,0]));let duration=0;
 for(let sample=0;sample<p.samples.length;sample++){
  const us=p.timeDeltas[sample];duration+=us;const stack=[];
  for(let id=p.samples[sample];id!==undefined;id=parents.get(id))stack.push(nodes.get(id).callFrame.functionName);
  for(const [key,pattern]of Object.entries(patterns))if(stack.some(name=>pattern.test(name)))inclusive[key]+=us;
 }
 result.threads.push({role,profile:audit(file),durationMs:duration/1000,inclusive:Object.fromEntries(Object.entries(inclusive).map(([k,us])=>[k,{ms:us/1000,percent:us/duration*100}]))});
}
assert.deepEqual(result.threads.map(t=>t.role).sort(),['Game','RHI','Render']);
fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result.threads.map(t=>({role:t.role,inclusive:t.inclusive}))));
