'use strict';
// Injected into the GPU owner worker by correctness probes. Counts executed
// work of the merged programmable raster and global shade binning paths by
// the identifiers that survive in each pipeline's WGSL. Cumulative for the
// page; it observes calls only and changes no arguments or ordering.
module.exports = function observeNanitePaths() {
  const state = globalThis.__nanitePaths = {programmablePrepareDispatches: 0, programmablePrepareBatches: 0,
    programmableDraws: 0, shadeBinDispatches: 0, binnedMaterialDraws: 0, legacyMaterialDraws: 0};
  const code = new WeakMap(), kinds = new WeakMap(), current = new WeakMap();
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) { const m = createModule.call(this, descriptor); code.set(m, descriptor.code); return m; };
  const remember = (pipeline, d) => {
    const text = [d.compute, d.vertex, d.fragment].filter(Boolean).map(s => code.get(s.module) || '').join('\n');
    kinds.set(pipeline, {prepare: text.includes('WebProgrammableBatchOutput'), programmable: text.includes('WebRasterPixelProgrammable'),
      shadeBin: text.includes('WebShadeBinCounts'), binned: text.includes('WebShadeBinTiles'), legacy: text.includes('WebNativeMaterialTiles')});
    return pipeline;
  };
  for (const name of ['createComputePipeline', 'createRenderPipeline']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (d) { return remember(original.call(this, d), d); };
    const originalAsync = GPUDevice.prototype[name + 'Async'];
    GPUDevice.prototype[name + 'Async'] = function (d) { return originalAsync.call(this, d).then(p => remember(p, d)); };
  }
  for (const proto of [GPUComputePassEncoder.prototype, GPURenderPassEncoder.prototype]) {
    const set = proto.setPipeline;
    proto.setPipeline = function (p) { current.set(this, kinds.get(p)); return set.call(this, p); };
  }
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function (...args) {
    const kind = current.get(this);
    if (kind?.prepare) { state.programmablePrepareDispatches++; state.programmablePrepareBatches += args[0]; }
    if (kind?.shadeBin) state.shadeBinDispatches++;
    return dispatch.apply(this, args);
  };
  const draw = GPURenderPassEncoder.prototype.drawIndirect;
  GPURenderPassEncoder.prototype.drawIndirect = function (...args) {
    const kind = current.get(this);
    if (kind?.programmable) state.programmableDraws++;
    if (kind?.binned) state.binnedMaterialDraws++;
    if (kind?.legacy) state.legacyMaterialDraws++;
    return draw.apply(this, args);
  };
};
