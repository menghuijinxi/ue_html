'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=path.resolve(__dirname,'../../reference-engine/Engine/Platforms/Web/Build/WebGPUCommandStream.js');
function harness(enabled){
  const memory=new ArrayBuffer(65536),heap=new Float64Array(memory),calls=[],registry=new Map();
  const library={},context={LibraryManager:{library},mergeInto:Object.assign,HEAPF64:heap,HEAPU32:new Uint32Array(memory),
    WebGPU:{getJsObject:p=>{assert(registry.has(p));return registry.get(p);},IndexFormat:{1:'uint16'}},
    __webReuseReplayScratch:enabled};
  vm.runInNewContext(fs.readFileSync(source,'utf8'),context,{filename:source});
  const pipeline={name:'pipeline'},buffer={name:'buffer'},other={name:'nested-pipeline'};
  const pass={setPipeline:o=>calls.push(['pipeline',o]),setVertexBuffer:(slot,o,offset,size)=>calls.push(['vertex',slot,o,offset,size]),
    draw:(...a)=>calls.push(['draw',...a])};
  [[1,pass],[2,pipeline],[3,buffer],[4,other]].forEach(([k,v])=>registry.set(k,v));
  let next=0;
  function run(commands,objects){
    const base=next;next+=512;heap.set(commands,base);heap.set(objects,base+256);
    library.ueWGPUReplay(1,base*8,commands.length,(base+256)*8,objects.length,(base+384)*8);
  }
  return {context,calls,pass,pipeline,buffer,other,run};
}
const commands=[1,1,3,0,2,0,64,6,3,1,0,0,1,1];
for(const enabled of [false,true]){
  const h=harness(enabled);h.run(commands,[2,3]);
  assert.deepEqual(h.calls,[['pipeline',h.pipeline],['vertex',0,h.buffer,0,64],['draw',3,1,0,0],['pipeline',h.pipeline]]);
  h.calls.length=0;
  h.pass.draw=(...a)=>{h.calls.push(['draw',...a]);h.run([1,1],[4]);};
  h.run(commands,[2,3]);
  assert.deepEqual(h.calls,[['pipeline',h.pipeline],['vertex',0,h.buffer,0,64],['draw',3,1,0,0],['pipeline',h.other],['pipeline',h.pipeline]]);
  h.pass.setPipeline=()=>{throw Error('simulated validation failure');};
  assert.throws(()=>h.run([1,1],[2]),/validation failure/);
  if(enabled){
    assert.equal(h.context.__webReplayScratchStats.inUse,0);
    assert.equal(h.context.__webReplayScratchStats.allocations,2);
    assert(h.context.__webReplayScratchStats.reuses>=2);
    const pool=h.context.WebGPU.replayScratchPool;assert.equal(pool.length,2);
    assert(pool.every(a=>a.every(v=>v===null)),'No GPU object references may remain after replay or error');
  }
}
console.log(JSON.stringify({pass:true,checks:['same command order and resources','nested replay isolation','exception cleanup','bounded allocations','GPU references released']}));
