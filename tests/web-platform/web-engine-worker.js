'use strict';
// The main runtime owns FS, IO, GPU objects and RHI translation. GT/RT are pthreads.
let initialized = false;
const send = (type, values = {}) => postMessage({type, ...values});
const fail = error => send('failure', {message: error?.stack || error?.message || String(error)});
const rpcNames = new Set([
  'WebTextureStreamingTestBudget', 'WebOcclusionTestMode', 'WebDefaultSamplesVisibility',
  'WebDefaultSceneTestMode', 'WebProjectLightingTestMode', 'WebProjectViewTest',
  'WebDefaultShadowControl', 'WebMaterialLabControl', 'WebMaterialLabShadowTest',
  'WebProjectWidgetTest', 'WebDefaultCloudTracingTestMode', 'WebDefaultCloudBudgetTestMode',
  'WebDefaultFogTestMode', 'WebThreadTestControl', 'WebDistanceFieldTest', 'WebDistanceFieldTestExposure',
  'WebLightingQualityTest', 'WebVisibilityTest'
]);
// Emscripten's Worker setImmediate fallback sends a token to its parent. This
// runtime has a custom page host, so schedule locally and yield without a UI hop.
if (!globalThis.setImmediate) {
  const channel = new MessageChannel(), callbacks = new Map();
  let sequence = 0;
  channel.port1.onmessage = event => {
    const callback = callbacks.get(event.data);
    callbacks.delete(event.data);
    callback?.();
  };
  globalThis.setImmediate = callback => {
    const id = ++sequence;
    callbacks.set(id, callback);
    channel.port2.postMessage(id);
    return id;
  };
  globalThis.clearImmediate = id => callbacks.delete(id);
}
function snapshot() {
  const state = {};
  for (const key of Object.keys(globalThis)) {
    if (!/^__web(?:EngineFrames|EngineRuntime|EngineGPUDeviceReady|Default|RenderView|TextureStreaming|OcclusionRHI|VisualTestClock|GPUHandleDiagnostics|Thread|DistanceFields|Visibility|ProjectSettings)/.test(key))
      continue;
    state[key] = globalThis[key];
  }
  state.__webEngineThreads = globalThis.__webEngineThreads;
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
  if (message.type === 'start') {
    if (initialized) throw new Error('Engine Worker already initialized');
    initialized = true;
    start(message).catch(fail);
  } else if (message.type === 'browser') {
    globalThis.__webBrowserState = message.state;
    globalThis.devicePixelRatio = message.state.dpr;
  } else if (message.type === 'inputs') {
    if (globalThis.__webInputBound && globalThis.__webGameThreadWorker)
      globalThis.__webGameThreadWorker.postMessage({type: 'web-game-command', message});
    else send('input-ack');
  } else if (message.type === 'rpc') {
    try {
      if (!rpcNames.has(message.name) || !globalThis.__webInputBound)
        throw new Error('Unavailable engine RPC: ' + message.name);
      if (!globalThis.__webGameThreadWorker) throw new Error('Game thread unavailable');
      globalThis.__webGameThreadWorker.postMessage({type: 'web-game-command', message});
    } catch (error) { send('rpc', {id: message.id, error: error.message}); }
  }
});
async function start(message) {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || !navigator.gpu)
    throw new Error('Engine Worker requires isolated shared memory and WebGPU');
  const assets = message.assets;
  const versioned = name => name + '?v=' + assets.versions[name];
  globalThis.__webBrowserState = message.browser;
  globalThis.devicePixelRatio = message.browser.dpr;
  globalThis.__webStartupDiagnostics = {mode: message.debug ? 'debug' : 'normal'};
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    const device = await requestDevice.call(this, descriptor);
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
    onRuntimeInitialized: () => send('stage', {stage: 'engine-starting'}),
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
