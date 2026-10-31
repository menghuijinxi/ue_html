'use strict';

// Installed before the runtime creates its WebGPU device. No project cvars change.
module.exports = function installPerformanceCapture() {
  const capture = globalThis.__webPerformanceCapture = {active: false, frames: [], passes: [],
    gpuFrames: [], errors: [], adapter: {}, calls: {}, apiMs: {}};
  let device, query, resolveBuffer, readback, pendingGPU, requestedGPU, gpuBusy = false;
  let presented = 0, previousPresent, frameCalls = {}, frameAPIMs = {};
  const views = new WeakMap(), passes = new WeakMap();
  const now = () => performance.timeOrigin + performance.now();
  const add = (object, name, value = 1) => { object[name] = (object[name] || 0) + value; };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
    capture.adapter = {vendor: this.info?.vendor, architecture: this.info?.architecture,
      device: this.info?.device, description: this.info?.description,
      features: [...this.features], fallback: this.isFallbackAdapter};
    const features = [...(descriptor.requiredFeatures || [])];
    if (this.features.has('timestamp-query') && !features.includes('timestamp-query')) features.push('timestamp-query');
    device = await request.call(this, {...descriptor, requiredFeatures: features});
    device.addEventListener('uncapturederror', event => capture.errors.push(event.error.message));
    if (device.features.has('timestamp-query')) {
      query = device.createQuerySet({type: 'timestamp', count: 2048});
      resolveBuffer = device.createBuffer({size: 16384, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      readback = device.createBuffer({size: 16384, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    }
    return device;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const value = createView.apply(this, args);
    views.set(value, {label: this.label || 'unlabelled texture', width: this.width, height: this.height,
      format: this.format});
    return value;
  };
  for (const [prototype, names] of [
    [GPUDevice.prototype, ['createBuffer', 'createBindGroup', 'createRenderPipeline', 'createComputePipeline']],
    [GPUQueue.prototype, ['writeBuffer', 'writeTexture', 'submit']],
    [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect',
      'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'setPipeline', 'beginOcclusionQuery']],
    [GPUComputePassEncoder.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect', 'setBindGroup', 'setPipeline']]
  ]) for (const name of names) {
    const original = prototype[name];
    prototype[name] = function(...args) {
      if (!capture.active && !pendingGPU) return original.apply(this, args);
      const pass = passes.get(this);
      if (pass) {
        add(pass.calls, name);
        if (name === 'setPipeline' && args[0].label) pass.pipeline = args[0].label;
        if (name === 'draw' || name === 'drawIndexed') add(pass, 'triangles', args[0] * args[1] / 3);
      }
      if (!capture.active) return original.apply(this, args);
      const start = performance.now();
      try { return original.apply(this, args); }
      finally {
        const duration = performance.now() - start;
        add(capture.calls, name); add(capture.apiMs, name, duration);
        add(frameCalls, name); add(frameAPIMs, name, duration);
      }
    };
  }
  for (const [kind, prototype, begin] of [
    ['render', GPURenderPassEncoder.prototype, 'beginRenderPass'],
    ['compute', GPUComputePassEncoder.prototype, 'beginComputePass']
  ]) {
    const original = GPUCommandEncoder.prototype[begin], end = prototype.end;
    GPUCommandEncoder.prototype[begin] = function(descriptor = {}) {
      if (!capture.active && !pendingGPU) return original.call(this, descriptor);
      const attachment = descriptor.colorAttachments?.find(Boolean)?.view || descriptor.depthStencilAttachment?.view;
      const target = views.get(attachment);
      const entry = {kind, label: descriptor.label || target?.label || kind, target,
        start: now(), calls: {}, triangles: 0};
      if (pendingGPU && pendingGPU.entries.length < 1024) {
        const offset = pendingGPU.entries.length * 2;
        pendingGPU.entries.push(entry);
        descriptor = {...descriptor, timestampWrites: {querySet: query,
          beginningOfPassWriteIndex: offset, endOfPassWriteIndex: offset + 1}};
      }
      const result = original.call(this, descriptor);
      passes.set(result, entry);
      return result;
    };
    prototype.end = function() {
      const entry = passes.get(this);
      if (entry) {
        entry.end = now(); entry.cpuMs = entry.end - entry.start;
        if (capture.active && capture.passes.length < 200000) capture.passes.push(entry);
      }
      return end.call(this);
    };
  }
  const gameTimes = [];
  Object.defineProperty(gameTimes, 'push', {value: function(value) {
    if (capture.active) (capture.gameTicks ||= []).push({end: now(), milliseconds: value});
    return Array.prototype.push.call(this, value);
  }});
  globalThis.__webThreadFrameTimes = gameTimes;
  Object.defineProperty(globalThis, '__webRHIFrames', {enumerable: true, configurable: true,
    get: () => presented, set(value) {
      if (value <= presented) return;
      const time = now();
      if (capture.active) capture.frames.push({presented: value, time,
        intervalMs: previousPresent === undefined ? null : time - previousPresent,
        rhiWorkTotal: globalThis.__webThreadStages?.rhiWorkMilliseconds, calls: frameCalls, apiMs: frameAPIMs});
      frameCalls = {}; frameAPIMs = {}; previousPresent = time; presented = value;
      // Arm at a present boundary so the first capture includes a complete frame.
      if (!pendingGPU) {
        if (requestedGPU) { pendingGPU = requestedGPU; requestedGPU = null; }
        return;
      }
      const completed = pendingGPU; pendingGPU = null;
      const count = completed.entries.length * 2;
      if (!count) { gpuBusy = false; completed.reject(Error('No GPU passes in sampled frame')); return; }
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(query, 0, count, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readback, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const times = new BigUint64Array(readback.getMappedRange());
        const origin = times[0];
        const entries = completed.entries.map((entry, index) => ({...entry,
          gpuStartMs: Number(times[index * 2] - origin) / 1e6,
          gpuMs: Number(times[index * 2 + 1] - times[index * 2]) / 1e6}));
        readback.unmap(); gpuBusy = false;
        completed.resolve({presented: value, entries, totalPassMs: entries.reduce((sum, e) => sum + e.gpuMs, 0)});
      }, error => { gpuBusy = false; completed.reject(error); });
    }});
  globalThis.__webStartPerformanceCapture = () => {
    capture.frames = []; capture.passes = []; capture.calls = {}; capture.apiMs = {}; capture.gameTicks = [];
    frameCalls = {}; frameAPIMs = {}; capture.start = now(); capture.active = true;
  };
  globalThis.__webStopPerformanceCapture = () => { capture.active = false; capture.end = now(); return capture; };
  globalThis.__webCaptureGPUFrame = () => !query ? Promise.resolve({unsupported: true}) :
    new Promise((resolve, reject) => {
      if (gpuBusy) { reject(Error('GPU capture already pending')); return; }
      gpuBusy = true; requestedGPU = {entries: [], resolve, reject};
    });
};
