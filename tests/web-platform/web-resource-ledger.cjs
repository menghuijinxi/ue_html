'use strict';
// Logical API allocation estimates. Weak refs avoid retaining released resources.
module.exports = function installResourceLedger() {
  const entries = [], unknown = new Set();
  const plain = {r8unorm:1,r8snorm:1,r8uint:1,r8sint:1,r16float:2,r16unorm:2,r16uint:2,r16sint:2,
    rg8unorm:2,rg8uint:2,rg16float:4,rg16unorm:4,rg16uint:4,r32float:4,r32uint:4,r32sint:4,
    rgba8unorm:4,'rgba8unorm-srgb':4,bgra8unorm:4,'bgra8unorm-srgb':4,rgba8uint:4,rgba8snorm:4,
    rg32float:8,rg32uint:8,rgba16float:8,rgba16unorm:8,rgba16uint:8,rgba32float:16,rgba32uint:16,
    rg11b10ufloat:4,rgb10a2unorm:4,depth16unorm:2,depth32float:4,depth24plus:4,'depth24plus-stencil8':4};
  for (const [type, method] of [['texture','createTexture'],['buffer','createBuffer']]) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(desc) {
      const resource = original.call(this,desc);
      let bytes = type === 'buffer' ? resource.size : 0;
      if (type === 'texture') {
        const format=resource.format, bc=/^bc([1-7])/.exec(format), block=bc ? ([1,4].includes(+bc[1])?8:16) : plain[format];
        if (!block) unknown.add(format);
        for(let mip=0;mip<resource.mipLevelCount;mip++) {
          const w=Math.max(1,resource.width>>mip),h=Math.max(1,resource.height>>mip);
          const d=resource.dimension==='3d'?Math.max(1,resource.depthOrArrayLayers>>mip):resource.depthOrArrayLayers;
          bytes+=(bc?Math.ceil(w/4)*Math.ceil(h/4):w*h)*d*(block||0)*resource.sampleCount;
        }
      }
      entries.push({ref:new WeakRef(resource),type,label:desc.label||'(unlabelled)',bytes,
        format:type==='texture'?resource.format:undefined,
        width:type==='texture'?resource.width:undefined,height:type==='texture'?resource.height:undefined,
        depthOrArrayLayers:type==='texture'?resource.depthOrArrayLayers:undefined,
        mipLevelCount:type==='texture'?resource.mipLevelCount:undefined,
        usage:resource.usage,created:performance.now(),destroyed:false});
      const entry=entries.at(-1),destroy=resource.destroy.bind(resource);
      resource.destroy=()=>{entry.destroyed=true;return destroy();};
      return resource;
    };
  }
  globalThis.__webResourceLedger = () => {
    const live=entries.filter(e=>!e.destroyed&&e.ref.deref()).map(({ref,...e})=>e);
    const group = key => Object.fromEntries([...new Set(live.map(e=>e[key]||e.type))].map(value=>{
      const items=live.filter(e=>(e[key]||e.type)===value);
      return [value,{count:items.length,bytes:items.reduce((sum,e)=>sum+e.bytes,0)}];
    }));
    return {logical:true,physicalVRAM:false,totalCreated:entries.length,unknownFormats:[...unknown],
      textures:live.filter(e=>e.type==='texture').length,buffers:live.filter(e=>e.type==='buffer').length,
      textureBytes:live.filter(e=>e.type==='texture').reduce((s,e)=>s+e.bytes,0),
      bufferBytes:live.filter(e=>e.type==='buffer').reduce((s,e)=>s+e.bytes,0),
      byFormat:group('format'),byLabel:group('label'),top:live.sort((a,b)=>b.bytes-a.bytes).slice(0,60)};
  };
};
