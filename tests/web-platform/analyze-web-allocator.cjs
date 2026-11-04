'use strict';
// Statistical wall-clock samples, not allocation-event counts or GPU timings.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {audit}=require('./content-file-metadata.cjs');
const prefix=process.argv[2];assert(prefix);
const targets=JSON.parse(fs.readFileSync(prefix+'-targets.json','utf8'));
const allocation=/FMalloc(?:ThreadSafeProxy|Ansi|PoisonProxy)::|FMemory::(?:Malloc|Realloc|Free)|Ansi(?:Malloc|Realloc|Free)|(?:emscripten_builtin_|dl)(?:malloc|free|realloc)|malloc_usable_size|(?:^|\n)_?mi_/;
const report={source:audit(__filename),targets:audit(prefix+'-targets.json'),profiles:[],boundary:'Sampled stack residence, including waits. No exact malloc/free count. Worker capture intervals differ; percentages use each worker own duration. Categories overlap and cannot be summed into a frame time. Profiling is separate from normal FPS measurement.'};
for(let i=0;i<targets.length;i++){
 const file=prefix+'-'+i+'.cpuprofile',p=JSON.parse(fs.readFileSync(file,'utf8'));
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),parent=new Map();for(const n of p.nodes)for(const c of n.children||[])parent.set(c,n.id);
 const counters={allocation:0,allocatorProxy:0,allocatorProxyWait:0,underlyingAllocatorWait:0,allMutexWait:0,idle:0},sites=new Map();let duration=0;
 for(let j=0;j<p.samples.length;j++){
  const stack=[];for(let c=p.samples[j];c!==undefined;c=parent.get(c))stack.push(nodes.get(c).callFrame.functionName);
  const text=stack.join('\n'),us=p.timeDeltas[j];duration+=us;
  const isAlloc=allocation.test(text),proxy=/FMallocThreadSafeProxy::/.test(text),wait=/futex_wait/.test(stack[0])&&/mutex.*lock/.test(text);
  if(isAlloc)counters.allocation+=us;if(proxy)counters.allocatorProxy+=us;if(wait)counters.allMutexWait+=us;
  if(proxy&&wait)counters.allocatorProxyWait+=us;
  if(wait&&/(?:emscripten_builtin_|dl)(?:malloc|free|realloc)|(?:^|\n)_?mi_/.test(text))counters.underlyingAllocatorWait+=us;
  if(stack[0]==='(idle)')counters.idle+=us;
  if(isAlloc){const index=stack.findLastIndex(n=>allocation.test(n));const site=stack[index+1]||'(unknown caller)';sites.set(site,(sites.get(site)||0)+us);}
 }
 const names=p.nodes.map(n=>n.callFrame.functionName).join('\n'),role=/FRHIThread::WebPump/.test(names)?'RHI':/EngineFrame\(void/.test(names)?'Game':/RenderingThreadMain|FRenderingThread::Run/.test(names)?'Render':'Task/IO/auxiliary';
 report.profiles.push({file:audit(file),role,durationMs:duration/1000,categories:Object.fromEntries(Object.entries(counters).map(([k,v])=>[k,{ms:v/1000,percent:v/duration*100}])),sites:[...sites].map(([caller,us])=>({caller,ms:us/1000,percent:us/duration*100})).sort((a,b)=>b.ms-a.ms).slice(0,15)});
}
fs.writeFileSync(prefix+'-allocator-analysis.json',JSON.stringify(report,null,2)+'\n');
for(const p of report.profiles)if(p.role!=='Task/IO/auxiliary')console.log(JSON.stringify({role:p.role,categories:p.categories,sites:p.sites.slice(0,5)}));
