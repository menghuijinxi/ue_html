(function observeSlateLayout() {
  'use strict';
  const state = globalThis.__webSlateLayoutProbe = {
    enabled: false, pipelines: 0, drawCount: 0, zeroInstances: 0, draws: [], lastDraw: null
  };
  const shaders = new WeakSet(), pipelines = new WeakSet(), passes = new WeakMap();
  const wrap = (prototype, name, callback) => {
    const original = prototype[name];
    prototype[name] = function(...args) {return callback.call(this, original, args);};
  };
  wrap(GPUDevice.prototype, 'createShaderModule', function(original, args) {
    const result = original.apply(this, args);
    if (args[0].code.includes('SlateView_ViewProjection')) shaders.add(result);
    return result;
  });
  const remember = (pipeline, descriptor) => {
    if (shaders.has(descriptor.vertex.module)) {
      pipelines.add(pipeline);
      ++state.pipelines;
    }
    return pipeline;
  };
  for (const name of ['createRenderPipeline', 'createRenderPipelineAsync'])
    wrap(GPUDevice.prototype, name, function(original, args) {
      const result = original.apply(this, args);
      return result.then ? result.then(pipeline => remember(pipeline, args[0])) : remember(result, args[0]);
    });
  wrap(GPUCommandEncoder.prototype, 'beginRenderPass', function(original, args) {
    const result = original.apply(this, args);
    passes.set(result, {slate: false, viewport: null, scissor: null});
    return result;
  });
  wrap(GPURenderPassEncoder.prototype, 'setPipeline', function(original, args) {
    passes.get(this).slate = pipelines.has(args[0]);
    return original.apply(this, args);
  });
  for (const [name, field] of [['setViewport', 'viewport'], ['setScissorRect', 'scissor']])
    wrap(GPURenderPassEncoder.prototype, name, function(original, args) {
      passes.get(this)[field] = args;
      return original.apply(this, args);
    });
  wrap(GPURenderPassEncoder.prototype, 'drawIndexed', function(original, args) {
    const pass = passes.get(this);
    if (state.enabled && pass.slate) {
      ++state.drawCount;
      if (args[1] === 0) ++state.zeroInstances;
      state.lastDraw = {args, viewport: pass.viewport, scissor: pass.scissor};
      if (state.draws.length < 32) state.draws.push(state.lastDraw);
    }
    return original.apply(this, args);
  });
  globalThis.__webSlateLayoutSnapshot = () => structuredClone(state);
})();
