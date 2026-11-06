'use strict';
// Compare actual destination bytes after real engine upload copies. Diagnostic only.
module.exports = function installUploadStagingValidator() {
  let active;
  let writes = new WeakMap();
  const devices = new WeakMap(), encoders = new WeakMap(), commands = new WeakMap();
  const create = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function(descriptor) {
    const buffer = create.call(this, descriptor); devices.set(buffer, this); return buffer;
  };
  const write = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function(buffer, offset, data, dataOffset = 0, size) {
    if (active && buffer.usage === (GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST)) {
      const view = ArrayBuffer.isView(data), unit = view ? (data.BYTES_PER_ELEMENT || 1) : 1;
      const start = (view ? data.byteOffset : 0) + dataOffset * unit;
      const length = size === undefined ? data.byteLength - dataOffset * unit : size * unit;
      let slices = writes.get(buffer); if (!slices) writes.set(buffer, slices = new Map());
      slices.delete(offset);
      slices.set(offset, new Uint8Array(new Uint8Array(view ? data.buffer : data, start, length)));
    }
    return write.apply(this, arguments);
  };
  const copy = GPUCommandEncoder.prototype.copyBufferToBuffer;
  GPUCommandEncoder.prototype.copyBufferToBuffer = function(source, sourceOffset, destination, destinationOffset, size) {
    const result = copy.apply(this, arguments);
    if (active && source.usage === (GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST) && active.captured < active.requested &&
        (destination.usage & GPUBufferUsage.COPY_SRC)) {
      const capture = active, device = devices.get(source);
      const buffer = create.call(device, {size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      copy.call(this, destination, destinationOffset, buffer, 0, size);
      let probes = encoders.get(this); if (!probes) encoders.set(this, probes = []);
      probes.push({capture, buffer, source, size, sourceOffset}); ++capture.captured;
    }
    return result;
  };
  const finish = GPUCommandEncoder.prototype.finish;
  GPUCommandEncoder.prototype.finish = function() {
    const command = finish.apply(this, arguments), probes = encoders.get(this);
    if (probes) {commands.set(command, probes); encoders.delete(this);} return command;
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(commandBuffers) {
    const list = Array.from(commandBuffers);
    // Deferred writes may happen after encoding. Resolve the reference bytes at
    // submission, when every staging slice must already have been uploaded.
    for (const command of list) for (const probe of commands.get(command) || []) {
      for (const [offset, bytes] of Array.from(writes.get(probe.source) || []).reverse()) {
        if (offset <= probe.sourceOffset && offset + bytes.length >= probe.sourceOffset + probe.size) {
          probe.expected = bytes.slice(probe.sourceOffset - offset, probe.sourceOffset - offset + probe.size); break;
        }
      }
      if (!probe.expected) probe.capture.errors.push('Staging slice missing a covering write before submission');
    }
    const result = submit.call(this, list);
    for (const command of list) for (const probe of commands.get(command) || []) {
      const {capture, buffer, expected, sourceOffset} = probe;
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        const actual = new Uint8Array(buffer.getMappedRange());
        for (let i = 0; expected && i < actual.length; ++i) if (actual[i] !== expected[i]) {
          capture.errors.push({sourceOffset, index: i, actual: actual[i], expected: expected[i]}); break;
        }
        capture.bytes += actual.length; ++capture.completed;
        if (sourceOffset) ++capture.nonzeroOffsets;
        buffer.unmap(); buffer.destroy();
      }).catch(error => {capture.errors.push(error.message); ++capture.completed; buffer.destroy();});
    }
    return result;
  };
  globalThis.__webValidateUploadCopies = async (requested = 512) => {
    if (active) throw Error('Upload validation is already running');
    writes = new WeakMap();
    const capture = active = {requested, captured: 0, completed: 0, bytes: 0, nonzeroOffsets: 0, errors: []};
    const start = performance.now();
    try {
      while (capture.completed < requested && performance.now() - start < 30000)
        await new Promise(resolve => setTimeout(resolve, 50));
      if (capture.completed !== requested) capture.errors.push('Upload validation timed out');
      return capture;
    } finally {active = undefined;}
  };
};
