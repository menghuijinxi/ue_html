'use strict';
module.exports = function observeVolumes(entries) {
  const state = globalThis.__webTLVProbe = {dispatches: {}, pipelines: {}};
  let device;
  const volumes = [];
  const destroyed = new WeakSet();
  const destroy = GPUTexture.prototype.destroy;
  GPUTexture.prototype.destroy = function() {
    destroyed.add(this);
    return destroy.call(this);
  };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    device = await request.apply(this, args);
    return device;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(desc) {
    const texture = createTexture.call(this, desc);
    if (/TranslucentVolume(Ambient|Directional)/.test(desc.label || '') && desc.dimension === '3d')
      volumes.push(new WeakRef(texture));
    return texture;
  };
  const pipelines = new WeakMap(), passes = new WeakMap();
  for (const method of ['createComputePipeline', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(desc) {
      const result = original.call(this, desc);
      const track = pipeline => {
        const entry = entries[desc.compute.entryPoint] || desc.compute.entryPoint;
        pipeline.label = entry;
        pipelines.set(pipeline, entry);
        state.pipelines[entry] = (state.pipelines[entry] || 0) + 1;
      };
      if (method.endsWith('Async')) result.then(track, () => {}); else track(result);
      return result;
    };
  }
  const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    passes.set(this, pipelines.get(pipeline));
    return setPipeline.call(this, pipeline);
  };
  for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    const original = GPUComputePassEncoder.prototype[name];
    GPUComputePassEncoder.prototype[name] = function(...args) {
      const entry = passes.get(this);
      if (entry) state.dispatches[entry] = (state.dispatches[entry] || 0) + 1;
      return original.apply(this, args);
    };
  }
  globalThis.__webReadTLV = async () => {
    await device.queue.onSubmittedWorkDone();
    const textures = volumes.map(ref => ref.deref()).filter(texture => texture && !destroyed.has(texture));
    const results = [];
    function half(value) {
      const exponent = (value >> 10) & 31, mantissa = value & 1023, sign = value & 32768 ? -1 : 1;
      return exponent === 31 ? (mantissa ? NaN : sign * Infinity) :
        sign * (exponent ? (1 + mantissa / 1024) * 2 ** (exponent - 15) : mantissa * 2 ** -24);
    }
    for (const texture of textures) {
      if (texture.format === 'rgba16float' && (texture.usage & GPUTextureUsage.COPY_SRC)) {
        const bytesPerRow = Math.ceil(texture.width * 8 / 256) * 256;
        const size = bytesPerRow * texture.height * texture.depthOrArrayLayers;
        const buffer = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        try {
          const encoder = device.createCommandEncoder();
          encoder.copyTextureToBuffer({texture}, {buffer, bytesPerRow, rowsPerImage: texture.height},
            [texture.width, texture.height, texture.depthOrArrayLayers]);
          device.queue.submit([encoder.finish()]);
          await buffer.mapAsync(GPUMapMode.READ);
          const words = new Uint16Array(buffer.getMappedRange());
          let energy = 0, nonzero = 0, invalid = 0, alphaMin = Infinity, alphaMax = -Infinity, maxRGB = 0;
          for (let z = 0; z < texture.depthOrArrayLayers; ++z) for (let y = 0; y < texture.height; ++y)
          for (let x = 0; x < texture.width; ++x) {
            const offset = ((z * texture.height + y) * bytesPerRow) / 2 + x * 4;
            let voxelEnergy = 0;
            for (let channel = 0; channel < 4; ++channel) {
              const value = half(words[offset + channel]);
              if (!Number.isFinite(value)) ++invalid;
              if (channel < 3) { voxelEnergy += Math.abs(value); maxRGB = Math.max(maxRGB, value); }
              else { alphaMin = Math.min(alphaMin, value); alphaMax = Math.max(alphaMax, value); }
            }
            energy += voxelEnergy;
            if (voxelEnergy > 1e-7) ++nonzero;
          }
          const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(words.buffer));
          const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
          results.push({label: texture.label, width: texture.width, depth: texture.depthOrArrayLayers, sha256,
            energy, nonzero, invalid, alphaMin, alphaMax, maxRGB});
          buffer.unmap();
        } finally { buffer.destroy(); }
      }
    }
    return results;
  };
}
;
