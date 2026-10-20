module.exports = function captureWebCanvas() {
  const state = {configurations: [], acquisitions: [], debugMarkers: [], failures: [],
    queueSubmissions: 0, submittedCommandBuffers: 0, shaderModules: 0,
    renderPipelines: 0, computePipelines: 0, renderPasses: 0, drawCalls: 0, dispatchCalls: 0,
    depthTextures: [], depthViews: [], depthPasses: [], gpuErrors: []};
  const observedDevices = new WeakSet();
  const depthViews = new WeakMap();
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    if (texture.format === 'depth24plus-stencil8')
      state.depthTextures.push({label: texture.label, width: texture.width, height: texture.height,
        format: texture.format, usage: texture.usage, mipLevelCount: texture.mipLevelCount,
        sampleCount: texture.sampleCount});
    return texture;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(descriptor) {
    const view = createView.call(this, descriptor);
    if (this.format === 'depth24plus-stencil8') {
      const info = {texture: this.label, format: descriptor?.format || this.format,
        aspect: descriptor?.aspect || 'all', usage: descriptor?.usage ?? this.usage};
      state.depthViews.push(info);
      depthViews.set(view, info);
    }
    return view;
  };
  const beginRenderPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function(descriptor) {
    const pass = beginRenderPass.call(this, descriptor);
    const attachment = descriptor.depthStencilAttachment;
    if (attachment) {
      state.depthPasses.push({label: descriptor.label || '', view: depthViews.get(attachment.view) || null,
        depthReadOnly: attachment.depthReadOnly || false, stencilReadOnly: attachment.stencilReadOnly || false,
        depthLoadOp: attachment.depthLoadOp || null, depthStoreOp: attachment.depthStoreOp || null,
        stencilLoadOp: attachment.stencilLoadOp || null, stencilStoreOp: attachment.stencilStoreOp || null,
        depthClearValue: attachment.depthClearValue ?? null, stencilClearValue: attachment.stencilClearValue ?? null});
    }
    return pass;
  };
  for (const [prototype, name, counter] of [
    [GPUDevice.prototype, 'createShaderModule', 'shaderModules'],
    [GPUDevice.prototype, 'createRenderPipeline', 'renderPipelines'],
    [GPUDevice.prototype, 'createComputePipeline', 'computePipelines'],
    [GPUCommandEncoder.prototype, 'beginRenderPass', 'renderPasses'],
    [GPURenderPassEncoder.prototype, 'draw', 'drawCalls'],
    [GPURenderPassEncoder.prototype, 'drawIndexed', 'drawCalls'],
    [GPUComputePassEncoder.prototype, 'dispatchWorkgroups', 'dispatchCalls']
  ]) {
    const original = prototype[name];
    prototype[name] = function(...args) {
      const result = original.apply(this, args);
      ++state[counter];
      return result;
    };
  }
  let device;
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(commandBuffers) {
    submit.call(this, commandBuffers);
    ++state.queueSubmissions;
    state.submittedCommandBuffers += commandBuffers.length;
  };
  for (const [kind, prototype] of [
    ['command', GPUCommandEncoder.prototype], ['renderPass', GPURenderPassEncoder.prototype]
  ]) {
    const insertDebugMarker = prototype.insertDebugMarker;
    prototype.insertDebugMarker = function(label) {
      insertDebugMarker.call(this, label);
      state.debugMarkers.push({kind, label});
    };
  }
  const configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function(configuration) {
    configure.call(this, configuration);
    device = configuration.device;
    if (!observedDevices.has(device)) {
      observedDevices.add(device);
      device.addEventListener('uncapturederror', event => state.gpuErrors.push(event.error.message));
    }
    const actual = this.getConfiguration();
    state.configurations.push({
      canvas: this.canvas.id, width: this.canvas.width, height: this.canvas.height,
      format: actual.format, usage: actual.usage, alphaMode: actual.alphaMode,
      deviceMatched: actual.device === configuration.device,
      cssWidth: this.canvas.getBoundingClientRect().width,
      cssHeight: this.canvas.getBoundingClientRect().height,
      devicePixelRatio: globalThis.devicePixelRatio
    });
  };
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function() {
    const texture = getCurrentTexture.call(this);
    state.acquisitions.push({width: texture.width, height: texture.height,
      format: texture.format, usage: texture.usage});
    return texture;
  };
  globalThis.__webCanvas = state;
  globalThis.__webCanvasWaitIdle = async () => {
    if (!device) return {pass: false, reason: 'Canvas device is unavailable'};
    await device.queue.onSubmittedWorkDone();
    return {pass: true, queueSubmissions: state.queueSubmissions,
      submittedCommandBuffers: state.submittedCommandBuffers};
  };
};
