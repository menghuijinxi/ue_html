'use strict';
(() => {
  const element = id => document.getElementById(id), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const keys = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'controlPitch', 'controlYaw', 'controlRoll'];
  const variants = {
    old: {folder: 'villa-vsm-sampling-adaptive-20261112', label: '老版 · 自适应'},
    large: {folder: 'villa-tsr-tiles-20261112', label: '上版 · 32×32'},
    small: {folder: 'villa-tsr-small-20261112', label: '回退版 · 16×16'},
  };
  const poses = {kitchen: [-175, -80, 160, -5, 230], interior: [-175, -80, 160, -5, 50],
    living: [-20, 200, 130, 12, -35]};
  const state = globalThis.__villaSmoothnessLive = {mode: null, ready: false, busy: false, error: null,
    player: null, observations: {}, diagnosticOnly: true};
  const radios = [...document.querySelectorAll('[name=mode]')];
  let frame, generation = 0, spawn, cameraOffset;
  const valid = value => value && keys.every(key => Number.isFinite(value[key]));
  const childWindow = () => frame?.contentWindow;
  const number = value => Number.isFinite(value) ? value.toFixed(1) : '待采样';
  function status(text, error = false) {
    element('status').textContent = text; element('status').dataset.error = String(error);
  }
  function controls() {
    for (const id of ['viewpoint', 'reset', 'export']) element(id).disabled = !state.ready || state.busy;
    for (const radio of radios) radio.disabled = state.busy;
  }
  function focus() {
    const child = childWindow();
    child?.focus(); child?.document.getElementById('canvas')?.focus({preventScroll: true});
  }
  function resetMetrics() {
    const child = childWindow();
    child.document.querySelector('#web-performance-hud [data-action=reset]')?.click();
    child.__webLivePerformance = undefined;
  }
  function fail(error) {
    state.error = error.message || String(error); state.ready = state.busy = false;
    controls(); status(state.error, true);
    element('loading').hidden = false; element('retry').hidden = false;
    element('loading-title').textContent = '场景未能运行';
    element('loading-detail').textContent = state.error;
  }
  function verify(child) {
    if (child.__webEngineFailure) throw Error(String(child.__webEngineFailure));
    const settings = child.__webProjectSettings, view = child.__webRenderView;
    if (!settings || !view) return false;
    if (settings.virtualShadows !== 1 || !settings.virtualShadowPathActive ||
        settings.gi !== 1 || settings.reflections !== 1 || settings.virtualTextures !== 1 ||
        !settings.virtualTexturePathActive) throw Error('VSM、Lumen 或虚拟纹理未按预期启用');
    if (view.width !== 1400 || view.height !== 788 || view.outputWidth !== 1920 ||
        view.outputHeight !== 1080 || view.antiAliasing !== 4) throw Error('实际分辨率或 TSR 配置不一致');
    const sampling = state.mode === 'old' ? child.__webVSMAdaptiveProbe : child.__webVSMAdaptiveSampling;
    if (!sampling?.enabled || sampling.errors?.length) throw Error('自适应采样未生效');
    if (state.mode !== 'old') {
      const rhi = child.__webOcclusionRHI;
      if (!rhi || rhi.indirectDrawReuse !== 2 || rhi.vsmPageOptimization !== 3)
        throw Error('间接绘制或页同步配置不一致');
    }
    return true;
  }
  async function restore(player) {
    const child = childWindow(), serial = await child.__webEngineRPC('WebPlayerViewControl', player ? 1 : 0,
      ...keys.map(key => player ? player[key] : 0));
    if (serial <= 0) throw Error('玩家控制未就绪');
    const settled = child.__webEngineFrames + 2;
    for (let attempt = 0; attempt < 100; ++attempt) {
      const current = child.__webPlayerView;
      if (current?.serial === serial && current.active && valid(current) &&
          child.__webEngineFrames >= settled) return {...current};
      await sleep(100);
    }
    throw Error('等待玩家视角超时');
  }
  function update() {
    if (!state.ready) return;
    try {
      const child = childWindow();
      if (!verify(child)) throw Error('运行状态不可用');
      const view = child.__webRenderView, live = child.__webLivePerformance?.submitted;
      if (!state.busy && valid(child.__webPlayerView)) state.player = {...child.__webPlayerView};
      element('fps').textContent = number(live?.fps); element('low').textContent = number(live?.low);
      element('p99').textContent = number(live?.p99Ms) + ' ms';
      element('long-frames').textContent = String(live?.over50ms ?? '待采样');
      element('render-size').textContent = `${view.width} × ${view.height}`;
      element('output-size').textContent = `${view.outputWidth} × ${view.outputHeight}`;
      element('aa').textContent = 'TSR'; element('quality').textContent = 'Lumen 开启 · VT 开启 · VSM 开启';
      state.observations[state.mode] = {date: new Date().toISOString(), player: state.player,
        camera: child.__webDefaultCamera, metrics: live, view, settings: child.__webProjectSettings,
        sampling: child.__webVSMAdaptiveSampling || child.__webVSMAdaptiveProbe,
        prewarm: child.__webPipelinePrewarm, rhi: child.__webOcclusionRHI};
      status(variants[state.mode].label + ' · 就绪');
    } catch (error) {fail(error);}
  }
  async function select(mode) {
    const ticket = ++generation, previous = childWindow();
    if (state.ready && valid(previous?.__webPlayerView)) state.player = {...previous.__webPlayerView};
    state.mode = mode; state.ready = false; state.busy = true; state.error = null; controls();
    for (const radio of radios) radio.checked = radio.value === mode;
    history.replaceState(null, '', '#' + mode);
    element('loading').hidden = false; element('retry').hidden = true;
    element('loading-title').textContent = '加载' + variants[mode].label;
    for (const id of ['fps', 'low', 'p99', 'long-frames', 'render-size', 'output-size', 'aa'])
      element(id).textContent = '待确认';
    element('quality').textContent = 'Lumen / VT / VSM 待确认'; status('准备资源与管线');
    frame?.remove(); frame = null;
    await sleep(2000);
    if (ticket !== generation) return;
    frame = document.createElement('iframe'); frame.title = 'Triplex Villa · ' + variants[mode].label;
    frame.allow = 'cross-origin-isolated; fullscreen; autoplay';
    frame.src = `build/${variants[mode].folder}/index.html`;
    element('stage').prepend(frame);
    const began = performance.now();
    try {
      for (let attempt = 0; attempt < 1200; ++attempt) {
        if (ticket !== generation) return;
        const child = childWindow();
        if (child.__webEngineFailure) throw Error(String(child.__webEngineFailure));
        element('loading-detail').textContent = `加载中 · ${Math.floor((performance.now() - began) / 1000)} 秒`;
        if (child.__webEngineFrames >= 60 && child.__webPSOPrecacheReady &&
            child.document.getElementById('loading')?.hidden && verify(child)) {
          if (!child.__webPipelinePrewarm?.ready || !child.__webPipelinePrewarm.adopted)
            throw Error('实际管线预热未生效');
          const saved = state.player, initial = await restore(null);
          if (ticket !== generation) return;
          spawn ||= {...initial};
          cameraOffset ||= Object.fromEntries(['x', 'y', 'z'].map(key =>
            [key, child.__webDefaultCamera[key] - initial[key]]));
          state.player = saved ? await restore(saved) : initial;
          if (ticket !== generation) return;
          resetMetrics();
          state.ready = true; state.busy = false; element('loading').hidden = true;
          const hud = child.document.getElementById('web-performance-hud');
          if (hud) hud.style.display = 'none';
          controls(); update(); focus(); return;
        }
        await sleep(200);
      }
      throw Error('加载超时');
    } catch (error) {if (ticket === generation) fail(error);}
  }
  async function move(player) {
    if (!state.ready || state.busy) return;
    state.busy = true; controls();
    try {state.player = await restore(player); resetMetrics(); state.busy = false; controls(); update(); focus();}
    catch (error) {fail(error);}
  }
  element('viewpoint').onchange = () => {
    const pose = poses[element('viewpoint').value];
    if (!pose) {focus(); return;}
    const [x, y, z, pitch, yaw] = pose;
    move({...spawn, x: x - cameraOffset.x, y: y - cameraOffset.y, z: z - cameraOffset.z,
      pitch: 0, yaw, roll: 0, controlPitch: pitch, controlYaw: yaw, controlRoll: 0});
  };
  element('reset').onclick = () => {element('viewpoint').value = 'current'; move(spawn);};
  element('retry').onclick = () => select(state.mode);
  for (const radio of radios) radio.onchange = () => select(radio.value);
  window.addEventListener('hashchange', () => {
    const mode = location.hash.slice(1) in variants ? location.hash.slice(1) : 'small';
    if (mode !== state.mode) select(mode);
  });
  element('export').onclick = () => {
    const record = {date: new Date().toISOString(), diagnosticOnly: true, observations: state.observations,
      boundary: 'One live scene. Player pose is restored on switch; temporal history restarts. ' +
        'Rolling five-second RHI submission statistics do not establish input latency or physical presentation.'};
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'villa-smoothness-live.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  setInterval(update, 250);
  select(location.hash.slice(1) in variants ? location.hash.slice(1) : 'small');
})();
