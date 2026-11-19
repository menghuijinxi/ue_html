'use strict';

// Inject into the RHI owner worker. Count requested API payloads without adding GPU commands.
module.exports = function observeGPUTransfers(textureBytes) {
  let rows;
  function record(operation, source, target, bytes) {
    const key = JSON.stringify([operation, source, target]);
    let row = rows.get(key);
    if (!row) {
      row = {operation, source, target, calls: 0, bytes: 0, unknownSize: 0};
      rows.set(key, row);
    }
    ++row.calls;
    if (Number.isFinite(bytes)) row.bytes += bytes;
    else ++row.unknownSize;
  }
  function wrap(prototype, method, observe) {
    const original = prototype[method];
    prototype[method] = function(...args) {
      const result = original.apply(this, args);
      if (rows) observe.call(this, ...args);
      return result;
    };
  }
  const label = resource => resource.label || '(unlabelled)';
  const textureSize = (texture, size) => textureBytes({format: texture.format, size});
  const encoder = GPUCommandEncoder.prototype;
  wrap(encoder, 'copyBufferToBuffer', (src, offset, dst, destOffset, size) =>
    record('copyBufferToBuffer', label(src), label(dst), size ?? Math.min(src.size - offset, dst.size - destOffset)));
  for (const method of ['copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture']) {
    wrap(encoder, method, (src, dst, size) => record(method,
      label(src.texture || src.buffer), label(dst.texture || dst.buffer), textureSize(src.texture || dst.texture, size)));
  }
  wrap(encoder, 'clearBuffer', (buffer, offset = 0, size = buffer.size - offset) =>
    record('clearBuffer', '', label(buffer), size));
  wrap(GPUQueue.prototype, 'writeBuffer', (dst, offset, data, dataOffset = 0, size) => {
    const stride = data.BYTES_PER_ELEMENT || 1;
    record('writeBuffer', 'CPU', label(dst), size === undefined ? data.byteLength - dataOffset * stride : size * stride);
  });
  wrap(GPUQueue.prototype, 'writeTexture', (dst, data, layout, size) =>
    record('writeTexture', 'CPU', label(dst.texture), textureSize(dst.texture, size)));
  wrap(GPUBuffer.prototype, 'mapAsync', function(mode, offset = 0, size = this.size - offset) {
    record(mode === GPUMapMode.READ ? 'mapRead' : 'mapWrite', label(this), '', size);
  });
  wrap(GPUComputePassEncoder.prototype, 'setPipeline', pipeline =>
    record('computePipelineBind', label(pipeline), '', 0));
  // A sampled or storage access inside a shader does not issue a copy command.
  // Follow atlas views through cached bind groups, including those created before capture.
  const atlasViews = new WeakSet(), layouts = new WeakMap(), atlasGroups = new WeakMap();
  const passGroups = new WeakMap();
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const view = createView.apply(this, args);
    if (this.label === 'GlobalDistanceField.PageAtlas') atlasViews.add(view);
    return view;
  };
  const createLayout = GPUDevice.prototype.createBindGroupLayout;
  GPUDevice.prototype.createBindGroupLayout = function(descriptor) {
    const layout = createLayout.call(this, descriptor);
    layouts.set(layout, new Map(descriptor.entries.map(entry =>
      [entry.binding, entry.storageTexture ? (entry.storageTexture.access || 'write-only') : 'sampled'])));
    return layout;
  };
  const createGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(descriptor) {
    const group = createGroup.call(this, descriptor);
    const entries = descriptor.entries.filter(entry => atlasViews.has(entry.resource));
    if (entries.length) atlasGroups.set(group,
      entries.map(entry => layouts.get(descriptor.layout)?.get(entry.binding) || 'unknown'));
    return group;
  };
  const compute = GPUComputePassEncoder.prototype;
  const setGroup = compute.setBindGroup;
  compute.setBindGroup = function(index, group, ...args) {
    const result = setGroup.call(this, index, group, ...args);
    let bound = passGroups.get(this);
    if (atlasGroups.has(group)) {
      if (!bound) passGroups.set(this, bound = new Map());
      bound.set(index, atlasGroups.get(group));
    } else bound?.delete(index);
    return result;
  };
  for (const method of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    wrap(compute, method, function() {
      const bound = passGroups.get(this);
      if (!bound?.size) return;
      const access = new Set();
      for (const entries of bound.values()) for (const mode of entries) access.add(mode);
      record('atlasDispatch', method, [...access].sort().join('+'), 0);
    });
  }
  globalThis.__webGPUTransferCapture = {
    start() { rows = new Map(); },
    stop() {
      const result = [...rows.values()];
      rows = null;
      return result;
    }
  };
};
