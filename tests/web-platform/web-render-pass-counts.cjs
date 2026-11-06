'use strict';
module.exports=function installRenderPassCounts(){
  const stats=globalThis.__webRenderPassCounts={},passes=new WeakMap(),views=new WeakMap();
  const view=GPUTexture.prototype.createView;
  GPUTexture.prototype.createView=function(...args){const v=view.apply(this,args);views.set(v,this.label||'unnamed');return v;};
  const begin=GPUCommandEncoder.prototype.beginRenderPass,end=GPURenderPassEncoder.prototype.end;
  GPUCommandEncoder.prototype.beginRenderPass=function(d){
    const colors=Array.from(d.colorAttachments||[]).filter(Boolean),depth=d.depthStencilAttachment;
    const key=colors.map(a=>views.get(a.view)||'?').join(',')+'|'+(views.get(depth?.view)||'-');
    const effect=colors.some(a=>a.loadOp!=='load'||a.storeOp!=='store'||a.resolveTarget)||
      (depth&&((!depth.depthReadOnly&&(depth.depthLoadOp!=='load'||depth.depthStoreOp!=='store'))||
        (!depth.stencilReadOnly&&depth.stencilLoadOp!==undefined&&(depth.stencilLoadOp!=='load'||depth.stencilStoreOp!=='store'))))||!!d.timestampWrites;
    const p=begin.call(this,d);passes.set(p,{key,effect,draws:0,queries:0});return p;
  };
  for(const name of ['draw','drawIndexed','drawIndirect','drawIndexedIndirect','executeBundles','beginOcclusionQuery']) {
    const original=GPURenderPassEncoder.prototype[name];
    GPURenderPassEncoder.prototype[name]=function(...args){const p=passes.get(this);if(p)++p[name==='beginOcclusionQuery'?'queries':'draws'];return original.apply(this,args);};
  }
  GPURenderPassEncoder.prototype.end=function(){
    const p=passes.get(this);if(p&&globalThis.__clockMotionFrames.active){
      const s=stats[p.key]||={passes:0,draws:0,queries:0,emptyLoad:0,emptyEffect:0};
      ++s.passes;s.draws+=p.draws;s.queries+=p.queries;
      if(!p.draws&&!p.queries)++s[p.effect?'emptyEffect':'emptyLoad'];
    }
    return end.call(this);
  };
};
