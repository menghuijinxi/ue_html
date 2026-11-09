'use strict';
(() => {
  const owner = typeof document === 'undefined';
  const now = () => performance.timeOrigin + performance.now();
  const state = globalThis.__villaStartupProbe = {
    origin: performance.timeOrigin, owner, marks: [], calls: {}, pending: 0, peakPending: 0,
    errors: [], presents: 0
  };
  const mark = (name, detail) => state.marks.push({name, at: now(), ...detail});
  const wrap = (object, key, name) => {
    const original = object?.[key];
    if (!original) return;
    object[key] = function(...args) {
      const start = now();
      const result = original.apply(this, args);
      if (result?.then) result.then(() => mark(name, {start}), error => mark(name, {start, error: String(error)}));
      else mark(name, {start});
      return result;
    };
  };
  mark('probe.loaded');
  for (const name of ['instantiate', 'instantiateStreaming', 'compile', 'compileStreaming'])
    wrap(WebAssembly, name, 'wasm.' + name);
  if (navigator.gpu) wrap(navigator.gpu, 'requestAdapter', 'gpu.adapter');
  if (typeof GPUAdapter !== 'undefined') wrap(GPUAdapter.prototype, 'requestDevice', 'gpu.device');
  if (typeof GPUDevice !== 'undefined') {
    for (const name of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline',
      'createRenderPipelineAsync', 'createComputePipelineAsync']) {
      const original = GPUDevice.prototype[name];
      GPUDevice.prototype[name] = function(...args) {
        const call = state.calls[name] ||= {count: 0, jsMs: 0, first: now(), last: 0, failed: 0};
        ++call.count;
        const start = now(), result = original.apply(this, args);
        call.jsMs += now() - start; call.last = now();
        if (result?.then) {
          state.peakPending = Math.max(state.peakPending, ++state.pending);
          result.then(() => {--state.pending; call.lastCompleted = now();},
            error => {--state.pending; ++call.failed; state.errors.push(String(error));});
        }
        return result;
      };
    }
    const get = GPUCanvasContext.prototype.getCurrentTexture;
    GPUCanvasContext.prototype.getCurrentTexture = function(...args) {
      const result = get.apply(this, args);
      if (++state.presents <= 2) mark('canvas.' + state.presents);
      return result;
    };
  }
  if (owner) {
    const send = globalThis.postMessage;
    const snapshot = () => send.call(globalThis, {type: 'startup-probe', state: {
      ...state, at: now(), pso: globalThis.__webPSOPrecache, rhi: globalThis.__webOptimizationRHI,
      io: globalThis.__webContentIO?.stats, frames: globalThis.__webRHIFrames
    }});
    globalThis.postMessage = function(message, ...args) {
      if (message.type === 'stage') mark('stage.' + message.stage);
      if (message.type === 'log' && /^P3_ENGINE_(READY|WORLD|THREADS) /.test(message.text))
        mark('log', {text: message.text});
      if (message.type === 'failure') {mark('failure', {error: message.message}); snapshot();}
      return send.call(this, message, ...args);
    };
    const imports = globalThis.importScripts;
    globalThis.importScripts = function(...args) {
      const start = now(), result = imports.apply(this, args);
      mark('script', {start, urls: args});
      if (globalThis.WebLocalContentIO && !WebLocalContentIO.prototype.__startupObserved) {
        WebLocalContentIO.prototype.__startupObserved = true;
        wrap(WebLocalContentIO.prototype, 'asset', 'io.asset');
        wrap(WebLocalContentIO.prototype, 'mount', 'io.mount');
      }
      return result;
    };
    setInterval(snapshot, 250);
  } else {
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('web-engine-worker.js')) {
          mark('engine.worker');
          this.addEventListener('message', event => {
            if (event.data.type === 'startup-probe') globalThis.__villaStartupWorker = event.data.state;
          });
        }
      }
    };
    window.addEventListener('ue-ready', () => mark('official.ready'));
    let shown = false;
    new MutationObserver(() => {
      if (!shown && document.getElementById('loading')?.hidden) {shown = true; mark('ours.visible');}
    }).observe(document, {subtree: true, attributes: true, childList: true, attributeFilter: ['hidden']});
  }
})();
