(() => {
  const style = document.createElement('style');
  style.textContent = `
    #lab { position:fixed; top:0; left:0; right:0; z-index:3; padding:10px 16px;
      background:#171a1df2; color:#edf0f2; font:13px/1.5 system-ui,sans-serif;
      border-bottom:1px solid #50575c; box-sizing:border-box; }
    #lab[hidden] { display:none; }
    #lab-main { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
    #lab strong { font-size:16px; margin-right:8px; }
    #lab select { color:inherit; background:#30363b; border:1px solid #657078; border-radius:3px;
      padding:4px; font:inherit; max-width:100%; }
    #lab label { display:inline-flex; align-items:center; gap:5px; white-space:nowrap; }
    #lab input { accent-color:#69d5ae; }
    #lab-readout { display:flex; gap:16px; flex-wrap:wrap; margin-top:5px; color:#c3cdd4;
      font-variant-numeric:tabular-nums; }
    #lab-frame { margin-left:auto; font-variant-numeric:tabular-nums; }
    @media(max-width:600px) { #lab { padding:6px 10px; } #lab-main { gap:6px 12px; }
      #lab-readout { gap:2px 12px; font-size:11px; } #lab strong { font-size:14px; } }
  `;
  document.head.append(style);
  const panel = document.createElement('section');
  panel.id = 'lab';
  panel.hidden = true;
  panel.setAttribute('aria-label', '材质测试');
  panel.innerHTML = `<div id="lab-main"><strong>UE 材质测试场</strong>
    <select id="lab-view" aria-label="观察组">
      <option value="overview">全景</option><option value="roughness">粗糙度</option>
      <option value="metal">金属</option><option value="specular">高光</option>
      <option value="opacity">透明度</option><option value="shadows">阴影</option>
    </select>
    <select id="lab-light" aria-label="光照对照">
      <option value="0">完整光照</option><option value="1">关闭太阳直射</option>
      <option value="2">关闭天空光及环境反射</option>
      <option value="3">关闭太阳高光</option><option value="4">关闭阴影</option>
    </select>
    <label>阴影<select id="lab-shadow" aria-label="每级阴影分辨率">
      <option value="1024">1024 · 16 MiB</option>
      <option value="2048" selected>2048 · 64 MiB</option>
      <option value="4096">4096 · 256 MiB</option>
    </select></label>
    <span>EV100 0 · Bloom 0</span><span id="lab-frame"></span></div>
    <div id="lab-readout"></div>`;
  document.body.append(panel);
  const views = {
    overview: [0, -1450, 1450, -43.79, 90],
    roughness: [0, -1080, 370, -22.1, 90],
    metal: [0, -820, 370, -22.9, 90],
    specular: [0, -560, 370, -23.0, 90],
    opacity: [0, -300, 310, -18.8, 90],
    shadows: [1120, -620, 520, -29, 129]
  };
  const descriptions = {
    overview: ['前 → 后：粗糙度 / 金属 / 高光 / 透明度', '各行左 → 右递增', '左侧：接触阴影 / 悬空阴影'],
    roughness: ['Metallic 0 · Specular 0.5', '左 → 右 Roughness 0.05 / 0.25 / 0.6 / 1'],
    metal: ['Metallic 1 · Specular 0.5', '左 → 右 Roughness 0.05 / 0.25 / 0.6 / 1'],
    specular: ['Metallic 0 · Roughness 0.12', '左 → 右 Specular 0 / 0.25 / 0.5 / 1'],
    opacity: ['Lit Translucent · Roughness 0.12', '左 → 右 Opacity 0.15 / 0.35 / 0.65 / 1', '后方：红白条纹参照'],
    shadows: ['太阳：默认方向 / 强度 6', '立柱接地 · 球体悬空 125 cm']
  };
  const view = panel.querySelector('#lab-view');
  const lighting = panel.querySelector('#lab-light');
  const shadow = panel.querySelector('#lab-shadow');
  const groups = {overview: 0, roughness: 1, metal: 2, specular: 3, opacity: 4, shadows: 5};
  function updateControl() {
    if (!Module._WebMaterialLabControl(groups[view.value], Number(lighting.value)))
      throw new Error('Material lab control unavailable');
  }
  function updateView() {
    updateControl();
    if (!Module._WebProjectViewTest(...views[view.value])) throw new Error('Material lab view unavailable');
    const readout = panel.querySelector('#lab-readout');
    readout.replaceChildren(...[...descriptions[view.value], 'CSM 4 级 · 30 m'].map(text => {
      const span = document.createElement('span');
      span.textContent = text;
      return span;
    }));
    globalThis.__materialLabView = view.value;
  }
  view.addEventListener('change', updateView);
  lighting.addEventListener('change', updateControl);
  function updateShadow() {
    if (!Module._WebMaterialLabShadowTest(2, Number(shadow.value)))
      throw new Error('Material lab shadow control unavailable');
  }
  shadow.addEventListener('change', updateShadow);
  let started = false, lastFrame = 0, lastTime = performance.now();
  const timer = setInterval(() => {
    if (globalThis.__webEngineFailure) { clearInterval(timer); return; }
    if (!globalThis.__webEngineReady || !globalThis.__webEngineFrames) return;
    if (!started) {
      started = true;
      panel.hidden = false;
      updateShadow();
      updateView();
      lastFrame = globalThis.__webEngineFrames;
      lastTime = performance.now();
    }
    const now = performance.now();
    const frames = globalThis.__webEngineFrames;
    if (now - lastTime >= 1500) {
      panel.querySelector('#lab-frame').textContent = `${((frames - lastFrame) * 1000 / (now - lastTime)).toFixed(1)} fps`;
      lastFrame = frames;
      lastTime = now;
    }
  }, 250);
})();
