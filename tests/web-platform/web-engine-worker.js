'use strict';
// The main runtime owns FS, IO, GPU objects and RHI translation. GT/RT are pthreads.
let initialized = false;
let frameCounter, lastPresented = 0, presentTimes = [], pipelineEvents = [];
let browserMetricsReady = false;
let frameScheduler;
let rhiWakePriority = false;
function markGpuFrame() {
  if (!frameScheduler) return;
  if (!frameScheduler.attached || !frameScheduler.queue) throw new Error('Frame scheduler runtime support unavailable');
  const state = frameScheduler.state;
  // RHIEndFrame reports one complete frame after submitting every encoder.
  // This is independent of the viewport/HUD counter, which may start at 2.
  const submitted = Atomics.add(state, 1, 1) + 1;
  Atomics.store(state, 3, Math.max(Atomics.load(state, 3), submitted - Atomics.load(state, 0)));
  // Register only after the complete frame has been submitted. Promise callbacks
  // run on this owner; do not block it waiting for its own completion messages.
  frameScheduler.queue.onSubmittedWorkDone().then(() => {
    Atomics.store(state, 0, Math.max(Atomics.load(state, 0), submitted));
    Atomics.add(state, 4, 1);
    send('gpu-frame-complete');
  }).catch(fail);
}
function updateBrowserMetrics(state) {
  globalThis.__webBrowserState = state;
  globalThis.devicePixelRatio = state.dpr;
  // Old immutable runtimes do not export this entry point. New runtimes read
  // a native shared snapshot, updated before the game thread starts and on
  // every browser change, without synchronous game -> RHI owner queries.
  if (browserMetricsReady && typeof Module._WebUpdateBrowserMetrics === 'function') {
    Module._WebUpdateBrowserMetrics(state.width, state.height, state.dpr);
    globalThis.__webBrowserMetrics = {width:state.width,height:state.height,dpr:state.dpr,
      updates:(globalThis.__webBrowserMetrics?.updates||0)+1};
  }
}
const send = (type, values = {}) => postMessage({type, ...values});
const fail = error => send('failure', {message: error?.stack || error?.message || String(error)});
const rpcNames = new Set([
  'WebTextureStreamingTestBudget', 'WebOcclusionTestMode', 'WebDefaultSamplesVisibility',
  'WebDefaultSceneTestMode', 'WebProjectLightingTestMode', 'WebProjectViewTest',
  'WebDefaultShadowControl', 'WebMaterialLabControl', 'WebMaterialLabShadowTest',
  'WebProjectWidgetTest', 'WebDefaultCloudTracingTestMode', 'WebDefaultCloudBudgetTestMode',
  'WebDefaultFogTestMode', 'WebThreadTestControl', 'WebDistanceFieldTest', 'WebDistanceFieldTestExposure',
  'WebLightingQualityTest', 'WebVisibilityTest', 'WebOptimizationTest', 'WebTextureReadbackTest', 'WebTraceStart', 'WebTraceStop', 'WebTraceExport', 'WebBindingCacheTest', 'WebBindingGroupTest'
]);
// Emscripten's Worker setImmediate fallback sends a token to its parent. This
// runtime has a custom page host, so schedule locally and yield without a UI hop.
if (!globalThis.setImmediate) {
  const channel = new MessageChannel(), callbacks = new Map();
  let sequence = 0;
  const invoke = id => {
    const callback = callbacks.get(id);
    callbacks.delete(id);
    callback?.();
  };
  channel.port1.onmessage = event => invoke(event.data);
  globalThis.setImmediate = callback => {
    const id = ++sequence;
    callbacks.set(id, callback);
    // Keep yielding for GPU completion and GC. A priority task prevents a second
    // native sweep slice from entering between the proxy notification and RHI.
    if (rhiWakePriority) scheduler.postTask(() => invoke(id), {priority:'user-blocking'}).catch(fail);
    else channel.port2.postMessage(id);
    return id;
  };
  globalThis.clearImmediate = id => callbacks.delete(id);
}
// Only diagnostic values cross to the page. Enumerating globalThis also visits the
// engine's many exported symbols on the RHI owner every 100 ms.
const diagnosticStateKeys = [
  '__webEngineFrames', '__webEngineRuntime', '__webEngineGPUDeviceReady',
  '__webDefaultCamera', '__webDefaultCloudBudget', '__webDefaultFog', '__webDefaultSamples',
  '__webDefaultShadowCamera', '__webDefaultShadowControl', '__webRenderView',
  '__webTextureStreaming', '__webOcclusionRHI', '__webVisualTestClock', '__webGPUHandleDiagnostics',
  '__webThreadFrameTimes', '__webThreadIOProbe', '__webThreadStages',
  '__webThreadsExitCode', '__webThreadsFailure', '__webThreadsMemory', '__webThreadsResult',
  '__webDistanceFields', '__webDistanceFieldsExposure', '__webDistanceFieldsGPU',
  '__webDistanceFieldsLighting', '__webVisibilityAudit', '__webProjectSettings', '__webOptimizationRHI', '__webOptimizationState',
  '__webPSOPrecache', '__webOcclusionHistory', '__webGameFrameClock', '__webRHIWakeScheduler'
];
function snapshot() {
  const state = {};
  for (const key of diagnosticStateKeys)
    if (globalThis[key] !== undefined) state[key] = globalThis[key];
  state.__webEngineThreads = globalThis.__webEngineThreads;
  if (frameCounter) state.__webFramePacing = {timeOrigin: performance.timeOrigin, at: performance.now(),
    times: presentTimes.splice(0), events:pipelineEvents.splice(0)};
  if (frameScheduler) state.__webFrameScheduler = {maxAhead: frameScheduler.maxAhead,
    completed: Atomics.load(frameScheduler.state, 0), submitted: Atomics.load(frameScheduler.state, 1),
    reserved: Atomics.load(frameScheduler.state, 2), peakSubmitted: Atomics.load(frameScheduler.state, 3),
    completions: Atomics.load(frameScheduler.state, 4), peakReserved: Atomics.load(frameScheduler.state, 5),
    ready: !!Atomics.load(frameScheduler.state, 6)};
  state.__webEngineSurface = {width: Module.canvas.width, height: Module.canvas.height};
  const io = globalThis.__webContentIO;
  state.__webLocalContentStats = {...io?.stats, activeRequests: io?.requests.size,
    bulkFiles: io?.files.size, bulkMemfsBytes: io?.filesystem ?
      io.bulkNodes.reduce((total, node) => total + node.contents.byteLength, 0) : 0};
  if (typeof PThread !== 'undefined') state.__webThreadPool = {
    active: Object.keys(PThread.pthreads).length, available: PThread.unusedWorkers.length
  };
  send('state', {state});
}
addEventListener('error', event => fail(event.error || event.message));
addEventListener('unhandledrejection', event => fail(event.reason));
addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'game-clock-visibility') {
    globalThis.__webGameClockHidden = !!message.hidden;
    globalThis.__webGameThreadWorker?.postMessage({type: 'web-game-local-clock', paused: message.hidden});
    return;
  }
  if (message.type === 'start') {
    if (initialized) throw new Error('Engine Worker already initialized');
    initialized = true;
    globalThis.__webGameClockHidden = !!message.gameClockHidden;
    start(message).catch(fail);
  } else if (message.type === 'browser') {
    updateBrowserMetrics(message.state);
  } else if (message.type === 'inputs') {
    if (globalThis.__webInputBound && globalThis.__webGameThreadWorker)
      globalThis.__webGameThreadWorker.postMessage({type: 'web-game-command', message});
    else if (globalThis.__webInputBound) {
      globalThis.__webPendingGameCommand = message;
      try { Module._WebInvokeGameCommand(); send('input-ack'); }
      finally { globalThis.__webPendingGameCommand = null; }
    }
    else send('input-ack');
  } else if (message.type === 'rpc') {
    try {
      if (!rpcNames.has(message.name) || !globalThis.__webInputBound)
        throw new Error('Unavailable engine RPC: ' + message.name);
      if (globalThis.__webGameThreadWorker)
        globalThis.__webGameThreadWorker.postMessage({type: 'web-game-command', message});
      else {
        globalThis.__webPendingGameCommand = message;
        try { send('rpc', {id: message.id, result: Module._WebInvokeGameCommand()}); }
        finally { globalThis.__webPendingGameCommand = null; }
      }
    } catch (error) { send('rpc', {id: message.id, error: error.message}); }
  }
});
async function start(message) {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || !navigator.gpu)
    throw new Error('Engine Worker requires isolated shared memory and WebGPU');
  const assets = message.assets;
  // Approved default; older hosts may omit the option. Explicit channel remains
  // available, and browsers without postTask use the MessageChannel fallback.
  const priorityRequested = !message.arguments.includes('-WebRHIWake=channel');
  rhiWakePriority = priorityRequested && typeof globalThis.scheduler?.postTask === 'function';
  globalThis.__webRHIWakeScheduler = {requested:priorityRequested?'priority':'channel',
    active:rhiWakePriority?'priority':'channel',prioritySupported:typeof globalThis.scheduler?.postTask === 'function'};
  if (message.frameScheduler) {
    const {maxAhead, state, port} = message.frameScheduler;
    if (!Number.isInteger(maxAhead) || maxAhead < 1 || maxAhead > 4 || !(state instanceof SharedArrayBuffer) || state.byteLength !== 32)
      throw new Error('Invalid frame scheduler configuration');
    frameScheduler = {maxAhead, state: new Int32Array(state), attached: false};
    globalThis.__webGPUFrameSubmitted = () => markGpuFrame();
    globalThis.__webAttachFrameScheduler = game => {
      if (frameScheduler.attached) throw new Error('Frame scheduler attached twice');
      frameScheduler.attached = true;
      game.postMessage({type: 'web-frame-clock-port', port}, [port]);
    };
  }
  if (message.frameCounter) {
    frameCounter = new Uint32Array(message.frameCounter);
    // Pipeline creation is rare; retain its timestamps for user-triggered stutter
    // exports without wrapping per-draw calls or waiting for GPU completion.
    for (const name of ['createRenderPipeline','createComputePipeline','createShaderModule',
      'createRenderPipelineAsync','createComputePipelineAsync']) {
      const original = GPUDevice.prototype[name];
      if (!original) continue;
      GPUDevice.prototype[name] = function(...args) {
        const start = performance.now();
        try {return original.apply(this,args);}
        finally {
          pipelineEvents.push({name,start,end:performance.now(),label:args[0]?.label});
          if(pipelineEvents.length>2048)pipelineEvents.splice(0,pipelineEvents.length-2048);
        }
      };
    }
    // Observe completed viewport presents; preserve preinstalled diagnostic accessors.
    const previous = Object.getOwnPropertyDescriptor(globalThis, '__webRHIFrames');
    let value = previous?.get ? previous.get.call(globalThis) : previous?.value || 0;
    Object.defineProperty(globalThis, '__webRHIFrames', {configurable:true, enumerable:true,
      get: () => previous?.get ? previous.get.call(globalThis) : value,
      set(next) {
        if (previous?.set) previous.set.call(globalThis, next);
        value = next;
        if (!Number.isInteger(next) || next <= lastPresented) return;
        lastPresented = next;
        Atomics.store(frameCounter, 0, next);
        presentTimes.push(performance.now());
        if (presentTimes.length > 4096) presentTimes.splice(0, presentTimes.length - 4096);
      }
    });
  }
  const versioned = name => name + '?v=' + assets.versions[name];
  updateBrowserMetrics(message.browser);
  globalThis.__webStartupDiagnostics = {mode: message.debug ? 'debug' : 'normal'};
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    const device = await requestDevice.call(this, descriptor);
    if (frameScheduler) frameScheduler.queue = device.queue;
    device.addEventListener('uncapturederror', event => fail(event.error));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') fail(new Error('WebGPU device lost: ' + info.message));
    });
    return device;
  };
  importScripts(versioned('web-content-io.js'));
  const io = globalThis.__webContentIO = new WebLocalContentIO(versioned('web-content-worker.js'),
    {verification: message.verification});
  io.copy = (destination, bytes) => HEAPU8.set(bytes, Number(destination));
  io.complete = (id, success) => Module._WebLocalReadCompleted(id, success ? 1 : 0);
  io.onprogress = progress => send('progress', {progress: {...progress, ...io.stats}});
  io.onmount = (completed, total) => send('mount', {completed, total});
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async function(input, options) {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.pathname.endsWith('/' + assets.wasm.url) &&
        (options?.method || (input instanceof Request ? input.method : 'GET')) === 'GET') {
      const file = await io.asset(assets.wasm);
      return new Response(file, {headers: {'Content-Type': 'application/wasm'}});
    }
    return nativeFetch.call(this, input, options);
  };
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  const json = async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
  };
  const print = text => {
    text = String(text);
    if (text.startsWith('P3_ENGINE_THREADS '))
      globalThis.__webEngineThreads = JSON.parse(text.slice('P3_ENGINE_THREADS '.length));
    send('log', {text});
  };
  globalThis.Module = {
    arguments: message.arguments,
    canvas: message.canvas,
    mainScriptUrlOrBlob: new URL(versioned(assets.runtime), location.href).href,
    locateFile: name => name === assets.wasm.url ? versioned(name) : name,
    print, printErr: print, onAbort: fail,
    onRuntimeInitialized: () => {
      browserMetricsReady = true;
      updateBrowserMetrics(globalThis.__webBrowserState);
      send('stage', {stage: 'engine-starting'});
    },
    preRun: [() => {
      addRunDependency('worker-content');
      (async () => {
        const [configs, manifest] = await Promise.all([json('config-files.json'), json('content-files.json')]);
        if (manifest.mode !== 'WebGPU-SM5' || manifest.architecture !== 'wasm64' ||
            manifest.shaderPlatform !== 'SP_WEBGPU_SM5' || manifest.pack.url !== 'content.bin')
          throw new Error('Invalid threaded desktop content manifest');
        send('stage', {stage: 'content-mounting'});
        await io.mount(manifest, FS);
        for (const file of configs) {
          if (!/^\/Engine\/(?:Config\/|Platforms\/Web\/Config\/|Programs\/UEWebEngine\/Config\/)/.test(file.path) ||
              /(?:^|\/)\.\.(?:\/|$)/.test(file.path)) throw new Error('Invalid config path');
          const bytes = Uint8Array.from(atob(file.data), value => value.charCodeAt(0));
          if (await digest(bytes) !== file.sha256) throw new Error('Config hash mismatch: ' + file.path);
          FS.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/')));
          FS.writeFile(file.path, bytes);
        }
        removeRunDependency('worker-content');
      })().catch(fail);
    }]
  };
  send('stage', {stage: 'engine-script-loading'});
  importScripts(versioned(assets.runtime));
  setInterval(snapshot, 100);
}
