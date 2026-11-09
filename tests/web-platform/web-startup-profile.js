'use strict';
// Opt-in diagnostic injected by capture-web-startup-phases.cjs. No render settings
// change; records absolute performance timestamps across the page and workers.
(() => {
  const context = typeof document === 'object' ? 'page' : 'owner';
  const profile = globalThis.__webStartupProfile = {context, timeOrigin: performance.timeOrigin,
    events: [], marks: [], pipelines: [], pipelineDescriptors: [], modules: [], lags: [], errors: [], dropped: 0, frozen: false};
  const now = () => performance.timeOrigin + performance.now();
  const push = (array, value) => {if (!profile.frozen) {if (array.length < 100000) array.push(value); else profile.dropped++;}};
  profile.markAt = (name, at, detail) => push(profile.marks, {name, at, detail});
  profile.mark = (name, detail) => profile.markAt(name, now(), detail);
  function event(name, start, detail) {
    const e = {name, start, end: now(), detail}; push(profile.events, e); return e;
  }
  function wrap(object, key, name, details) {
    const original = object?.[key]; if (typeof original !== 'function') return;
    object[key] = function(...args) {
      if (profile.frozen) return original.apply(this, args);
      const start = now(), detail = details?.(args);
      try {
        const result = original.apply(this, args);
        if (result && typeof result.then === 'function') {
          result.then(() => event(name, start, detail), e => {event(name, start, {...detail, error: e.message});});
        } else event(name, start, detail);
        return result;
      } catch (e) {event(name, start, {...detail, error: e.message}); throw e;}
    };
  }
  profile.mark('recorder.loaded');
  let previous = now();
  const timer = setInterval(() => {const at = now(); push(profile.lags, {start: previous, end: at, delayMs: Math.max(0, at - previous - 20)}); previous = at;}, 20);
  profile.freeze = () => {profile.mark('recorder.frozen'); profile.frozen = true; clearInterval(timer);};
  for (const name of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming'])
    wrap(WebAssembly, name, 'wasm.' + name);
  if (globalThis.navigator?.gpu) {
    wrap(navigator.gpu, 'requestAdapter', 'gpu.requestAdapter');
    if (typeof GPUAdapter !== 'undefined') wrap(GPUAdapter.prototype, 'requestDevice', 'gpu.requestDevice');
  }
  const resource = list => {
    for (const e of list.getEntries()) if (e.responseEnd >= e.startTime) push(profile.events, {name: 'resource', start: performance.timeOrigin + e.startTime,
      end: performance.timeOrigin + e.responseEnd, detail: {url: e.name, kind: e.initiatorType,
        transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize}});
  };
  try {new PerformanceObserver(resource).observe({type: 'resource', buffered: true});} catch {}
  if (context === 'page') {
    try {new PerformanceObserver(list => {
      for (const e of list.getEntries()) push(profile.events, {name: 'page.longtask', start: performance.timeOrigin + e.startTime,
        end: performance.timeOrigin + e.startTime + e.duration});
    }).observe({type: 'longtask', buffered: true});} catch {}
    let shown = false, ready = false;
    new MutationObserver(() => {
      const loading = document.getElementById('loading');
      if (loading?.hidden && !shown) {
        shown = true; profile.mark('page.loadingHidden');
        requestAnimationFrame(() => requestAnimationFrame(() => profile.mark('page.visibleTwoRAF')));
      }
      if (globalThis.__webPSOPrecacheReady && !ready) {ready = true; profile.mark('page.psoReady');}
    }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['hidden']});
    if (globalThis.__webStartupProfileManual) {
      const NativeWorker = Worker, pending = new Map(); let ownerWorker, sequence = 0, saved;
      globalThis.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          if (!String(args[0]).includes('web-engine-worker.js')) return;
          ownerWorker = this;
          this.addEventListener('message', event => {
            if (event.data?.type !== 'web-startup-profile-result') return;
            const resolve = pending.get(event.data.id);
            if (resolve) {pending.delete(event.data.id); resolve(event.data.result);}
          });
        }
      };
      globalThis.__webExportStartupProfile = async (download = true) => {
        if (!saved) {
          if (!ownerWorker) throw Error('引擎 Worker 尚未启动');
          const result = await new Promise(resolve => {const id = ++sequence; pending.set(id, resolve);
            ownerWorker.postMessage({type: 'web-startup-profile-request', id});});
          profile.freeze();
          saved = {date: new Date().toISOString(), folder: location.pathname.split('/').at(-2), manual: true,
            pass: !result.owner.errors.length, runs: [{index: 0, errors: [], ...result,
              page: JSON.parse(JSON.stringify({...profile, diagnostics: globalThis.startupSnapshot?.()}))}]};
        }
        if (download) {
          const url = URL.createObjectURL(new Blob([JSON.stringify(saved, null, 2)], {type: 'application/json'}));
          const a = document.createElement('a'); a.href = url;
          a.download = 'ue-startup-phases-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        return saved;
      };
      addEventListener('DOMContentLoaded', () => {
        const button = document.createElement('button'); button.textContent = '导出启动分析';
        button.id = 'web-startup-profile-export';
        Object.assign(button.style, {position: 'fixed', top: '12px', right: '12px', zIndex: 10000, padding: '8px 12px'});
        for (const name of ['mousedown', 'mouseup', 'keydown', 'keyup']) button.addEventListener(name, e => e.stopPropagation());
        button.onclick = () => __webExportStartupProfile().catch(e => {button.textContent = e.message;});
        document.body.append(button);
        const interval = setInterval(() => {if (shown) {clearInterval(interval);
          // Finish the startup sample after the loader hides; later movement does
          // not change the captured startup or grow its arrays indefinitely.
          setTimeout(() => __webExportStartupProfile(false).catch(e => profile.errors.push(e.message)), 500);
        }}, 100);
      }, {once: true});
    }
    return;
  }
  addEventListener('message', event => {
    if (event.data?.type !== 'web-startup-profile-request') return;
    profile.freeze();
    postMessage({type: 'web-startup-profile-result', id: event.data.id, result: {
      owner: JSON.parse(JSON.stringify(profile)), state: {settings: globalThis.__webProjectSettings,
        view: globalThis.__webRenderView, rhi: globalThis.__webOptimizationRHI,
        pso: globalThis.__webPSOPrecache, io: globalThis.__webContentIO?.stats}}});
  });
  // Read timestamps at assignment, before the normal 100 ms state-message poll.
  for (const key of ['__webRHIFrames', '__webEngineFrames']) {
    let value = 0;
    Object.defineProperty(globalThis, key, {configurable: true, get: () => value, set(next) {
      value = next;
      if ([1, 2, 30, 60].includes(next)) profile.mark(key + '.' + next);
      if (key === '__webRHIFrames' && next >= 2 && !profile.sceneSubmitted) {
        profile.sceneSubmitted = true; profile.mark('gpu.firstGameFrameSubmitted');
        profile.device?.queue.onSubmittedWorkDone().then(() => profile.mark('gpu.firstGameFrameCompleted'), e => profile.errors.push(e.message));
      }
    }});
  }
  const request = GPUAdapter.prototype.requestDevice;
  // Identity is based on the complete descriptor, including shader-module and
  // layout identity. Labels are deliberately excluded. Distinct descriptors
  // remain distinct even if WebGPU would consider their omitted defaults equal.
  const resources = new WeakMap(), identities = new Map();
  const corpus = globalThis.__webStartupPSOCorpus ? {version: 1, devices: [], modules: [], layouts: []} : null;
  let resourceSequence = 0;
  function encode(value, descriptorRoot = true) {
    if (value === null || typeof value !== 'object') return value;
    const reference = resources.get(value);
    if (reference) return reference;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, child => encode(child, false));
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw Error('Unrecorded WebGPU descriptor resource: ' + value.constructor?.name);
    return Object.fromEntries(Object.keys(value).sort().filter(k =>
      (!descriptorRoot || k !== 'label') && value[k] !== undefined)
      .map(k => [k, encode(value[k], false)]));
  }
  function registerResource(value, type, descriptor) {
    const reference = {$gpu: type, id: ++resourceSequence}; resources.set(value, reference);
    if (corpus) corpus[type === 'module' ? 'modules' : type === 'device' ? 'devices' : 'layouts']
      .push({...reference, descriptor});
    return reference.id;
  }
  Object.defineProperty(profile, 'exportPSOCorpus', {value: (includeSynchronous = false) => {
    if (!corpus) throw Error('PSO corpus recording was not enabled');
    const requests = profile.pipelines.filter(p => includeSynchronous || p.name.endsWith('Async'));
    const descriptors = profile.pipelineDescriptors.filter(d => requests.some(p => p.descriptorId === d.id));
    const moduleIds = new Set();
    for (const d of descriptors) for (const stage of ['vertex', 'fragment', 'compute']) {
      const id = d.descriptor[stage]?.module?.id; if (id) moduleIds.add(id);
    }
    return {...corpus, modules: corpus.modules.filter(m => moduleIds.has(m.id)), descriptors,
      requests};
  }});
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args);
    registerResource(device, 'device', encode(args[0] || {}));
    // Keep the non-serializable device outside the exported capture.
    Object.defineProperty(profile, 'device', {value: device});
    device.addEventListener('uncapturederror', e => profile.errors.push(e.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') profile.errors.push(info.message);});
    return device;
  };
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      if (profile.frozen) return original.call(this, descriptor);
      const identityStart = now();
      const encoded = encode(descriptor), deviceId = resources.get(this)?.id;
      const kind = name.includes('Render') ? 'render' : 'compute';
      const key = JSON.stringify([deviceId, kind, encoded]);
      let descriptorId = identities.get(key);
      if (!descriptorId) {
        descriptorId = identities.size + 1; identities.set(key, descriptorId);
        profile.pipelineDescriptors.push({id: descriptorId, deviceId, kind, descriptor: encoded});
      }
      const p = {name, start: now(), label: descriptor.label};
      p.id = profile.pipelines.length + 1; p.descriptorId = descriptorId; p.identityMs = p.start - identityStart;
      if (name.endsWith('Async') && profile.activeNativePSO) p.nativeId = profile.activeNativePSO;
      push(profile.pipelines, p);
      try {
        const result = original.call(this, descriptor); p.callEnd = now();
        if (name.endsWith('Async')) result.then(() => {p.end = now(); p.success = true;}, e => {p.end = now(); p.success = false; p.error = e.message;});
        else {p.end = p.callEnd; p.success = true;}
        return result;
      } catch (e) {p.end = now(); p.success = false; p.error = e.message; throw e;}
    };
  }
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(d) {
    const start = now(), result = createModule.call(this, d);
    const id = registerResource(result, 'module', corpus ? {code: d.code} : undefined);
    push(profile.modules, {id, start, end: now(), chars: d.code.length, label: d.label}); return result;
  };
  for (const name of ['createBindGroupLayout', 'createPipelineLayout']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(d) {
      const start = now(), encoded = encode(d), result = original.call(this, d);
      registerResource(result, name === 'createBindGroupLayout' ? 'bindGroupLayout' : 'pipelineLayout', encoded);
      event('gpu.' + name, start); return result;
    };
  }
  // The early canvas submission can belong to loading/engine initialization.
  // RHI present counter >= 2 separately marks the first game-loop presentation.
  // Neither queue completion marker measures physical monitor scanout.
  let acquired = false, firstSubmit = false;
  const getTexture = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function(...args) {
    if (!acquired) {acquired = true; profile.mark('gpu.firstCanvasTexture');}
    return getTexture.apply(this, args);
  };
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function(...args) {
    const start = now(), result = submit.apply(this, args);
    if (acquired && !firstSubmit) {
      firstSubmit = true; event('gpu.firstCanvasSubmit', start);
      this.onSubmittedWorkDone().then(() => profile.mark('gpu.firstCanvasCompleted'), e => profile.errors.push(e.message));
    }
    return result;
  };
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(...args) {
      const start = now(); super(...args);
      const detail = {url: String(args[0]), name: args[1]?.name}; event('worker.construct', start, detail);
      this.addEventListener('message', e => {
        if (e.data?.cmd === 'loaded') event('worker.pthreadLoaded', start, detail);
      });
    }
  };
  // Emscripten receives this object before its generated script executes.
  let moduleValue;
  Object.defineProperty(globalThis, 'Module', {configurable: true, get: () => moduleValue, set(value) {
    moduleValue = value;
    if (!value || value.__profileWrapped) return;
    value.__profileWrapped = true;
    const runtime = value.onRuntimeInitialized;
    value.onRuntimeInitialized = function(...args) {profile.mark('wasm.runtimeInitialized'); return runtime?.apply(this, args);};
    if (value.preRun) value.preRun = value.preRun.map(fn => function(...args) {
      profile.mark('wasm.preRun.begin'); return fn.apply(this, args);
    });
    const print = value.print;
    value.print = function(text) {
      if (/^P3_(ENGINE_(WORLD|READY|THREADS)|RENDER_SCENE) /.test(String(text))) profile.mark('log.' + String(text).split(' ')[0]);
      return print?.call(this, text);
    };
  }});
  const imports = importScripts;
  globalThis.importScripts = function(...args) {
    const start = now(); const result = imports.apply(this, args); event('worker.importScripts', start, {urls: args.map(String)});
    if (globalThis.WebLocalContentIO && !WebLocalContentIO.prototype.__profileWrapped) {
      const prototype = WebLocalContentIO.prototype; prototype.__profileWrapped = true;
      wrap(prototype, 'asset', 'io.asset', a => ({url: a[0].url, size: a[0].size}));
      wrap(prototype, 'mount', 'io.mount', a => ({files: a[0].files.length}));
      wrap(prototype, 'call', 'io.workerRPC', a => ({type: a[0], offset: a[1]?.offset, size: a[1]?.size}));
    }
    return result;
  };
})();
