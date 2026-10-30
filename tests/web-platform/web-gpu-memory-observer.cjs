// Observe allocation lifetimes without retaining GPU resources or changing device features.
module.exports = function observeGPUResourceMemory() {
  const state = globalThis.__webGPUMemory = {created: {texture: 0, buffer: 0},
    destroyed: {texture: 0, buffer: 0}, collected: {texture: 0, buffer: 0}, errors: [],
    frames: 0, frameMilliseconds: [], draws: 0, submits: 0};
  const records = new Map(), objects = new WeakMap();
  let serial = 0, lastFrame = 0, previousTime;
  const collected = new FinalizationRegistry(id => {
    const record = records.get(id);
    if (record) { ++state.collected[record.kind]; records.delete(id); }
  });
  function track(object, record) {
    const id = ++serial;
    records.set(id, {...record, weak: new WeakRef(object)});
    objects.set(object, id);
    collected.register(object, id);
    ++state.created[record.kind];
    return object;
  }
  const textureBytes = descriptor => {
    const compressed = descriptor.format.startsWith('bc');
    const block = compressed ? 4 : 1;
    const bytes = compressed ? (/^bc[14]-/.test(descriptor.format) ? 8 : 16) : ({
      r8unorm: 1, r8uint: 1, rg8unorm: 2, r16float: 2, r16uint: 2,
      rg16float: 4, rg16uint: 4, r32float: 4, r32uint: 4, rg32uint: 8,
      rgba16float: 8, rgba32float: 16, rg11b10ufloat: 4,
      rgba8uint: 4, rgba8unorm: 4, 'rgba8unorm-srgb': 4,
      bgra8unorm: 4, 'bgra8unorm-srgb': 4, depth32float: 4,
      'depth24plus-stencil8': 8, depth16unorm: 2
    }[descriptor.format]);
    if (!bytes) return null;
    const size = descriptor.size;
    const width = size.width ?? size[0], height = size.height ?? size[1] ?? 1;
    const depth = size.depthOrArrayLayers ?? size[2] ?? 1;
    let total = 0;
    for (let mip = 0; mip < (descriptor.mipLevelCount || 1); ++mip)
      total += Math.ceil(Math.max(1, width >> mip) / block) *
        Math.ceil(Math.max(1, height >> mip) / block) *
        (descriptor.dimension === '3d' ? Math.max(1, depth >> mip) : depth) * bytes;
    return total * (descriptor.sampleCount || 1);
  };
  for (const kind of ['texture', 'buffer']) {
    const method = kind === 'texture' ? 'createTexture' : 'createBuffer';
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      return track(original.call(this, descriptor), {kind, label: descriptor.label || '',
        bytes: kind === 'texture' ? textureBytes(descriptor) : Number(descriptor.size),
        format: descriptor.format, size: descriptor.size, usage: descriptor.usage,
        mips: descriptor.mipLevelCount || 1});
    };
    const prototype = kind === 'texture' ? GPUTexture.prototype : GPUBuffer.prototype;
    const destroy = prototype.destroy;
    prototype.destroy = function() {
      const id = objects.get(this);
      if (records.delete(id)) ++state.destroyed[kind];
      return destroy.call(this);
    };
  }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => { if (info.reason !== 'destroyed') state.errors.push(info.message); });
    return device;
  };
  for (const [prototype, method, counter] of [[GPUQueue.prototype, 'submit', 'submits'],
    [GPURenderPassEncoder.prototype, 'draw', 'draws'],
    [GPURenderPassEncoder.prototype, 'drawIndexed', 'draws']]) {
    const original = prototype[method];
    prototype[method] = function(...args) { ++state[counter]; return original.apply(this, args); };
  }
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = callback => raf(time => {
    callback(time);
    const frame = globalThis.__webEngineFrames || 0;
    if (frame !== lastFrame) {
      ++state.frames;
      if (previousTime !== undefined) state.frameMilliseconds.push(performance.now() - previousTime);
      if (state.frameMilliseconds.length > 600) state.frameMilliseconds.shift();
      previousTime = performance.now();
      lastFrame = frame;
    }
  });
  globalThis.__webGPUMemorySnapshot = () => {
    const live = [], totals = {texture: 0, buffer: 0};
    for (const [id, record] of records) {
      if (!record.weak.deref()) { records.delete(id); ++state.collected[record.kind]; continue; }
      const {weak, ...description} = record;
      live.push(description);
      totals[record.kind] += record.bytes || 0;
    }
    return {...state, totals, live: live.sort((a, b) => (b.bytes || 0) - (a.bytes || 0)),
      boundary: 'Live JavaScript handles; descriptor bytes exclude driver overhead and aliasing. WDDM is measured separately.'};
  };
};
