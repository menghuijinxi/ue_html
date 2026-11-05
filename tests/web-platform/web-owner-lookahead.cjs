'use strict';
// Diagnostic only: request one owner rAF while Game executes the current tick.
// Every delivered callback still requires an owner rAF. Never replay an already
// consumed tick or invoke a Game callback from a local timer/microtask.
module.exports=function installOwnerLookahead(target,beforeFrames){
  const request=target.requestAnimationFrame.bind(target),cancel=target.cancelAnimationFrame.bind(target);
  const pending=new Map();let reserved=null;
  const allocate=()=>{
    const item={ready:false,callback:null,id:0};
    item.id=request(time=>{
      item.ready=true;pending.delete(item.id);
      const callback=item.callback;item.callback=null;
      if(callback)callback(time);
    });
    pending.set(item.id,item);return item;
  };
  beforeFrames.push(()=>{if(!reserved)reserved=allocate();});
  target.requestAnimationFrame=callback=>{
    let item=reserved;reserved=null;
    // A permit received before a callback was requested may be stale (including
    // pause/resume). Drop it and wait for a fresh owner tick.
    if(!item||item.ready)item=allocate();
    item.callback=callback;return item.id;
  };
  target.cancelAnimationFrame=id=>{
    const item=pending.get(id);if(item)item.callback=null;
    pending.delete(id);cancel(id);
    if(reserved){pending.delete(reserved.id);cancel(reserved.id);reserved=null;}
  };
};
