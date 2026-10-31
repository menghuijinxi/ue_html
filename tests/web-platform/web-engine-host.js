'use strict';
globalThis.startWebEngineWorker = function({assets, module, record, failed, stage, diagnostics, render}) {
  const canvas = module.canvas;
  if (!canvas.transferControlToOffscreen || typeof Worker === 'undefined')
    throw new Error('此线程包需要 OffscreenCanvas 和 Worker 支持。');
  const worker = new Worker('web-engine-worker.js?v=' + assets.versions['web-engine-worker.js'],
    {name: 'UE Engine'});
  let sequence = 0, stopped = false;
  let inputInFlight = false, inputScheduled = false;
  const inputQueue = [];
  const pending = new Map();
  const reportFailure = error => {
    stopped = true;
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(String(error)));
    }
    pending.clear();
    failed(error, {kind: 'engine-worker'});
  };
  worker.onerror = event => reportFailure(event.message);
  worker.onmessageerror = () => reportFailure('Engine Worker message could not be decoded');
  worker.onmessage = event => {
    const message = event.data;
    if (message.type === 'log') record(message.text);
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
    arguments: module.arguments, debug: diagnostics.mode !== 'normal',
    verification: new URLSearchParams(location.search).get('verify') === 'full' ? 'full' : 'sampled'}, [offscreen]);
  diagnostics.engineWorker = {url: 'web-engine-worker.js', offscreenCanvas: true};
};
