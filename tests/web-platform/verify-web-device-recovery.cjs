'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'web-engine-host.js'),'utf8');
function create(recovery={}){
  const sessions=[],failures=[],timers=new Map(),listeners=new Map();let sequence=0;
  const env=vm.createContext({console,structuredClone,performance:{now:()=>sequence},CustomEvent,
    setTimeout:fn=>{timers.set(++sequence,fn);return sequence;},clearTimeout:id=>timers.delete(id),
    addEventListener(){},removeEventListener(){},document:{dispatchEvent(){},pointerLockElement:null,hidden:false,
      addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
  });
  vm.runInContext(source,env);
  env.startWebEngineSession=options=>{
    const session={options,disposed:false,dispose(){this.disposed=true;},rpc:async()=>1};
    sessions.push(session);return session;
  };
  const canvas=()=>({cloneNode:()=>canvas(),replaceWith(){}});
  const handle=env.startWebEngineWorker({module:{canvas:canvas()},record(){},failed:(...v)=>failures.push(v),
    stage(){},diagnostics:{},render(){},recovery});
  return {env,sessions,failures,timers,handle,listeners};
}
(async()=>{
  let restored;
  const a=create({capture:()=>({asset:'mesh',transform:[1,2,3]}),restore:async data=>{restored=data;}});
  await a.sessions[0].options.onReady(a.sessions[0].rpc);
  a.env.__webRecoveryCamera={version:1,args:[1,2,3,4,5,6,90,0]};a.env.__webEngineFrames=100;
  a.sessions[0].options.onDeviceLost({reason:'unknown',message:'lost'});
  assert(a.sessions[0].disposed);assert.equal(a.sessions.length,2);assert.equal(a.env.__webEngineFrames,undefined);
  const calls=[];await a.sessions[1].options.onReady(async(...v)=>{calls.push(v);return 1;});
  assert.equal(a.handle.state.phase,'running');assert.equal(a.handle.state.attempts,1);
  assert.deepEqual(calls,[['WebRestoreCamera',1,2,3,4,5,6,90,0]]);assert.deepEqual(restored,{asset:'mesh',transform:[1,2,3]});
  // No late notification from a disposed generation may restart the engine.
  a.sessions[0].options.onDeviceLost({reason:'unknown'});await a.sessions[0].options.onReady(()=>{throw Error('stale RPC');});
  a.sessions[0].options.failed('late failure');
  assert.equal(a.sessions.length,2);assert.equal(a.handle.state.phase,'running');
  a.sessions[1].options.onDeviceLost({reason:'unknown'});assert.equal(a.sessions.length,3);
  a.sessions[2].options.onDeviceLost({reason:'unknown'});
  assert.equal(a.handle.state.phase,'failed');assert.equal(a.sessions.length,3);assert.equal(a.failures.length,1);assert.equal(a.timers.size,0);
  assert(a.sessions.every(s=>s.disposed));
  const b=create();b.sessions[0].options.failed('GPU validation error',{kind:'engine-worker'});
  assert.equal(b.handle.state.attempts,0);assert.equal(b.handle.state.phase,'failed');assert.equal(b.failures.length,1);
  const c=create({capture:()=>()=>{}});await c.sessions[0].options.onReady(c.sessions[0].rpc);
  c.sessions[0].options.onDeviceLost({reason:'unknown'});assert.equal(c.handle.state.phase,'failed');assert.equal(c.sessions.length,1);
  const d=create();d.handle.dispose();await d.sessions[0].options.onReady(d.sessions[0].rpc);
  d.sessions[0].options.onDeviceLost({reason:'unknown'});assert.equal(d.handle.state.phase,'closed');assert.equal(d.sessions.length,1);assert.equal(d.timers.size,0);
  const e=create();assert.equal(e.timers.size,0,'cold startup must not inherit the recovery deadline');
  await e.sessions[0].options.onReady(e.sessions[0].rpc);e.env.document.hidden=true;
  e.sessions[0].options.onDeviceLost({reason:'unknown'});assert.equal(e.timers.size,0,'hidden recovery must not time out');
  e.env.document.hidden=false;e.listeners.get('visibilitychange')();assert.equal(e.timers.size,1);
  [...e.timers.values()][0]();assert.equal(e.handle.state.phase,'failed');assert(e.sessions[1].disposed);
  const f=create({restore:async()=>{throw Error('restore failed');}});await f.sessions[0].options.onReady(f.sessions[0].rpc);
  f.sessions[0].options.onDeviceLost({reason:'unknown'});await f.sessions[1].options.onReady(f.sessions[1].rpc);
  assert.equal(f.handle.state.phase,'failed');assert.equal(f.failures[0][1].kind,'device-recovery-restore');
  console.log('PASS: checkpoint restoration, stale generations, bounded retries, ordinary errors, invalid checkpoints, shutdown, timeout and failed restore');
})().catch(e=>{console.error(e);process.exitCode=1;});
