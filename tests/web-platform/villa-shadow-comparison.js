'use strict';
(() => {
  const element = id => document.getElementById(id), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const initialCamera = {x: -175, y: -80, z: 160, pitch: -5, yaw: 50};
  const controls = ['reset', 'route', 'run', 'stop', 'export'].map(element);
  const radios = [...document.querySelectorAll('[name="mode"]')];
  const compact = matchMedia('(max-width: 660px)');
  const state = globalThis.__shadowComparison = {mode: null, ready: false, busy: false,
    camera: {...initialCamera}, observations: {}, error: null};
  let frame, generation = 0, running = false, routeSerial = 0, began = 0;
  const number = value => Number.isFinite(value) ? value.toFixed(1) : '待采样';
  const cameraValid = value => value && ['x', 'y', 'z', 'pitch', 'yaw'].every(key => Number.isFinite(value[key]));
  const windowFor = () => frame?.contentWindow;
  function layout() {
    document.querySelector('footer details').open = !compact.matches;
    const hud = windowFor()?.document.getElementById('web-performance-hud');
    if (hud) hud.style.display = compact.matches ? 'none' : '';
  }
  function status(text, error = false) {
    element('status').textContent = text; element('status').dataset.error = String(error);
  }
  function buttons() {
    for (const control of controls) control.disabled = !state.ready || state.busy;
    element('stop').disabled = !state.ready || !running;
    element('run').disabled ||= running;
    element('reset').disabled ||= running;
    for (const radio of radios) radio.disabled = state.busy;
  }
  function fail(error) {
    state.error = error.message || String(error); state.ready = false; state.busy = false;
    running = false; buttons(); status(state.error, true);
    element('loading-title').textContent = '场景未能启动';
    element('loading-detail').textContent = state.error;
    element('loading').hidden = false; element('retry').hidden = false;
  }
  async function pose(camera) {
    const child = windowFor();
    if (await child.__webEngineRPC('WebMotionBenchmarkControl', 0, 0) <= 0) throw Error('停止路线失败');
    if (await child.__webEngineRPC('WebProjectViewTest', camera.x, camera.y, camera.z, camera.pitch, camera.yaw) !== 1)
      throw Error('恢复相机失败');
    state.camera = {...camera}; running = false;
  }
  function verify(child) {
    const settings = child.__webProjectSettings, view = child.__webRenderView;
    if (!settings || !view) return false;
    if (settings.virtualShadows !== Number(state.mode === 'on') ||
        settings.virtualShadowPathActive !== (state.mode === 'on'))
      throw Error('实际阴影模式与选项不一致');
    if (settings.gi !== 1 || settings.reflections !== 1 || settings.virtualTextures !== 1 ||
        !settings.virtualTexturePathActive || view.antiAliasing !== 4)
      throw Error('Lumen、虚拟纹理或 TSR 配置不一致');
    if (view.outputWidth !== 1920 || view.outputHeight !== 1080 || view.width !== 1400 || view.height !== 788)
      throw Error(`实际尺寸不一致：${view.width} × ${view.height} → ${view.outputWidth} × ${view.outputHeight}`);
    return true;
  }
  async function select(mode) {
    const ticket = ++generation, previous = windowFor();
    if (state.ready && cameraValid(previous?.__webDefaultCamera)) state.camera = {...previous.__webDefaultCamera};
    state.mode = mode; state.ready = false; state.busy = true; state.error = null; running = false;
    state.started = new Date().toISOString(); began = performance.now();
    buttons(); for (const radio of radios) radio.checked = radio.value === mode;
    history.replaceState(null, '', '#' + mode);
    element('loading').hidden = false; element('retry').hidden = true;
    element('loading-title').textContent = mode === 'on' ? '加载虚拟阴影场景' : '加载传统阴影场景';
    element('loading-detail').textContent = '准备资源与管线';
    for (const name of ['fps', 'low', 'render-size', 'aa']) element(name).textContent = '待采样';
    element('quality').textContent = 'Lumen / VT 待确认'; status('正在切换');
    frame?.remove(); frame = null;
    await sleep(500);
    if (ticket !== generation) return;
    frame = document.createElement('iframe');
    frame.title = mode === 'on' ? '虚拟阴影开启的别墅' : '传统阴影的别墅';
    frame.allow = 'cross-origin-isolated; fullscreen; autoplay';
    frame.src = `build/villa-shadow-${mode}-20261111/index.html`;
    element('stage').prepend(frame);
    try {
      for (let attempt = 0; attempt < 1500; ++attempt) {
        if (ticket !== generation) return;
        const child = windowFor();
        if (child.__webEngineFailure) throw Error(String(child.__webEngineFailure));
        element('loading-detail').textContent = `加载中 · ${Math.floor((performance.now() - began) / 1000)} 秒`;
        if (child.__webEngineFrames >= 60 && child.__webPSOPrecacheReady &&
            child.document.getElementById('loading')?.hidden && verify(child)) {
          if (!child.__webPipelinePrewarm?.ready || !child.__webPipelinePrewarm.adopted)
            throw Error('管线预热未生效');
          await pose(state.camera);
          await sleep(300);
          if (ticket !== generation) return;
          state.ready = true; state.busy = false;
          element('loading').hidden = true; layout(); buttons(); update();
          return;
        }
        await sleep(200);
      }
      throw Error('加载超时');
    } catch (error) {if (ticket === generation) fail(error);}
  }
  function update() {
    if (!state.ready) return;
    try {
      const child = windowFor();
      if (child.__webEngineFailure) throw Error(String(child.__webEngineFailure));
      verify(child);
      const live = child.__webLivePerformance, view = child.__webRenderView;
      if (cameraValid(child.__webDefaultCamera)) state.camera = {...child.__webDefaultCamera};
      if (running && child.__webMotionBenchmark?.serial === routeSerial &&
          child.__webMotionBenchmark.completed) {running = false; buttons();}
      const metrics = live?.submitted;
      element('fps').textContent = number(metrics?.fps);
      element('low').textContent = number(metrics?.low);
      element('render-size').textContent = `${view.width} × ${view.height}`;
      element('output-size').textContent = `${view.outputWidth} × ${view.outputHeight}`;
      element('aa').textContent = 'TSR'; element('quality').textContent = 'Lumen 开启 · VT 开启';
      state.observations[state.mode] = {date: new Date().toISOString(), mode: state.mode, metrics,
        view, camera: {...state.camera}, settings: child.__webProjectSettings, prewarm: child.__webPipelinePrewarm};
      status((state.mode === 'on' ? '虚拟阴影已开启' : '传统阴影已启用') +
        (running ? ` · 路线 ${Math.min(30, Math.floor(child.__webMotionBenchmark?.elapsed || 0))}/30 秒` : ' · 就绪'));
    } catch (error) {fail(error);}
  }
  for (const radio of radios) radio.addEventListener('change', () => select(radio.value));
  element('retry').onclick = () => select(state.mode);
  element('reset').onclick = async () => {
    try {await pose(initialCamera); update();} catch (error) {fail(error);}
  };
  element('run').onclick = async () => {
    if (!state.ready || running) return;
    try {
      const child = windowFor(), mode = Number(element('route').value);
      state.busy = true; buttons();
      await pose(initialCamera);
      const serial = await child.__webEngineRPC('WebMotionBenchmarkControl', mode, 30);
      if (serial <= 0) throw Error('启动路线失败');
      routeSerial = serial; running = true; state.busy = false; buttons();
    } catch (error) {fail(error);}
  };
  element('stop').onclick = async () => {
    try {
      const camera = windowFor().__webDefaultCamera;
      await pose(cameraValid(camera) ? camera : state.camera); buttons(); update();
    } catch (error) {fail(error);}
  };
  element('export').onclick = () => {
    const record = {date: new Date().toISOString(), currentMode: state.mode, observations: state.observations,
      boundary: 'Each mode is a separate load, only one scene runs at a time. Live 1% Low uses a rolling five-second submission window; last observations are not a controlled benchmark.'};
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a'); link.href = url; link.download = 'villa-shadow-comparison.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.ready && running)
      element('stop').click();
  });
  compact.addEventListener('change', layout);
  layout();
  window.addEventListener('hashchange', () => {
    const mode = location.hash === '#off' ? 'off' : 'on';
    if (mode !== state.mode) select(mode);
  });
  fetch('evidence/shadow-methods-low-20261111.json').then(response => {
    if (!response.ok) throw Error('基准记录未找到'); return response.json();
  }).then(record => {
    const names = {standing: '静止', turning: '转向', moving: '往返移动'};
    element('baseline').replaceChildren(...record.comparisons.map(row => {
      const tr = document.createElement('tr');
      for (const [index, text] of [names[row.name], `${number(row.off.fps)} / ${number(row.off.low1Fps)}`,
        `${number(row.on.fps)} / ${number(row.on.low1Fps)}`, `${number(row.low1CostPercent)}%`].entries()) {
        const td = document.createElement('td'); td.textContent = text;
        if (index === 1 || index === 2) td.className = index === 1 ? 'off' : 'on';
        tr.append(td);
      }
      return tr;
    }));
  }).catch(error => {element('baseline').textContent = error.message;});
  setInterval(update, 250);
  select(location.hash === '#off' ? 'off' : 'on');
})();
