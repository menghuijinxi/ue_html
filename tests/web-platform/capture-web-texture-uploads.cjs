// Injected before WASM startup; keep native GPU handles until the upload readback completes.
module.exports = function captureWebTextureUploads() {
  const textures = new Map();
  const failures = [];
  const bytesPerPixel = {'rgba8unorm': 4, 'rgba8unorm-srgb': 4,
    'bgra8unorm': 4, 'bgra8unorm-srgb': 4, 'r8unorm': 1,
    'r32uint': 4, 'rgba8uint': 4, 'r16uint': 2, 'rg8unorm': 2, 'rgba16float': 8};
  let device, writes = 0;
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    if (texture.dimension === '2d' && texture.depthOrArrayLayers === 1 &&
        bytesPerPixel[texture.format] && (texture.usage & GPUTextureUsage.COPY_SRC)) {
      device = this;
      textures.set(texture, new Map());
    }
    return texture;
  };
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function(destination, data, layout, extent) {
    writeTexture.call(this, destination, data, layout, extent);
    const mips = textures.get(destination.texture);
    if (!mips) return;
    ++writes;
    try {
      const mip = destination.mipLevel || 0, texture = destination.texture;
      const origin = destination.origin || {};
      const width = Math.max(1, texture.width >> mip), height = Math.max(1, texture.height >> mip);
      const copyWidth = extent.width ?? extent[0], copyHeight = extent.height ?? extent[1] ?? 1;
      if ((origin.x ?? origin[0] ?? 0) || (origin.y ?? origin[1] ?? 0) ||
          (origin.z ?? origin[2] ?? 0) || copyWidth !== width || copyHeight !== height)
        throw new Error('Startup texture audit requires full mip writes');
      const source = ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const stride = width * bytesPerPixel[texture.format], pitch = layout.bytesPerRow ?? stride;
      const expected = new Uint8Array(stride * height), offset = layout.offset || 0;
      for (let row = 0; row < height; ++row)
        expected.set(source.subarray(offset + row * pitch, offset + row * pitch + stride), row * stride);
      mips.set(mip, {mip, width, height, stride, expected});
    } catch (error) {
      failures.push(String(error));
    }
  };
  globalThis.__webTextureUploads = {
    async readback() {
      const result = {pass: false, writes, textures: 0, mips: [], checkedBytes: 0, failures: [...failures]};
      if (!device) return result;
      const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        value => value.toString(16).padStart(2, '0')).join('');
      device.pushErrorScope('validation');
      try {
        for (const [texture, mips] of textures) {
          if (!mips.size) continue;
          ++result.textures;
          for (const mip of mips.values()) {
            const pitch = Math.ceil(mip.stride / 256) * 256, size = pitch * mip.height;
            if (size > 64 * 1024 * 1024) throw new Error('Texture readback exceeds the audit budget');
            const buffer = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
            try {
              const encoder = device.createCommandEncoder();
              encoder.copyTextureToBuffer({texture, mipLevel: mip.mip},
                {buffer, bytesPerRow: pitch, rowsPerImage: mip.height},
                {width: mip.width, height: mip.height, depthOrArrayLayers: 1});
              device.queue.submit([encoder.finish()]);
              await buffer.mapAsync(GPUMapMode.READ);
              const mapped = new Uint8Array(buffer.getMappedRange()), actual = new Uint8Array(mip.expected.length);
              for (let row = 0; row < mip.height; ++row)
                actual.set(mapped.subarray(row * pitch, row * pitch + mip.stride), row * mip.stride);
              const expectedSHA256 = await sha(mip.expected), actualSHA256 = await sha(actual);
              const pass = expectedSHA256 === actualSHA256;
              result.mips.push({name: texture.label, format: texture.format, mip: mip.mip, width: mip.width, height: mip.height,
                checkedBytes: actual.length, expectedSHA256, actualSHA256, pass});
              result.checkedBytes += actual.length;
              buffer.unmap();
            } finally {
              buffer.destroy();
            }
          }
        }
      } catch (error) {
        result.failures.push(String(error));
      }
      const error = await device.popErrorScope();
      if (error) result.failures.push(error.message);
      result.pass = result.mips.length > 0 && !result.failures.length && result.mips.every(mip => mip.pass);
      return result;
    }
  };
};
