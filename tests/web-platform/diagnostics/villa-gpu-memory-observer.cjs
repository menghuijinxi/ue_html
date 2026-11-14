'use strict';

// Diagnostic estimates describe requested resources, not driver residency.
module.exports = function observeMemory() {
  const state = globalThis.__villaGPUResources = {bufferBytes: 0, textureBytes: 0,
    bufferPeak: 0, texturePeak: 0, bufferCount: 0, textureCount: 0, unknownFormats: {}};
  const large = new Map();
  Object.defineProperty(state, 'largest', {enumerable: true, get: () =>
    [...large.values()].filter(record => record.count).sort((a, b) => b.bytes - a.bytes).slice(0, 16)});
  const resources = new WeakMap();
  const release = record => {
    if (!record.live) return;
    record.live = false;
    state[record.kind + 'Bytes'] -= record.bytes;
    --state[record.kind + 'Count'];
    if (record.group) {--record.group.count; record.group.bytes -= record.bytes;}
  };
  const finalization = new FinalizationRegistry(release);
  const textureBytes = descriptor => {
    const format = descriptor.format;
    const compressed = /^(bc|etc2|eac|astc)/.test(format);
    let bytes, block = [1, 1];
    if (compressed) {
      if (/^astc/.test(format)) block = format.match(/(\d+)x(\d+)/).slice(1).map(Number);
      else block = [4, 4];
      bytes = /^(bc1|bc4|etc2-rgb8|etc2-rgb8a1|eac-r11)/.test(format) ? 8 : 16;
    } else if (/^(rgba32)/.test(format)) bytes = 16;
    else if (/^(rgba16|rg32|depth32float-stencil8)/.test(format)) bytes = 8;
    else if (/^(rgba8|bgra8|rg16|r32|rgb10|rg11|rgb9|depth24|depth32)/.test(format)) bytes = 4;
    else if (/^(rg8|r16|depth16)/.test(format)) bytes = 2;
    else if (/^(r8|stencil8)/.test(format)) bytes = 1;
    else {state.unknownFormats[format] = (state.unknownFormats[format] || 0) + 1; return 0;}
    const size = descriptor.size;
    let width = size.width ?? size[0], height = size.height ?? size[1] ?? 1;
    let layers = size.depthOrArrayLayers ?? size[2] ?? 1, total = 0;
    for (let mip = 0; mip < (descriptor.mipLevelCount || 1); ++mip) {
      total += Math.ceil(width / block[0]) * Math.ceil(height / block[1]) * layers * bytes *
        (descriptor.sampleCount || 1);
      width = Math.max(1, Math.floor(width / 2)); height = Math.max(1, Math.floor(height / 2));
      if (descriptor.dimension === '3d') layers = Math.max(1, Math.floor(layers / 2));
    }
    return total;
  };
  for (const [kind, prototype] of [['buffer', GPUBuffer.prototype], ['texture', GPUTexture.prototype]]) {
    const createName = kind === 'buffer' ? 'createBuffer' : 'createTexture';
    const create = GPUDevice.prototype[createName], destroy = prototype.destroy;
    GPUDevice.prototype[createName] = function(descriptor) {
      const result = create.call(this, descriptor);
      const bytes = kind === 'buffer' ? Number(descriptor.size) : textureBytes(descriptor);
      const record = {kind, bytes, live: true};
      if (bytes >= 8 * 1024 * 1024) {
        const detail = kind === 'buffer' ? {size: bytes, usage: descriptor.usage} :
          {format: descriptor.format, size: descriptor.size, mips: descriptor.mipLevelCount || 1};
        const key = JSON.stringify({kind, label: descriptor.label || '', ...detail});
        if (!large.has(key)) large.set(key, {kind, label: descriptor.label || '', ...detail, bytes: 0, count: 0});
        record.group = large.get(key); ++record.group.count; record.group.bytes += bytes;
      }
      resources.set(result, record); finalization.register(result, record, result);
      state[kind + 'Bytes'] += bytes; ++state[kind + 'Count'];
      state[kind + 'Peak'] = Math.max(state[kind + 'Peak'], state[kind + 'Bytes']);
      return result;
    };
    prototype.destroy = function(...args) {
      const result = destroy.apply(this, args), record = resources.get(this);
      if (record) {release(record); finalization.unregister(this);}
      return result;
    };
  }
};
