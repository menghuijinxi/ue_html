'use strict';
// Diagnostic only: weak ownership, one aggregate per descriptor/callsite.
module.exports = function installBufferLifecycleObserver() {
  const state = globalThis.__webBufferLifecycle = {created: 0, destroyed: 0, collected: 0,
    liveBytes: 0, peakBytes: 0, groups: {}, errors: []};
  const records = new WeakMap();
  const frame = () => globalThis.__webRHIFrames || 0;
  const registry = new FinalizationRegistry(record => {
    if (!record.destroyed) { ++state.collected; ++record.group.collected; state.liveBytes -= record.size; }
  });
  const create = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function(descriptor) {
    const result = create.call(this, descriptor);
    const key = [descriptor.label || '', descriptor.size, descriptor.usage, !!descriptor.mappedAtCreation].join('|');
    const group = state.groups[key] ||= {label: descriptor.label || '', size: Number(descriptor.size),
      usage: descriptor.usage, mappedAtCreation: !!descriptor.mappedAtCreation, created: 0, destroyed: 0,
      collected: 0, lifetimeFrames: {}, stacks: []};
    if (group.stacks.length < 1) group.stacks.push(new Error().stack);
    ++group.created; ++state.created;
    state.liveBytes += group.size; state.peakBytes = Math.max(state.peakBytes, state.liveBytes);
    const record = {group, size: group.size, frame: frame(), destroyed: false};
    records.set(result, record); registry.register(result, record, result);
    return result;
  };
  const destroy = GPUBuffer.prototype.destroy;
  GPUBuffer.prototype.destroy = function() {
    const record = records.get(this);
    if (record && !record.destroyed) {
      record.destroyed = true; registry.unregister(this);
      ++state.destroyed; ++record.group.destroyed; state.liveBytes -= record.size;
      const age = frame() - record.frame;
      record.group.lifetimeFrames[age] = (record.group.lifetimeFrames[age] || 0) + 1;
    }
    return destroy.call(this);
  };
};
