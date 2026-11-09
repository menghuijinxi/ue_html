'use strict';

// Injected into the real WebGPU owner worker. Track actual pipeline objects,
// including their creation API and subsequent dispatches, independently of RHI counters.
function observeStoragePrecache() {
  const modules = new WeakMap(), pipelines = new WeakMap(), bound = new WeakMap();
  const shaderFamilies = new Map();
  const state = globalThis.__storagePrecacheAudit = {pipelines:[], failures:[]};
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(desc) {
    const module = createModule.call(this, desc);
    const formats = [...desc.code.matchAll(/var\s+(\w+)\s*:\s*texture_storage_\w+<\s*(\w+)\s*,\s*(\w+)\s*>/g)]
      .map(m => ({name:m[1], format:m[2], access:m[3]}));
    if (formats.length) {
      const normalized = desc.code.replace(/(texture_storage_\w+<\s*)\w+/g, '$1FORMAT');
      if (!shaderFamilies.has(normalized)) shaderFamilies.set(normalized, shaderFamilies.size);
      modules.set(module, {formats, family:shaderFamilies.get(normalized)});
    }
    return module;
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
    const create = GPUDevice.prototype[name], asynchronous = name.endsWith('Async');
    const record = (pipeline, descriptor) => {
      const shader = modules.get(descriptor.compute.module);
      if (shader) {
        const item = {entry:descriptor.compute.entryPoint, asynchronous, ...shader, dispatches:0, indirectDispatches:0};
        pipelines.set(pipeline, item); state.pipelines.push(item);
      }
      return pipeline;
    };
    GPUDevice.prototype[name] = asynchronous ? async function(descriptor) {
      try { return record(await create.call(this, descriptor), descriptor); }
      catch (error) {
        state.failures.push({entry:descriptor.compute.entryPoint, formats:modules.get(descriptor.compute.module), error:String(error)});
        throw error;
      }
    } : function(descriptor) { return record(create.call(this, descriptor), descriptor); };
  }
  const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    bound.set(this, pipelines.get(pipeline)); return setPipeline.call(this, pipeline);
  };
  for (const [name, key] of [['dispatchWorkgroups','dispatches'], ['dispatchWorkgroupsIndirect','indirectDispatches']]) {
    const dispatch = GPUComputePassEncoder.prototype[name];
    GPUComputePassEncoder.prototype[name] = function(...args) {
      const item = bound.get(this); if (item) ++item[key];
      return dispatch.apply(this, args);
    };
  }
}

function verifyStoragePrecache(state, requireVariants = true) {
  const assert = require('node:assert/strict');
  assert.equal(state.failures.length, 0, JSON.stringify(state.failures));
  const used = state.pipelines.filter(p => p.dispatches + p.indirectDispatches > 0);
  assert(used.some(p => p.asynchronous), 'An asynchronously compiled storage pipeline must execute');
  assert(state.rhi.storageFormatPrecached > 0 && state.rhi.storageFormatPrecachedUsed > 0 && state.rhi.storageFormatPrecachedBinds > 0,
    'The deferred RHI wrapper must reuse a completed format variant');
  if (requireVariants) {
    const motion = used.filter(p => p.formats.some(f => f.name.includes('OutVelocityFlatTexture')));
    const formats = [...new Set(motion.flatMap(p => p.formats.filter(f => f.name.includes('OutVelocityFlatTexture')).map(f => f.format)))].sort();
    assert.deepEqual(formats, ['rg11b10ufloat', 'rgba32float']);
    assert(motion.some(p => p.asynchronous) && motion.some(p => !p.asynchronous),
      'Motion blur must execute both a precached variant and a runtime format variant');
    assert(motion.some(p => p.asynchronous && motion.some(q => !q.asynchronous && q.family === p.family)),
      'Both formats must belong to the same shader body');
  }
  return {pass:true, compiled:state.pipelines.length, asynchronous:state.pipelines.filter(p=>p.asynchronous).length,
    used:used.length, asynchronousUsed:used.filter(p=>p.asynchronous).length};
}
module.exports = {observeStoragePrecache, verifyStoragePrecache};
