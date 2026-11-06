'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'web-engine-host.js'),'utf8');
function setup(budget){
  const frames=new Map(),listeners=new Map(),delivered=[];let sequence=0,now=0;
  class MessageChannel{
    constructor(){
      const a={close(){}},b={close(){}};
      a.postMessage=data=>b.onmessage?.({data});b.postMessage=data=>a.onmessage?.({data});
      this.port1=a;this.port2=b;
    }
  }
  const document={hidden:false,addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)};
  const c=vm.createContext({MessageChannel,document,SharedArrayBuffer,Int32Array,Atomics,
    performance:{timeOrigin:1000,now:()=>now},requestAnimationFrame:f=>{frames.set(++sequence,f);return sequence;},
    cancelAnimationFrame:id=>frames.delete(id)});
  vm.runInContext(source,c);
  const clock=c.createWebGameFrameClock(budget,e=>{throw Error(e)}),state=new Int32Array(clock.transfer.state);
  clock.transfer.port.onmessage=({data})=>delivered.push(data);
  const send=data=>clock.transfer.port.postMessage(data);
  const tick=time=>{now=time;const callbacks=[...frames.values()];frames.clear();callbacks.forEach(f=>f(time));};
  const visibility=hidden=>{document.hidden=hidden;listeners.get('visibilitychange')();};
  send({type:'ready',bootstrap:1});
  return {clock,state,send,tick,visibility,delivered,frames,advance:t=>{now=t;}};
}
for(const budget of [1,2,3,4]){
  const s=setup(budget);
  Atomics.store(s.state,0,1);
  Atomics.store(s.state,1,1);
  for(let id=2;id<=budget+1;++id){s.send({type:'request',id});s.tick(id*10);Atomics.store(s.state,1,s.state[2]);}
  assert.equal(s.delivered.length,budget);
  assert.equal(s.state[2]-s.state[0],budget);
  s.send({type:'request',id:budget+2});s.tick(100);
  assert.equal(s.delivered.length,budget,'No credit: no Game frame');
  s.advance(180);Atomics.store(s.state,0,2);s.clock.gpuCompleted();
  assert.equal(s.delivered.length,budget,'Completion cannot reuse the old display tick');
  s.tick(200);
  assert.equal(s.delivered.length,budget+1);assert.equal(s.delivered.at(-1).timestamp,1200);
  assert.equal(s.state[5],budget,'Reservations include not-yet-submitted Game/Render work');
  Atomics.store(s.state,1,s.state[2]);
  s.send({type:'request',id:budget+3});
  s.visibility(true);Atomics.store(s.state,0,s.state[2]);s.clock.gpuCompleted();s.tick(300);
  assert.equal(s.delivered.length,budget+1,'Hidden page cannot spend a returned credit');
  s.visibility(false);assert.equal(s.delivered.length,budget+1);s.tick(400);
  assert.equal(s.delivered.length,budget+2);assert.equal(s.delivered.at(-1).timestamp,1400);
  s.send({type:'request',id:budget+4});s.send({type:'cancel',id:budget+4});s.tick(500);
  assert.equal(s.delivered.length,budget+2,'Cancelling a pending request does not consume a credit');
  s.send({type:'request',id:budget+5});Atomics.store(s.state,0,s.state[2]);Atomics.store(s.state,1,s.state[2]);s.tick(600);
  const reserved=s.state[2];s.send({type:'cancel',id:budget+5});s.send({type:'cancel',id:budget+5});
  assert.equal(s.state[2],reserved-1,'Cancellation returns an issued credit once');
  s.send({type:'request',id:budget+6});s.clock.dispose();s.tick(700);
  assert.equal(s.delivered.length,budget+3,'Disposed clock cannot issue another frame');
}
{
  const s=setup(4);s.state[0]=s.state[1]=1;
  s.send({type:'request',id:2});s.tick(10);
  s.send({type:'request',id:3});s.tick(20);
  s.send({type:'request',id:4});s.tick(30);
  assert.equal(s.delivered.length,2,'GPU credits cannot bypass the RHI plus Game/Render limit');
  s.state[1]=2;s.advance(32);s.clock.ownerSubmitted();
  assert.equal(s.delivered.length,3,'Owner acknowledgement can consume the current unspent tick');
  s.state[1]=3;s.send({type:'request',id:5});s.clock.ownerSubmitted();s.clock.gpuCompleted();
  assert.equal(s.delivered.length,3,'Multiple notifications cannot spend a tick twice');
  s.tick(40);assert.equal(s.delivered.length,4);s.clock.dispose();
}
console.log('Frame credits: owner acknowledgement, bounded reservations, stale ticks, delayed feedback, cancellation, visibility and disposal passed');
