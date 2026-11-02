'use strict';
// Low overhead diagnostic: rare object creation calls plus one record per frame.
// No per-draw wrappers, timestamp queries, GPU fences, or project setting changes.
module.exports = function installStutterObserver() {
  const state = globalThis.__webStutters = {active:false, frames:[], events:[], counts:{}, errors:[],
    asyncPipelines:{completed:0,failed:0,reasons:[]}};
  const requestAdapter = GPU.prototype.requestAdapter;
  GPU.prototype.requestAdapter = async function(...args) {
    const adapter = await requestAdapter.apply(this,args);
    if(adapter) state.adapter = {...adapter.info, vendor:adapter.info?.vendor, architecture:adapter.info?.architecture,
      device:adapter.info?.device, description:adapter.info?.description};
    return adapter;
  };
  const pipelineMethods = ['createRenderPipeline','createComputePipeline','createRenderPipelineAsync','createComputePipelineAsync','createShaderModule'];
  for (const name of [...pipelineMethods,'createBuffer','createTexture']) {
    const original = GPUDevice.prototype[name];
    if (!original) continue;
    GPUDevice.prototype[name] = function(...args) {
      const start = performance.now();
      try {
        const result = original.apply(this,args);
        if(name.endsWith('PipelineAsync')) result.then(()=>state.asyncPipelines.completed++,error=>{
          state.asyncPipelines.failed++;
          if(state.asyncPipelines.reasons.length<12) state.asyncPipelines.reasons.push({label:args[0]?.label,message:error.message});
        });
        return result;
      }
      finally {
        const end = performance.now();
        state.counts[name]=(state.counts[name]||0)+1;
        if (state.active && (pipelineMethods.includes(name) || end-start>1)) state.events.push({name,start,end,ms:end-start,label:args[0]?.label});
      }
    };
  }
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this,args);
    device.addEventListener('uncapturederror',event => state.errors.push(event.error.message));
    return device;
  };
  let frame=0, previous;
  Object.defineProperty(globalThis,'__webRHIFrames',{configurable:true,enumerable:true,get:()=>frame,set(next){
    if (next<=frame) return;
    const now=performance.now();
    if(state.active && previous!==undefined) {
      const stages=globalThis.__webThreadStages, io=globalThis.__webContentIO;
      const interval=now-previous;
      state.frames.push({frame:next,time:now,ms:interval,rhiTotal:stages?.rhiWorkMilliseconds,
        game:globalThis.__webEngineFrames,gameMs:globalThis.__webThreadFrameTimes?.at(-1),stages:{...stages},
        camera:globalThis.__webDefaultCamera,counts:{...state.counts},
        io:{...io?.stats,activeRequests:io?.requests?.size},pso:globalThis.__webOptimizationRHI,
        streaming:globalThis.__webTextureStreaming});
      if(interval>50) performance.mark('UE long frame '+next+' '+interval.toFixed(1)+'ms');
    }
    previous=now;frame=next;
  }});
  globalThis.__webBeginStutterCapture = () => {state.frames=[];state.events=[];state.active=true;};
  globalThis.__webEndStutterCapture = () => {state.active=false;return state;};
};
