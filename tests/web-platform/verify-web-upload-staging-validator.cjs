'use strict';
const vm=require('node:vm'),assert=require('node:assert/strict');
const install=require('./web-upload-staging-validator.cjs');
async function scenario(deferred,corrupt=false,missing=false){
  class Buffer {
    constructor(d){this.usage=d.usage;this.bytes=new Uint8Array(d.size);}
    mapAsync(){return Promise.resolve();} getMappedRange(){return this.bytes.buffer;} unmap(){} destroy(){}
  }
  class GPUDevice {createBuffer(d){return new Buffer(d);}}
  class GPUCommandEncoder {
    constructor(){this.operations=[];}
    copyBufferToBuffer(s,so,d,offset,n){this.operations.push(()=>{d.bytes.set(s.bytes.subarray(so,so+n),offset);if(corrupt&&d.usage===12)d.bytes[offset]^=1;});}
    finish(){return this.operations;}
  }
  class GPUQueue {
    writeBuffer(b,offset,data,start=0,size=data.byteLength-start){b.bytes.set(new Uint8Array(data.buffer||data,data.byteOffset+start||start,size),offset);}
    submit(commands){for(const c of commands)for(const f of c)f();}
  }
  const context={GPUDevice,GPUCommandEncoder,GPUQueue,GPUBufferUsage:{COPY_SRC:4,COPY_DST:8,MAP_READ:1},GPUMapMode:{READ:1},
    performance:{now:()=>performance.now()},setTimeout};
  vm.runInNewContext('('+install.toString()+')()',context);
  const device=new GPUDevice(),queue=new GPUQueue(),capture=context.__webValidateUploadCopies(2);
  const source=device.createBuffer({size:64,usage:12}),destination=device.createBuffer({size:64,usage:12});
  const encoder=new GPUCommandEncoder(),data=Uint8Array.from({length:24},(_,i)=>i*7+3);
  if(!deferred)queue.writeBuffer(source,8,data,0,8);
  encoder.copyBufferToBuffer(source,8,destination,0,8);
  if(!deferred)queue.writeBuffer(source,24,data,16,8);
  encoder.copyBufferToBuffer(source,24,destination,16,8);
  const commands=encoder.finish();
  if(deferred&&!missing)queue.writeBuffer(source,8,data);
  queue.submit([commands]);
  const result=await capture;assert.equal(result.completed,2);assert.equal(result.nonzeroOffsets,2);
  if(corrupt||missing)assert(result.errors.length>0);else assert.equal(result.errors.length,0,JSON.stringify(result));
  return result;
}
(async()=>{
  await scenario(false);await scenario(true);await scenario(true,true);await scenario(true,false,true);
  console.log(JSON.stringify({pass:true,checks:['individual writes','deferred covering write','copy corruption detected','missing write detected']}));
})().catch(e=>{console.error(e);process.exitCode=1;});
