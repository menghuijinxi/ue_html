'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
// Run only after the ordinary timing window. Never mix profiler timings into FPS.
module.exports=async function profileWorkers(context,prefix,seconds=8){
  const cdp=await context.browser().newBrowserCDPSession(),pending=new Map(),sessions=[];
  let next=0;
  cdp.on('Target.receivedMessageFromTarget',e=>{
    const m=JSON.parse(e.message),p=pending.get(m.id);
    if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}
  });
  const command=(sessionId,method,params={})=>new Promise((resolve,reject)=>{
    const id=++next;pending.set(id,{resolve,reject});
    cdp.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);
  });
  try{
    const {targetInfos}=await cdp.send('Target.getTargets');
    for(const target of targetInfos.filter(t=>t.type==='worker')){
      const {sessionId}=await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
      await command(sessionId,'Profiler.enable');
      await command(sessionId,'Profiler.setSamplingInterval',{interval:1000});
      await command(sessionId,'Profiler.start');sessions.push({target,sessionId});
    }
    assert(sessions.length);
    await new Promise(r=>setTimeout(r,seconds*1000));
    for(let i=0;i<sessions.length;i++){
      const {profile}=await command(sessions[i].sessionId,'Profiler.stop');
      fs.writeFileSync(prefix+'-'+i+'.cpuprofile',JSON.stringify(profile));
    }
    fs.writeFileSync(prefix+'-targets.json',JSON.stringify(sessions,null,2));
    return sessions.map((s,i)=>({target:s.target,file:prefix+'-'+i+'.cpuprofile'}));
  }finally{await cdp.detach();}
};
