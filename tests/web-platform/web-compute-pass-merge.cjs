'use strict';
// Diagnostic only: reuse a compute pass across adjacent dispatches. A WebGPU
// dispatch is its own resource-usage scope. Every encoder-level operation still
// closes the pass; explicit pass descriptors (including timestamps) stay intact.
module.exports = function installComputePassMerge() {
  const encoders = new WeakMap(), passes = new WeakMap();
  const ep = GPUCommandEncoder.prototype, cp = GPUComputePassEncoder.prototype;
  const begin = ep.beginComputePass, end = cp.end, bind = cp.setBindGroup;
  const counters = globalThis.__webComputePassMerge = {requested: 0, opened: 0, reused: 0, closed: 0};
  function close(encoder) {
    const state = encoders.get(encoder);
    if (!state || !state.ended) return;
    end.call(state.pass); counters.closed++;
    encoders.delete(encoder); passes.delete(state.pass);
  }
  ep.beginComputePass = function(descriptor) {
    counters.requested++;
    if (descriptor != null) {close(this); return begin.call(this, descriptor);}
    const prior = encoders.get(this);
    if (prior?.ended) {
      prior.ended = false; prior.seen = 0; counters.reused++;
      return prior.pass;
    }
    const pass = begin.call(this, descriptor);
    const state = {pass, ended: false, bound: 0, seen: 0};
    passes.set(pass, state); encoders.set(this, state); counters.opened++;
    return pass;
  };
  cp.end = function() {
    const state = passes.get(this);
    if (!state) return end.call(this);
    if (state.ended) throw new Error('Compute pass ended twice');
    state.ended = true;
  };
  cp.setBindGroup = function(index, ...args) {
    const state = passes.get(this);
    if (state) {state.seen |= 1 << index; state.bound |= 1 << index;}
    return bind.call(this, index, ...args);
  };
  for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    const original = cp[name];
    cp[name] = function(...args) {
      const state = passes.get(this);
      if (state) {
        if (state.ended) throw new Error('Dispatch after logical compute pass end');
        // A fresh pass has no retained groups. Remove slots not written in the
        // new logical pass, including when changing to a smaller pipeline layout.
        let stale = state.bound & ~state.seen;
        for (let index = 0; stale; index++, stale >>>= 1)
          if (stale & 1) bind.call(this, index, null);
        state.bound = state.seen;
      }
      return original.apply(this, args);
    };
  }
  for (const name of ['beginRenderPass', 'copyBufferToBuffer', 'copyBufferToTexture',
    'copyTextureToBuffer', 'copyTextureToTexture', 'clearBuffer', 'resolveQuerySet',
    'writeTimestamp', 'insertDebugMarker', 'pushDebugGroup', 'popDebugGroup', 'finish']) {
    if (!ep[name]) continue;
    const original = ep[name];
    ep[name] = function(...args) {close(this); return original.apply(this, args);};
  }
};
