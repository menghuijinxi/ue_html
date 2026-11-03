'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const prefix=process.argv[2];assert(prefix);
const targets=JSON.parse(fs.readFileSync(prefix+'-targets.json','utf8'));
const report={profiles:[],boundary:'Statistical wall-clock stack sampling. Inclusive values overlap; idle, futex and CPU compute are distinct. FPS from these captures is not the normal benchmark.'};
for(let i=0;i<targets.length;i++){
  const file=prefix+'-'+i+'.cpuprofile',p=JSON.parse(fs.readFileSync(file,'utf8'));
  const nodes=new Map(p.nodes.map(n=>[n.id,n])),parent=new Map(),self=new Map(),total=new Map();
  for(const n of p.nodes)for(const child of n.children||[])parent.set(child,n.id);
  let duration=0;
  const categories={idle:0,mutexWait:0,conditionWait:0,allocationPath:0,allocationMutexWait:0,groupPreparation:0,resourceCommit:0,dynamicCommandReplay:0,proxyPath:0,bindings:0,vertexBindingBridge:0,waitForRHIFlush:0};
  for(let k=0;k<p.samples.length;k++){
    const id=p.samples[k],us=p.timeDeltas[k];duration+=us;self.set(id,(self.get(id)||0)+us);
    for(let c=id;c!==undefined;c=parent.get(c))total.set(c,(total.get(c)||0)+us);
    const stack=[];for(let c=id;c!==undefined;c=parent.get(c))stack.push(nodes.get(c).callFrame.functionName);
    const text=stack.join('\n');
    if(stack[0]==='(idle)')categories.idle+=us;
    if(/_do_futex_wait/.test(stack[0])&&/mutex.*lock/.test(text))categories.mutexWait+=us;
    if(/_do_futex_wait/.test(stack[0])&&!/mutex.*lock/.test(text))categories.conditionWait+=us;
    if(/FMemory::(Malloc|Realloc|Free)|emscripten_builtin_(malloc|free)/.test(text))categories.allocationPath+=us;
    if(/_do_futex_wait/.test(stack[0])&&/mutex.*lock/.test(text)&&/FMemory::(Malloc|Realloc|Free)|emscripten_builtin_(malloc|free)/.test(text))categories.allocationMutexWait+=us;
    if(/FWebGPUDynamicRHI::CreateGroups/.test(text))categories.groupPreparation+=us;
    if(/FWebGPUDynamicRHI::CommitShaderResources/.test(text))categories.resourceCommit+=us;
    if(/_ueWGPUReplay/.test(text))categories.dynamicCommandReplay+=us;
    if(/proxy_sync|proxyToMainThread/.test(text))categories.proxyPath+=us;
    if(/SetDrawBindings/.test(text))categories.bindings+=us;
    if(/SetVertexBuffer|setVertexBuffer/.test(text))categories.vertexBindingBridge+=us;
    if(/EndFlushResourcesRHI/.test(text)&&/_do_futex_wait/.test(stack[0]))categories.waitForRHIFlush+=us;
  }
  const rank=m=>[...m].map(([id,us])=>({id,name:nodes.get(id).callFrame.functionName,ms:us/1000,percent:us/duration*100})).sort((a,b)=>b.ms-a.ms);
  const names=p.nodes.map(n=>n.callFrame.functionName).join('\n');
  const role=/FRHIThread::WebPump/.test(names)?'RHI':/EngineFrame\(void/.test(names)?'Game':/RenderingThreadMain|FRenderingThread::Run/.test(names)?'Render':'Task/IO/auxiliary';
  const waits=rank(self).filter(x=>/futex|mutex|idle|malloc|free/i.test(x.name)).slice(0,20).map(x=>{
    const stack=[];for(let c=x.id;c!==undefined;c=parent.get(c))stack.push(nodes.get(c).callFrame.functionName);
    return {...x,stack};
  });
  report.profiles.push({file,target:targets[i].target,role,durationMs:duration/1000,
    categories:Object.fromEntries(Object.entries(categories).map(([k,us])=>[k,{ms:us/1000,percent:us/duration*100}])),
    self:rank(self).slice(0,30),inclusive:rank(total).slice(0,50),waits});
}
fs.writeFileSync(prefix+'-analysis.json',JSON.stringify(report,null,2));
for(const p of report.profiles)if(p.role!=='Task/IO/auxiliary')console.log(JSON.stringify({role:p.role,file:p.file,self:p.self.slice(0,12),waits:p.waits.slice(0,6)}));
