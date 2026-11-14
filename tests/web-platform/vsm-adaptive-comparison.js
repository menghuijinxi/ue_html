'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const canvas = $('viewer'), ctx = canvas.getContext('2d'), stage = $('stage');
  const controls = [...document.querySelectorAll('#controls input, #controls select, #controls button, .adjust input, .adjust select')];
  const regions = {
    kitchen: [
      {name: '金属反射', x: 1220, y: 470, width: 700, height: 400},
      {name: '水壶边缘', x: 740, y: 935, width: 430, height: 290},
      {name: '窗边阴影', x: 400, y: 820, width: 650, height: 480}
    ],
    interior: [
      {name: '玻璃与窗帘', x: 1310, y: 610, width: 1000, height: 740},
      {name: '餐桌与地面', x: 880, y: 890, width: 1100, height: 500}
    ],
    living: [
      {name: '灯光与墙面', x: 1260, y: 790, width: 1200, height: 540},
      {name: '栏杆', x: 900, y: 280, width: 1000, height: 560}
    ]
  };
  const state = {scene: 'kitchen', pair: [1, 2], mode: 'split', split: .5, gain: 8,
    center: {x: 1220, y: 470}, scale: 1, width: 0, height: 0, ready: false, generation: 0};
  let evidence, left, right, difference;
  const cache = new Map();
  function fail(error) {
    state.ready = false; controls.forEach(c => c.disabled = true);
    $('loading').hidden = false; $('retry').hidden = false; $('divider').hidden = true;
    $('loading-text').textContent = '载入失败：' + error.message;
    $('status').textContent = '截图不可用';
  }
  const sourceURL = source => {
    const file = source.file.replaceAll('\\', '/'), marker = '/tests/web-platform/';
    if (!file.includes(marker)) throw Error('截图路径不属于当前证据目录');
    const relative = file.slice(file.indexOf(marker) + marker.length);
    if (!/^results\/vsm-adaptive-timing-isolated-20261111\/run-[1-4]-(kitchen|interior|living)\.png$/.test(relative))
      throw Error('未知截图路径');
    return new URL(relative + '?v=' + source.sha256, location.href).href;
  };
  function imageFor(record) {
    const url = sourceURL(record.source);
    if (!cache.has(url)) cache.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw Error('截图 HTTP ' + response.status);
      const buffer = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
        .map(n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== record.source.sha256) throw Error('截图哈希与测试记录不一致');
      const image = await createImageBitmap(new Blob([buffer], {type: 'image/png'}));
      if (image.width !== 1920 || image.height !== 1080) throw Error('截图尺寸不符');
      return image;
    })().catch(error => {cache.delete(url); throw error;}));
    return cache.get(url);
  }
  const name = record => (record.adaptive ? '自适应 ' : '原版 ') + record.run;
  function makeDifference() {
    const work = document.createElement('canvas');
    work.width = left.width; work.height = left.height;
    const context = work.getContext('2d', {willReadFrequently: true});
    context.drawImage(left, 0, 0);
    const a = context.getImageData(0, 0, work.width, work.height);
    context.drawImage(right, 0, 0);
    const b = context.getImageData(0, 0, work.width, work.height);
    for (let i = 0; i < a.data.length; i += 4) {
      for (let c = 0; c < 3; ++c) a.data[i + c] = Math.min(255, Math.abs(a.data[i + c] - b.data[i + c]) * state.gain);
      a.data[i + 3] = 255;
    }
    context.putImageData(a, 0, 0); difference = work;
  }
  function setRegions() {
    $('region').replaceChildren(...[...regions[state.scene].map((region, i) => new Option(region.name, String(i))),
      new Option('全图', 'full')]);
    $('region').value = '0';
  }
  function setRegion() {
    if ($('region').value === 'full') {
      state.center = {x: 960, y: 540}; state.scale = Math.min(state.width / 1920, state.height / 1080);
    } else {
      const region = regions[state.scene][Number($('region').value)];
      state.center = {x: region.x, y: region.y};
      state.scale = Math.min(state.width / region.width, state.height / region.height);
    }
    draw();
  }
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#161918'; ctx.fillRect(0, 0, state.width, state.height);
    if (!state.ready) return;
    const x = state.width / 2 - state.center.x * state.scale;
    const y = state.height / 2 - state.center.y * state.scale;
    const paint = image => ctx.drawImage(image, x, y, image.width * state.scale, image.height * state.scale);
    if (state.mode === 'split') {
      paint(left); ctx.save();
      ctx.beginPath(); ctx.rect(state.width * state.split, 0, state.width, state.height); ctx.clip();
      paint(right); ctx.restore();
    } else paint(state.mode === 'left' ? left : state.mode === 'right' ? right : difference);
    $('divider').hidden = state.mode !== 'split';
    $('divider').style.left = state.split * 100 + '%';
    $('left-label').hidden = state.mode === 'right';
    $('right-label').hidden = state.mode !== 'split' && state.mode !== 'right';
    $('split-control').hidden = state.mode !== 'split';
    $('diff-control').hidden = state.mode !== 'diff';
    $('zoom-value').textContent = Math.round(state.scale * 100) + '%';
    const records = evidence.images.find(i => i.name === state.scene).sources;
    $('left-label').textContent = state.mode === 'diff' ? 'RGB 绝对差 ×' + state.gain : 'A · ' + name(records.find(r => r.run === state.pair[0]));
    $('right-label').textContent = 'B · ' + name(records.find(r => r.run === state.pair[1]));
    $('status').textContent = '原始截图 SHA-256 已校验 · 中心 ' + Math.round(state.center.x) + ', ' + Math.round(state.center.y);
  }
  function resize() {
    const oldWidth = state.width, oldHeight = state.height;
    state.width = stage.clientWidth; state.height = stage.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(state.width * dpr); canvas.height = Math.round(state.height * dpr);
    if (oldWidth && oldHeight) state.scale *= Math.min(state.width / oldWidth, state.height / oldHeight);
    draw();
  }
  async function load(reset = false) {
    const generation = ++state.generation;
    state.ready = false; controls.forEach(c => c.disabled = true);
    $('loading').hidden = false; $('retry').hidden = true; $('loading-text').textContent = '正在校验原始截图';
    $('divider').hidden = true;
    try {
      if (!evidence) {
        const response = await fetch('evidence/vsm-adaptive-20261111.json');
        if (!response.ok) throw Error('测试记录 HTTP ' + response.status);
        const report = await response.json();
        if (!report.pass || !report.timing?.[0]?.images) throw Error('测试记录不完整');
        evidence = report.timing[0];
      }
      const scene = evidence.images.find(i => i.name === state.scene);
      const records = state.pair.map(run => scene.sources.find(r => r.run === run));
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
        if (Math.abs(records[0].camera[key] - records[1].camera[key]) > .001) throw Error('截图相机不一致');
      const images = await Promise.all(records.map(imageFor));
      if (generation !== state.generation) return;
      [left, right] = images; makeDifference();
      const metrics = scene.comparisons.find(c => state.pair.every(n => c.runs.includes(n)));
      $('rms').textContent = metrics.rootMeanSquareDifference.toFixed(3);
      $('changed').textContent = metrics.pixelsOver16Percent.toFixed(3) + '%';
      for (let i = 0; i < 2; ++i) {
        const link = $(i ? 'source-b' : 'source-a');
        link.href = sourceURL(records[i].source); link.hidden = false;
      }
      state.ready = true; controls.forEach(c => c.disabled = false); $('loading').hidden = true;
      if (reset) setRegion(); else draw();
    } catch (error) {if (generation === state.generation) fail(error);}
  }
  function zoom(factor, x = state.width / 2, y = state.height / 2) {
    if (!state.ready) return;
    const before = state.scale;
    state.scale = Math.max(.12, Math.min(12, state.scale * factor));
    state.center.x += (x - state.width / 2) * (1 / before - 1 / state.scale);
    state.center.y += (y - state.height / 2) * (1 / before - 1 / state.scale);
    draw();
  }
  $('scene').onchange = () => {state.scene = $('scene').value; setRegions(); load(true);};
  $('pair').onchange = () => {state.pair = $('pair').value.split(',').map(Number); load();};
  $('region').onchange = setRegion;
  document.querySelectorAll('[name=mode]').forEach(input => input.onchange = () => {state.mode = input.value; draw();});
  $('gain').onchange = () => {state.gain = Number($('gain').value); makeDifference(); draw();};
  $('split').oninput = () => {state.split = Number($('split').value) / 100; draw();};
  $('zoom-in').onclick = () => zoom(1.3);
  $('zoom-out').onclick = () => zoom(1 / 1.3);
  $('original').onclick = () => zoom(1 / state.scale);
  $('fit').onclick = () => {$('region').value = 'full'; setRegion();};
  $('retry').onclick = () => load(true);
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
  }, {passive: false});
  const pointers = new Map();
  canvas.onpointerdown = event => {
    if (!state.ready) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
  };
  canvas.onpointermove = event => {
    const previous = pointers.get(event.pointerId); if (!previous) return;
    state.center.x -= (event.clientX - previous.x) / state.scale;
    state.center.y -= (event.clientY - previous.y) / state.scale;
    state.center.x = Math.max(0, Math.min(1920, state.center.x));
    state.center.y = Math.max(0, Math.min(1080, state.center.y));
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY}); draw();
  };
  canvas.onpointerup = canvas.onpointercancel = event => pointers.delete(event.pointerId);
  canvas.onkeydown = event => {
    const movements = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    if (!state.ready || !movements[event.key]) return;
    event.preventDefault();
    state.center.x += movements[event.key][0] * 50 / state.scale;
    state.center.y += movements[event.key][1] * 50 / state.scale; draw();
  };
  let dividing = false;
  const moveDivider = event => {
    const rect = stage.getBoundingClientRect();
    state.split = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    $('split').value = state.split * 100; draw();
  };
  $('divider').onpointerdown = event => {
    dividing = true; $('divider').setPointerCapture(event.pointerId); moveDivider(event);
  };
  $('divider').onpointermove = event => {if (dividing) moveDivider(event);};
  $('divider').onpointerup = $('divider').onpointercancel = () => {dividing = false;};
  $('divider').onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    state.split = event.key === 'Home' ? 0 : event.key === 'End' ? 1 :
      Math.max(0, Math.min(1, state.split + (event.key === 'ArrowRight' ? .02 : -.02)));
    $('split').value = state.split * 100; draw();
  };
  setRegions(); new ResizeObserver(resize).observe(stage); resize(); load(true);
})();
