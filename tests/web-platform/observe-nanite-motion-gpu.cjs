'use strict';
// Diagnostic only. Timestamp existing passes during the reproduced interior
// segment; resolve in the same encoder, without changing submission ordering.
module.exports = function observeMotionGPU({start = 28, end = 41} = {}) {
  const state = globalThis.__motionGPU = {results: [], errors: [], pending: 0, shaders:{}, pipelines:{}, markers:{}, pipelineCreations:[], startupPipelines:[], slowCalls:[], window:{start,end}};
  const elapsedNow=()=>{const c=globalThis.__naniteOffFrames;return c?.active&&c.times.length?performance.now()-c.times[0]:-1;};
  const encoders = new WeakMap(), commands = new WeakMap(), passes = new WeakMap(), views = new WeakMap();
  const shaders = new WeakMap(), pipelines = new WeakMap();
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const result = createView.apply(this, args); views.set(result, this.label); return result;
  };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(desc) {
    if (!this.features.has('timestamp-query')) throw Error('Timestamp queries unavailable');
    const device = await request.call(this, {...desc,
      requiredFeatures: [...new Set([...(desc.requiredFeatures || []), 'timestamp-query'])]});
    const shader = device.createShaderModule.bind(device);
    device.createShaderModule = d => {const elapsed=elapsedNow(),before=performance.now(),result=shader(d),ms=performance.now()-before;
      if(elapsed>=0&&ms>=1)state.slowCalls.push({kind:'createShaderModule',elapsed,ms,label:d.label,codeBytes:d.code.length});
      shaders.set(result,d.code);return result;};
    for(const name of ['createBuffer','createTexture']){
      const original=device[name].bind(device);device[name]=d=>{const elapsed=elapsedNow(),before=performance.now(),result=original(d),ms=performance.now()-before;
        if(elapsed>=0&&ms>=1)state.slowCalls.push({kind:name,elapsed,ms,label:d.label,size:d.size,usage:d.usage});return result;};
    }
    for (const name of ['createRenderPipeline','createRenderPipelineAsync','createComputePipeline','createComputePipelineAsync']) {
      const original = device[name].bind(device);
      const remember = (p,d) => {pipelines.set(p,d);
        const code=[d.compute,d.vertex,d.fragment].filter(Boolean).map(s=>shaders.get(s.module)||'').join('\n');
        state.markers[p.label]=['WebHierarchyBatchData','WebCullLODMode','WebOcclusionBatchData','WebOcclusionPrevious','WebRasterClusterKeys','WebNativeMaterial','WebMaterialTile'].filter(s=>code.includes(s));
        return p;};
      device[name] = d => {const elapsed=elapsedNow(),before=performance.now(),record={kind:name,elapsed,time:before,label:d.label};
        (elapsed>=0?state.pipelineCreations:state.startupPipelines).push(record);
        const result=original(d);if(record)record.requestMs=performance.now()-before;
        if(name.endsWith('Async'))return result.then(p=>{if(record)record.completionMs=performance.now()-before;return remember(p,d);},e=>{if(record)record.error=String(e);throw e;});
        if(record)record.completionMs=performance.now()-before;return remember(result,d);};
    }
    const create = device.createCommandEncoder.bind(device);
    device.createCommandEncoder = desc => {
      const encoder = create(desc), capture = globalThis.__naniteOffFrames;
      const elapsed = capture?.times.length ? performance.now() - capture.times[0] : -1;
      if (capture?.active && elapsed >= start * 1000 && elapsed <= end * 1000)
        encoders.set(encoder, {device, frame:globalThis.__webRHIFrames, time:performance.now(), elapsed, passes:[], indirect:[]});
      return encoder;
    };
    const submit = device.queue.submit.bind(device.queue);
    device.queue.submit = buffers => {
      const list = Array.from(buffers), result = submit(list);
      for (const buffer of list) {
        const record = commands.get(buffer); if (!record) continue;
        commands.delete(buffer); state.pending++;
        record.readback.mapAsync(GPUMapMode.READ).then(() => {
          const mapped = record.readback.getMappedRange();
          const words = new BigUint64Array(mapped);
          const args = new Uint32Array(mapped,record.queryBytes);
          state.results.push({frame:record.frame, time:record.time, elapsed:record.elapsed,
            indirect:record.indirect.map((d,i)=>({label:d.buffer.label,offset:d.offset,words:Array.from(args.subarray(i*5,i*5+5))})),
            passes:record.passes.map((p,i) => ({...p, ns:Number(words[2*i+1]-words[2*i]),
              start:words[2*i].toString(), end:words[2*i+1].toString()}))});
          record.readback.unmap();
        }).catch(e => state.errors.push(String(e))).finally(() => {
          record.readback.destroy(); record.resolve.destroy(); record.queries.destroy(); state.pending--;
        });
      }
      return result;
    };
    return device;
  };
  for (const name of ['beginRenderPass','beginComputePass']) {
    const begin = GPUCommandEncoder.prototype[name];
    GPUCommandEncoder.prototype[name] = function(desc = {}) {
      const record = encoders.get(this); if (!record) return begin.call(this, desc);
      if (desc.timestampWrites || record.passes.length >= 2048) throw Error('Timestamp capture conflict/capacity');
      record.queries ??= record.device.createQuerySet({type:'timestamp',count:4096});
      const index = record.passes.length * 2;
      const attachment = desc.colorAttachments?.find(Boolean)?.view || desc.depthStencilAttachment?.view;
      const entry = {kind:name, label:desc.label || views.get(attachment) || '', pipelines:[], draws:0, indices:0, dispatches:0, indirect:[]};
      record.passes.push(entry);
      const pass = begin.call(this, {...desc, timestampWrites:{querySet:record.queries,
        beginningOfPassWriteIndex:index, endOfPassWriteIndex:index+1}});
      passes.set(pass, {entry,record}); return pass;
    };
  }
  for (const proto of [GPURenderPassEncoder.prototype, GPUComputePassEncoder.prototype]) {
    for (const name of ['setPipeline','draw','drawIndexed','drawIndirect','drawIndexedIndirect','dispatchWorkgroups','dispatchWorkgroupsIndirect']) {
      const original = proto[name]; if (!original) continue;
      proto[name] = function(...args) {
        const context = passes.get(this), p = context?.entry;
        if (p) {
          if (name === 'setPipeline') {
            if (!p.pipelines.includes(args[0].label)) p.pipelines.push(args[0].label);
            context.pipeline = args[0].label;
            if (p.label === 'WebCubeShadowFace') {
              const desc = pipelines.get(args[0]);
              if (desc && !state.pipelines[args[0].label]) {
                state.pipelines[args[0].label] = {vertex:{entry:desc.vertex.entryPoint,buffers:desc.vertex.buffers},
                  fragment:desc.fragment?.entryPoint,primitive:desc.primitive,depthStencil:desc.depthStencil};
                for (const stage of [desc.vertex,desc.fragment]) if (stage)
                  state.shaders[stage.entryPoint] = shaders.get(stage.module);
              }
            }
          }
          else if (name.startsWith('draw')) {
            p.draws++; if (name === 'draw' || name === 'drawIndexed') p.indices += args[0] * (args[1] ?? 1);
            if (p.label === 'WebCubeShadowFace' && name === 'drawIndexedIndirect') {
              const record = context.record;
              if (!(args[0].usage & GPUBufferUsage.COPY_SRC)) throw Error('Indirect arguments not readable');
              let index = record.indirect.findIndex(d=>d.buffer===args[0] && d.offset===args[1]);
              if (index < 0) {index=record.indirect.length;record.indirect.push({buffer:args[0],offset:args[1]});}
              p.indirect.push({index,pipeline:context.pipeline});
            }
          }
          else p.dispatches++;
        }
        return original.apply(this, args);
      };
    }
  }
  const finish = GPUCommandEncoder.prototype.finish;
  GPUCommandEncoder.prototype.finish = function(desc) {
    const record = encoders.get(this);
    if (record?.passes.length) {
      const size = record.queryBytes = record.passes.length * 16;
      record.resolve = record.device.createBuffer({size,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      record.readback = record.device.createBuffer({size:Math.ceil((size+record.indirect.length*20)/8)*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      this.resolveQuerySet(record.queries,0,record.passes.length*2,record.resolve,0);
      this.copyBufferToBuffer(record.resolve,0,record.readback,0,size);
      record.indirect.forEach((d,i)=>this.copyBufferToBuffer(d.buffer,d.offset,record.readback,size+i*20,20));
    }
    const result = finish.call(this,desc);
    if (record?.passes.length) commands.set(result,record);
    encoders.delete(this); return result;
  };
};
