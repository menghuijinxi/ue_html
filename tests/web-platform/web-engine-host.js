'use strict';
// Store intervals rather than averaging instantaneous FPS, so stalls remain visible.
class WebFrameSamples {
  constructor() { this.reset(); }
  reset() { this.first = this.last = null; this.samples = []; this.head = 0; }
  add(time) {
    if (!Number.isFinite(time)) return;
    if (this.last === null) { this.first = this.last = time; return; }
    if (time <= this.last) return;
    this.samples.push({time, ms: time - this.last}); this.last = time; this.prune(time);
  }
  prune(now) {
    while (this.head < this.samples.length && this.samples[this.head].time <= now - 30000) ++this.head;
    if (this.head > 256 && this.head * 2 > this.samples.length) {
      this.samples = this.samples.slice(this.head); this.head = 0;
    }
  }
  read(now, windowMs = 5000) {
    this.prune(now);
    const samples = this.samples.slice(this.head).filter(sample => sample.time > now - windowMs);
    const elapsed = this.first === null ? 0 : Math.min(1000, now - this.first);
    const recent = samples.filter(sample => sample.time > now - elapsed).length;
    const worst = samples.length >= 100 ? samples.map(sample => sample.ms).sort((a,b) => b-a)
      .slice(0, Math.ceil(samples.length * .01)) : [];
    return {fps: elapsed > 0 ? recent * 1000 / elapsed : null,
      low: worst.length ? 1000 * worst.length / worst.reduce((sum, ms) => sum + ms, 0) : null,
      frameMs: this.last === null ? null : Math.max(samples.at(-1)?.ms || 0, now - this.last),
      samples: samples.length, seconds: this.first === null ? 0 : Math.min(windowMs / 1000, (now - this.first) / 1000),
      p99Ms: samples.length >= 100 ? samples.map(sample => sample.ms).sort((a,b) => a-b)[Math.ceil(samples.length*.99)-1] : null,
      maxMs: samples.length ? Math.max(...samples.map(sample => sample.ms)) : null,
      over50ms: samples.filter(sample => sample.ms > 50).length};
  }
}

function createWebPerformanceHUD(counter, canvas) {
  const visual = new WebFrameSamples(), submitted = new WebFrameSamples(), refresh = new WebFrameSamples();
  let contexts = [], events = [];
  const element = document.createElement('aside');
  element.id = 'web-performance-hud'; element.setAttribute('aria-label', '实时帧率');
  Object.assign(element.style, {position:'fixed', top:'12px', left:'12px', zIndex:3,
    padding:'10px 12px', borderRadius:'6px', background:'rgba(8,14,18,.82)', color:'#e6f0ec',
    font:'13px/1.65 Consolas, monospace', fontVariantNumeric:'tabular-nums', pointerEvents:'none',
    minWidth:'212px', boxShadow:'0 1px 8px #0006'});
  element.innerHTML = '<div style="display:flex;justify-content:space-between;gap:20px"><strong>实时性能</strong>' +
    '<span><button type="button" data-action="reset">重置</button> <button type="button" data-action="export" title="导出最近30秒逐帧与PSO创建记录">导出</button></span></div>' +
    '<div title="最近1秒引擎完成提交的帧数。浏览器没有提供显示器实际呈现时间。">FPS <b data-stat="fps">—</b></div>' +
    '<div title="最近5秒最慢1%提交间隔的平均值换算为FPS；不足100个间隔时等待采样。">1% Low <b data-stat="low">采样中</b> <small>近5秒</small></div>' +
    '<div>帧间隔 <b data-stat="ms">—</b> ms</div>' +
    '<div style="color:#a7c0b6;font-size:11px">P99 <span data-stat="p99">—</span> ms · 最长 <span data-stat="max">—</span> ms</div>' +
    '<svg viewBox="0 0 216 48" width="216" height="48" style="display:block;margin-top:4px" aria-label="近5秒帧间隔曲线"><path d="M0 32H216" stroke="#617d70" stroke-dasharray="3 3"/><polyline data-stat="graph" fill="none" stroke="#8fe2b6" stroke-width="1.5"/></svg>' +
    '<div style="color:#a7c0b6;font-size:11px">页面观察 <span data-stat="submit">—</span> FPS · 刷新 <span data-stat="refresh">—</span> Hz</div>' +
    '<div data-stat="state" style="color:#a7c0b6;font-size:11px">等待场景画面</div>';
  document.body.append(element);
  const fields = Object.fromEntries([...element.querySelectorAll('[data-stat]')].map(node => [node.dataset.stat, node]));
  let lastCounter = 0, raf, stopped = false, visibleSince = performance.now(), lastUpdate = -Infinity, submittedAt = null;
  const reset = () => {
    visual.reset(); submitted.reset(); refresh.reset();
    contexts = []; events = [];
    lastCounter = Atomics.load(counter, 0); visibleSince = performance.now(); lastUpdate = -Infinity; submittedAt = null;
  };
  for (const button of element.querySelectorAll('button')) {
    Object.assign(button.style,{pointerEvents:'auto',background:'none',border:0,color:'#b4d2c5',cursor:'pointer',font:'inherit',padding:0});
    for (const name of ['mousedown', 'mouseup', 'keydown', 'keyup']) button.addEventListener(name, event => event.stopPropagation());
  }
  element.querySelector('[data-action="reset"]').onclick = () => { reset(); canvas.focus({preventScroll:true}); };
  element.querySelector('[data-action="export"]').onclick = () => {
    const now = performance.now(); submitted.prune(now);
    const data = {version:1,date:new Date().toISOString(),timeOrigin:performance.timeOrigin,
      source:'rhi-owner-submission-intervals',lowWindowMs:5000,
      lowDefinition:'1000 / mean(slowest ceil(N*0.01) submission intervals)',
      boundary:'Submission intervals are not physical display timings. Async creation events measure API invocation only. Context counters are sampled every 100 ms.',
      summary:submitted.read(now),frames:submitted.samples.slice(submitted.head),
      pipelineEvents:events.filter(e=>e.end>now-30000),contexts:contexts.filter(c=>c.time>now-30000)};
    const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href = url;
    link.download = 'ue-frame-pacing-'+data.date.replace(/[:.]/g,'-')+'.json'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    canvas.focus({preventScroll:true});
  };
  const format = value => value === null ? '—' : value.toFixed(1);
  function update(now) {
    if (stopped) return;
    if (!document.hidden) {
      refresh.add(now);
      const current = Atomics.load(counter, 0);
      if (current !== lastCounter) { visual.add(now); lastCounter = current; }
      if (now - lastUpdate >= 250) {
        // Worker batches arrive asynchronously. End its 1-second window at the
        // sampled worker time, rather than treating delivery latency as lost frames.
        const v = visual.read(now), s = submitted.read(submittedAt !== null && now - submittedAt < 500 ? submittedAt : now), r = refresh.read(now);
        fields.fps.textContent = format(s.fps); fields.low.textContent = s.low === null ? '采样中' : format(s.low);
        fields.ms.textContent = format(s.frameMs); fields.submit.textContent = format(v.fps);
        fields.p99.textContent = format(s.p99Ms); fields.max.textContent = format(s.maxMs);
        const graphTime = submittedAt ?? now;
        const graphSamples = submitted.samples.slice(submitted.head).filter(sample => sample.time > graphTime - 5000);
        fields.graph.setAttribute('points', graphSamples.map(sample =>
          `${((sample.time-graphTime+5000)/5000*216).toFixed(1)},${(48-Math.min(150,sample.ms)/150*48).toFixed(1)}`).join(' '));
        fields.refresh.textContent = format(r.fps);
        fields.state.textContent = submitted.first !== null ? `近5秒 >50ms：${s.over50ms} 帧 · 提交间隔统计` : '等待场景画面';
        globalThis.__webLivePerformance = {visual:v, submitted:s, refresh:r, visible:true,
          frame:current, source:'rhi-owner-submission-intervals', windowMs:5000, time:now};
        lastUpdate = now;
      }
    }
    raf = requestAnimationFrame(update);
  }
  const visibility = () => {
    reset();
    if (document.hidden) {
      fields.state.textContent = '页面已隐藏 · 暂停统计';
      for (const name of ['fps','low','ms','submit','refresh','p99','max']) fields[name].textContent = '—';
      fields.graph.setAttribute('points','');
      globalThis.__webLivePerformance = {visible:false};
    }
  };
  document.addEventListener('visibilitychange', visibility); raf = requestAnimationFrame(update);
  return {
    reset,
    ingest(pacing, state) {
      if (!pacing || document.hidden) return;
      const offset = pacing.timeOrigin - performance.timeOrigin;
      for (const time of pacing.times) if (time + offset >= visibleSince) submitted.add(time + offset);
      submittedAt = pacing.at + offset;
      for(const event of pacing.events || []) if(event.end+offset>=visibleSince)
        events.push({...event,start:event.start+offset,end:event.end+offset});
      events = events.filter(event=>event.end>submittedAt-30000);
      if(state)contexts.push({time:submittedAt,frame:state.__webEngineFrames,
        stages:state.__webThreadStages,io:state.__webLocalContentStats,
        streaming:state.__webTextureStreaming,pso:state.__webOptimizationRHI});
      contexts = contexts.filter(context=>context.time>submittedAt-30000);
    },
    dispose() { stopped = true; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', visibility); element.remove(); }
  };
}

// Experimental desktop-style frame overlap: direct page -> Game display ticks,
// bounded by actual GPU completion. No queued display ticks accumulate.
function createWebGameFrameClock(maxAhead, fail) {
  const state = new Int32Array(new SharedArrayBuffer(32));
  const channel = new MessageChannel();
  let pending = null, raf = 0, disposed = false, ready = false, issued = null, displayTick = null;
  const stats = globalThis.__webFrameSchedulerPage = {maxAhead, requests: 0, ticks: 0, budgetStalls: 0, ready: false};
  function arm() {
    if (!disposed && ready && pending !== null && !document.hidden && !raf) raf = requestAnimationFrame(tick);
  }
  function tick(timestamp) {
    raf = 0;
    if (disposed || document.hidden || pending === null) return;
    displayTick = timestamp;
    grant(); arm();
  }
  function grant() {
    if (disposed || document.hidden || pending === null || displayTick === null || performance.now() - displayTick > 50) return;
    const completed = Atomics.load(state, 0), reserved = Atomics.load(state, 2);
    if (reserved - completed >= maxAhead) { ++stats.budgetStalls; return; }
    issued = pending; pending = null;
    const ahead = Atomics.add(state, 2, 1) + 1 - completed;
    Atomics.store(state, 5, Math.max(Atomics.load(state, 5), ahead));
    ++stats.ticks;
    channel.port1.postMessage({type: 'tick', id: issued, timestamp: performance.timeOrigin + displayTick});
    displayTick = null;
  }
  channel.port1.onmessage = ({data}) => {
    if (disposed) return;
    if (data.type === 'ready') {
      if (ready || !Number.isSafeInteger(data.bootstrap) || data.bootstrap < 0 || data.bootstrap > maxAhead)
        return fail('Invalid Game frame clock bootstrap');
      ready = stats.ready = true;
      Atomics.store(state, 2, data.bootstrap);
      Atomics.store(state, 6, 1);
    } else if (data.type === 'request') {
      if (!ready || pending !== null || !Number.isSafeInteger(data.id)) return fail('Overlapping Game frame requests');
      ++stats.requests; pending = data.id; grant(); arm();
    } else if (data.type === 'cancel') {
      if (pending === data.id) pending = null;
      else if (issued === data.id) { Atomics.sub(state, 2, 1); issued = null; }
    }
  };
  const visibility = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    displayTick = null;
    arm();
  };
  document.addEventListener('visibilitychange', visibility);
  return {transfer: {maxAhead, state: state.buffer, port: channel.port2},
    gpuCompleted() {grant(); arm();},
    dispose() { disposed = true; if (raf) cancelAnimationFrame(raf); channel.port1.close();
      document.removeEventListener('visibilitychange', visibility); }};
}

globalThis.startWebEngineWorker = function({assets, module, record, failed, stage, diagnostics, render}) {
  const experiment = new URLSearchParams(location.search);
  const occlusionArgs = module.arguments.filter(v => v.startsWith('-WebOcclusionMode='));
  if (occlusionArgs.length > 1) throw new Error('Choose one occlusion mode');
  const occlusionMode = experiment.get('occlusion') ?? occlusionArgs[0]?.split('=')[1] ?? 'history';
  if (!['control', 'history', 'hzb', 'instances', 'hzb-instances'].includes(occlusionMode)) throw new Error('Invalid occlusion mode');
  module.arguments = module.arguments.filter(v => !v.startsWith('-WebOcclusionMode='));
  module.arguments.push('-WebOcclusionMode=' + occlusionMode);
  // Approved default: schedule Game ticks locally and consume completed history.
  // A page-frame scheduler is an explicit alternative; owner rAF remains selectable.
  const clock = experiment.get('clock');
  if (clock !== null && !['local', 'owner'].includes(clock)) throw new Error('Invalid Game frame clock');
  const localClock = clock === 'local' || (clock === null &&
    !module.arguments.some(v => v.startsWith('-WebFrameScheduler=')));
  module.arguments = module.arguments.filter(v => v !== '-WebGameLocalClock');
  if (localClock) module.arguments.push('-WebGameLocalClock');
  if (module.arguments.includes('-WebGameLocalClock') && module.arguments.some(v => v.startsWith('-WebFrameScheduler=')))
    throw new Error('Choose one frame clock experiment');
  const canvas = module.canvas;
  globalThis.__webPSOPrecacheExpected = module.arguments.includes('-WebPSOPrecacheTest');
  globalThis.__webPSOPrecacheReady = !globalThis.__webPSOPrecacheExpected;
  if (!canvas.transferControlToOffscreen || typeof Worker === 'undefined')
    throw new Error('此线程包需要 OffscreenCanvas 和 Worker 支持。');
  const worker = new Worker('web-engine-worker.js?v=' + assets.versions['web-engine-worker.js'],
    {name: 'UE Engine'});
  const frameCounter = new Uint32Array(new SharedArrayBuffer(4));
  const performanceHUD = createWebPerformanceHUD(frameCounter, canvas);
  let sequence = 0, stopped = false, frameClock;
  let inputInFlight = false, inputScheduled = false;
  const gameClockVisibility = () => worker.postMessage({type: 'game-clock-visibility', hidden: document.hidden});
  const inputQueue = [];
  const pending = new Map();
  const reportFailure = error => {
    stopped = true;
    document.removeEventListener('visibilitychange', gameClockVisibility);
    frameClock?.dispose();
    performanceHUD.dispose();
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(String(error)));
    }
    pending.clear();
    failed(error, {kind: 'engine-worker'});
  };
  worker.onerror = event => reportFailure(event.message);
  if (localClock) document.addEventListener('visibilitychange', gameClockVisibility);
  const frameSchedulerArg = module.arguments.filter(arg => arg.startsWith('-WebFrameScheduler='));
  if (frameSchedulerArg.length) {
    const maxAhead = Number(frameSchedulerArg[0].split('=')[1]);
    if (frameSchedulerArg.length !== 1 || !Number.isInteger(maxAhead) || maxAhead < 1 || maxAhead > 4)
      throw new Error('WebFrameScheduler requires a maximum of 1 to 4 frames');
    frameClock = createWebGameFrameClock(maxAhead, reportFailure);
  }
  worker.onmessageerror = () => reportFailure('Engine Worker message could not be decoded');
  worker.onmessage = event => {
    const message = event.data;
    if (message.type === 'log') record(message.text);
    else if (message.type === 'gpu-frame-complete') frameClock?.gpuCompleted();
    else if (message.type === 'failure') reportFailure(message.message);
    else if (message.type === 'stage') stage(message.stage);
    else if (message.type === 'progress') {
      diagnostics.localContent = message.progress;
      stage(message.progress.url?.endsWith('.wasm') ? 'wasm-downloading' : 'content-loading');
      render();
    } else if (message.type === 'mount') {
      diagnostics.content = {completed: message.completed, total: message.total};
      render();
    } else if (message.type === 'state') {
      Object.assign(globalThis, message.state);
      const pso = message.state.__webPSOPrecache, rhi = message.state.__webOptimizationRHI;
      if (!globalThis.__webPSOPrecacheReady && message.state.__webEngineFrames >= 30 &&
          pso?.enabled && pso.active === 0 && rhi &&
          rhi.asyncPrecacheRequested === rhi.asyncPrecacheCompleted) {
        globalThis.__webPSOPrecacheReady = true;
        performanceHUD.reset();
      }
      performanceHUD.ingest(message.state.__webFramePacing, message.state);
      render();
    } else if (message.type === 'dom') {
      if (message.command === 'focus') canvas.focus({preventScroll: true});
      else if (message.command === 'exit-pointer-lock') document.exitPointerLock?.();
    } else if (message.type === 'rpc') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    } else if (message.type === 'input-ack') {
      inputInFlight = false;
      flushInput();
    } else if (message.type === 'trace') {
      globalThis.__webTraceBlob = new Blob([message.bytes], {type: 'application/octet-stream'});
    }
  };
  globalThis.__webEngineRPC = (name, ...args) => new Promise((resolve, reject) => {
    if (stopped || pending.size >= 64) { reject(new Error('Engine RPC unavailable')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Engine RPC timed out: ' + name));
    }, 30000);
    pending.set(id, {resolve, reject, timer});
    worker.postMessage({type: 'rpc', id, name, args});
  });
  // Diagnostic target only. TraceLog supplies the original .utrace stream;
  // this bridge transfers the bytes and offers a normal browser download.
  let traceBusy = false;
  globalThis.__webCaptureUETrace = async (seconds = 8) => {
    if (!assets.trace) throw Error('This package does not include UE Trace');
    if (traceBusy) throw Error('A UE trace capture is already running');
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw Error('Trace duration must be 1–30 seconds');
    traceBusy = true;
    let started = false;
    try {
    globalThis.__webTraceBlob = null;
    if (await globalThis.__webEngineRPC('WebTraceStart') !== 1) throw Error('UE Trace could not start');
    started = true;
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    if (await globalThis.__webEngineRPC('WebTraceStop') !== 1) throw Error('UE Trace could not stop');
    started = false;
    for (let attempt = 0; attempt < 100; ++attempt) {
      const size = await globalThis.__webEngineRPC('WebTraceExport');
      if (size < 0) throw Error('UE Trace export failed: ' + size);
      if (size > 0) {
        for (let delivery = 0; delivery < 100 && !globalThis.__webTraceBlob; ++delivery)
          await new Promise(resolve => setTimeout(resolve, 10));
        if (globalThis.__webTraceBlob?.size !== size) throw Error('UE Trace transfer is incomplete');
        return size;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('UE Trace writer did not close');
    } finally {
      if (started) await globalThis.__webEngineRPC('WebTraceStop').catch(error => record(String(error)));
      traceBusy = false;
    }
  };
  globalThis.__webDownloadUETrace = () => {
    if (!globalThis.__webTraceBlob) throw Error('Capture a UE trace first');
    const url = URL.createObjectURL(globalThis.__webTraceBlob), link = document.createElement('a');
    link.href = url; link.download = 'ue-web-' + new Date().toISOString().replaceAll(':', '-') + '.utrace';
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  if (assets.trace) {
    const button = document.createElement('button');
    button.id = 'capture-ue-trace'; button.type = 'button';
    button.textContent = '录制 8 秒性能';
    Object.assign(button.style, {position: 'fixed', right: '12px', top: '12px', zIndex: 4,
      padding: '8px 12px', color: '#fff', background: '#253b35', border: '1px solid #69d5ae',
      borderRadius: '4px', cursor: 'pointer'});
    // The window listens for mouseup to release canvas drags. A control click
    // must not inject its screen coordinates into the player's mouse input.
    button.addEventListener('mouseup', event => event.stopPropagation());
    button.onclick = async () => {
      button.disabled = true; button.textContent = '正在录制…';
      try {
        await globalThis.__webCaptureUETrace(8);
        globalThis.__webDownloadUETrace();
        button.textContent = '已下载 · 再录制 8 秒';
      } catch (error) { button.textContent = '录制失败 · 重试'; record(String(error)); }
      finally { button.disabled = false; canvas.focus({preventScroll: true}); }
    };
    document.body.append(button);
  }
  const browser = () => {
    const rect = canvas.getBoundingClientRect();
    return {width: rect.width, height: rect.height, dpr: devicePixelRatio};
  };
  const resize = () => { if (!stopped) worker.postMessage({type: 'browser', state: browser()}); };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  addEventListener('resize', resize);
  // DPI can change between displays without a change to the canvas's CSS dimensions.
  let lastDpr = devicePixelRatio;
  const dpiTimer = setInterval(() => {
    if (lastDpr !== devicePixelRatio) { lastDpr = devicePixelRatio; resize(); }
  }, 250);
  function flushInput() {
    if (stopped || inputInFlight || inputScheduled || !inputQueue.length) return;
    inputScheduled = true;
    requestAnimationFrame(() => {
      inputScheduled = false;
      if (stopped) return;
      inputInFlight = true;
      worker.postMessage({type: 'inputs', events: inputQueue.splice(0)});
    });
  }
  const input = (type, code = 0, character = 0, x = 0, y = 0, dx = 0, dy = 0, wheel = 0, flags = 0) => {
    if (stopped) return;
    if (!globalThis.__webPSOPrecacheReady && type < 12) return;
    const previous = inputQueue.at(-1);
    if (type === 8 && previous?.[0] === 8 && inputQueue.at(-2)?.[0] === 8) {
      previous[3] = x; previous[4] = y;
      previous[5] += dx; previous[6] += dy;
    } else {
      if (inputQueue.length >= 256) {
        inputQueue.length = 0;
        inputQueue.push([12, 0, 0, 0, 0, 0, 0, 0, 0]);
        if (document.activeElement === canvas) inputQueue.push([13, 0, 0, 0, 0, 0, 0, 0, 0]);
      }
      inputQueue.push([type, code, character, x, y, dx, dy, wheel, flags]);
    }
    flushInput();
  };
  for (const [type, id] of [['keydown', 2], ['keyup', 3]]) {
    canvas.addEventListener(type, event => {
      event.preventDefault();
      input(id, event.keyCode, event.key.length === 1 ? event.key.charCodeAt(0) : 0, 0, 0, 0, 0, 0,
        Number(event.repeat) | Number(event.shiftKey) << 1 | Number(event.ctrlKey) << 2 |
        Number(event.altKey) << 3 | Number(event.metaKey) << 4);
    });
  }
  const mouse = (event, id) => {
    const rect = canvas.getBoundingClientRect();
    input(id, event.button, 0, Math.round((event.clientX - rect.left) * devicePixelRatio),
      Math.round((event.clientY - rect.top) * devicePixelRatio), event.movementX, event.movementY);
  };
  canvas.addEventListener('mousedown', event => {
    event.preventDefault();
    canvas.focus({preventScroll: true});
    mouse(event, 5);
  });
  canvas.addEventListener('mousemove', event => mouse(event, 8));
  addEventListener('mouseup', event => mouse(event, 6));
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    input(9, 0, 0, Math.round((event.clientX - rect.left) * devicePixelRatio),
      Math.round((event.clientY - rect.top) * devicePixelRatio), 0, 0,
      -event.deltaY / (event.deltaMode === 0 ? 100 : event.deltaMode === 1 ? 3 : 1));
  }, {passive: false});
  canvas.addEventListener('focus', () => input(13));
  canvas.addEventListener('blur', () => input(12));
  addEventListener('blur', () => input(12));
  document.addEventListener('visibilitychange', () => { if (document.hidden) input(12); });
  document.addEventListener('pointerlockchange', () => input(20, Number(document.pointerLockElement === canvas)));
  addEventListener('pagehide', () => {
    stopped = true;
    document.removeEventListener('visibilitychange', gameClockVisibility);
    frameClock?.dispose();
    performanceHUD.dispose();
    observer.disconnect();
    clearInterval(dpiTimer);
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Engine page closed'));
    }
    pending.clear();
  }, {once: true});
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage({type: 'start', assets, canvas: offscreen, browser: browser(),
    gameClockHidden: document.hidden,
    frameCounter: frameCounter.buffer,
    frameScheduler: frameClock?.transfer,
    arguments: module.arguments, debug: diagnostics.mode !== 'normal',
    verification: new URLSearchParams(location.search).get('verify') === 'full' ? 'full' : 'sampled'},
    [offscreen, ...(frameClock ? [frameClock.transfer.port] : [])]);
  diagnostics.engineWorker = {url: 'web-engine-worker.js', offscreenCanvas: true};
};

if (typeof module !== 'undefined' && module.exports) module.exports = {WebFrameSamples};
