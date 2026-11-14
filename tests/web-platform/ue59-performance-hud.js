(() => {
  'use strict';
  const canvas = document.getElementById('canvas');
  if (!canvas || typeof GPUCanvasContext === 'undefined' || !crossOriginIsolated) return;
  const counter = new Uint32Array(new SharedArrayBuffer(4));
  const hud = createWebPerformanceHUD(counter, canvas, {source: 'final-canvas-submission-intervals'});
  const state = globalThis.__ue59Performance = {submitted: 0, scene: null, canvas: null, errors: []};
  const element = document.getElementById('web-performance-hud');
  Object.assign(element.style, {left: 'auto', right: '12px'});
  const resolution = document.createElement('div');
  const precache = document.createElement('div');
  resolution.dataset.stat = 'resolution';
  precache.dataset.stat = 'precache';
  for (const node of [resolution, precache]) {
    Object.assign(node.style, {fontSize: '11px', color: '#a7c0b6'});
    element.append(node);
  }
  let pending = false, times = [], lastUpdate = 0, raf;
  const getTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function(...args) {
    const texture = getTexture.apply(this, args);
    if (this.canvas === canvas) {
      pending = true;
      state.canvas = {width: texture.width, height: texture.height};
    }
    return texture;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    if (descriptor.label === 'SceneColor') state.scene = {width: texture.width, height: texture.height};
    return texture;
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(...args) {
    const result = submit.apply(this, args);
    if (pending) {
      pending = false;
      times.push(performance.now());
      Atomics.store(counter, 0, ++state.submitted);
    }
    return result;
  };
  function update(now) {
    if (now - lastUpdate >= 100) {
      hud.ingest({timeOrigin: performance.timeOrigin, at: now, times, events: []});
      times = [];
      const size = state.scene || state.canvas;
      resolution.textContent = size ? `渲染 ${size.width} × ${size.height} · 输出 ${canvas.width} × ${canvas.height}` : '等待渲染尺寸';
      if (window.uePrewarm?.summary) {
        const summary = window.uePrewarm.summary();
        state.prewarm = summary;
        const hits = summary.hits;
        const count = (hits?.render?.hit || 0) + (hits?.compute?.hit || 0);
        precache.textContent = count ? `PSO 预热命中 ${count}` : 'PSO 预热命中 0';
      }
      lastUpdate = now;
    }
    raf = requestAnimationFrame(update);
  }
  document.addEventListener('visibilitychange', () => { times = []; pending = false; });
  window.addEventListener('pagehide', () => { cancelAnimationFrame(raf); hud.dispose(); }, {once: true});
  raf = requestAnimationFrame(update);
})();
