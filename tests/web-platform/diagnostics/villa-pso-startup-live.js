'use strict';
(() => {
  let mode, currentFrame, began = 0, startupObserved;
  setInterval(() => {
    const live = globalThis.__villaGitHistory, frame = document.querySelector('iframe'), scene = frame?.contentWindow;
    if (!live) return;
    if (mode !== live.mode || currentFrame !== frame) {
      mode = live.mode; currentFrame = frame; began = performance.now(); startupObserved = null;
    }
    const display = document.getElementById('startup-ms');
    if (!live.ready) display.textContent = ((performance.now() - began) / 1000).toFixed(1) + ' s';
    if (!scene) return;
    const warm = scene.__webPipelinePrewarm, pso = scene.__webPSOPrecache;
    const rhi = scene.__webOptimizationRHI, variant = __villaHistoryVariants[mode];
    const automatic = document.getElementById('automatic-pso');
    automatic.textContent = !variant.automatic ? '关闭' : !rhi ? '等待引擎' :
      rhi.asyncPrecacheCompleted + ' / ' + rhi.asyncPrecacheRequested +
      ' · 排队 ' + (pso?.active ?? '—') + ' · 失败 ' + rhi.asyncPrecacheFailed;
    automatic.style.color = rhi?.asyncPrecacheFailed ? '#ffb8a9' : '';
    if (live.ready && !startupObserved) {
      const seconds = (performance.now() - began) / 1000;
      display.textContent = seconds.toFixed(1) + ' s';
      startupObserved = {seconds, automaticFailures: rhi?.asyncPrecacheFailed || 0};
    }
    if (!live.ready) return;
    const observation = live.observations[mode];
    if (observation) Object.assign(observation, {automaticPSO: pso, automaticRHI: rhi, startupPrewarm: warm,
      startupObserved});
  }, 250);
})();
