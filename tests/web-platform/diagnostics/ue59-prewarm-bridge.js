'use strict';
// Diagnostic bridge only. The page prewarm implementation is copied verbatim
// into a lexical wrapper; its capture, ordering and replay code remain unchanged.
async function prepareWebPipelinePrewarm(assets) {
  const settings = assets.pipelinePrewarm;
  const requestDevice = GPUAdapter.prototype.requestDevice;
  const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const state = globalThis.__webPipelinePrewarm = {
    mode: 'preparing', implementation: 'ue59-page-source', start: performance.now(),
    ready: false, adopted: false, concurrency: 16, handoff: 'overlap',
    capture: !!settings.capture, counts: {ready: 0, hits: 0, misses: 0, pendingHits: 0},
  };
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  let pack;
  if (!settings.capture) {
    const response = await nativeFetch(settings.url + '?v=' + settings.sha256);
    if (!response.ok) throw new Error('UE59 pack HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    if (await digest(bytes) !== settings.sha256) throw new Error('UE59 pack hash mismatch');
    pack = JSON.parse(new TextDecoder().decode(bytes));
    if (!pack.pipelines?.length || pack.diagnosticBinding?.wasm !== assets.wasm.sha256 ||
        pack.diagnosticBinding.content !== settings.content || pack.diagnosticBinding.config !== settings.config)
      throw new Error('UE59 pack does not match this build');
  }
  const page = new EventTarget(), storage = new Map();
  const root = await navigator.storage.getDirectory();
  const visits = await root.getDirectoryHandle('ue59-prewarm-visits', {create: true});
  try {
    const file = await (await visits.getFileHandle('visits.json')).getFile();
    for (const [key, value] of JSON.parse(await file.text())) storage.set(key, value);
  } catch (error) {if (error.name !== 'NotFoundError') throw error;}
  const facade = {
    addEventListener: page.addEventListener.bind(page),
    uePrewarm: null,
  };
  let resolveComplete, rejectComplete;
  const completed = new Promise((resolve, reject) => {resolveComplete = resolve; rejectComplete = reject;});
  completed.catch(() => {});
  let device, adopted = false, poll;
  const fail = error => {
    state.error = error.message; state.mode = 'failed';
    clearInterval(poll); rejectComplete(error);
  };
  const bridge = globalThis.__ue59PrewarmBridge = {
    window: facade,
    // Worker-side equivalent of the page's frame budget. No per-draw hooks.
    requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 16),
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => {
        storage.set(key, value);
        state.visitSaved = false;
        bridge.savedVisit = visits.getFileHandle('visits.json', {create: true}).then(async handle => {
          const writer = await handle.createWritable();
          await writer.write(JSON.stringify([...storage])); await writer.close();
          state.visitSaved = true;
        });
        bridge.savedVisit.catch(fail);
      },
    },
    navigator: {
      userAgent: navigator.userAgent, maxTouchPoints: 0,
      storage: {getDirectory: () => navigator.storage.getDirectory()},
      gpu: {
        getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat(),
        requestAdapter: async options => {
          const adapter = await requestAdapter(options);
          if (!adapter) return null;
          return {
            features: adapter.features, limits: adapter.limits,
            requestDevice: async requested => {
              state.officialDeviceRequest = requested;
              // Current VSM requires a feature absent from this UE59 RHI's list.
              // Use the current RHI contract and verify it again at adoption.
              device = await requestDevice.call(adapter, settings.device);
              state.deviceRequest = settings.device;
              device.addEventListener('uncapturederror', event => fail(event.error));
              device.lost.then(info => {
                if (info.reason !== 'destroyed') fail(new Error('UE59 device lost: ' + info.message));
              });
              return device;
            },
          };
        },
      },
    },
    fetch: async (input, options) => {
      const url = new URL(input, location.href);
      if (url.pathname.endsWith('/wasm-cache.json'))
        return new Response(JSON.stringify(settings.listing), {headers: {'Content-Type': 'application/json'}});
      if (url.pathname.endsWith('/Content/WebGPUPrewarm-SF_WEBGPU_SM5.json') && pack)
        return new Response(JSON.stringify(pack), {headers: {'Content-Type': 'application/json'}});
      return nativeFetch(input, options);
    },
  };
  const notify = (name, detail) => page.dispatchEvent(new CustomEvent(name, {detail}));
  importScripts('ue59-prewarm-source.js?v=' + assets.versions['ue59-prewarm-source.js']);
  if (!facade.uePrewarm || facade.uePrewarm.mode === 'off') throw new Error('UE59 prewarm did not arm');
  facade.uePrewarm.start(Promise.resolve(['-WebGPUSM5']));
  device = await facade.uePrewarm.device(30000);
  if (!device) throw new Error('UE59 prewarm device handoff failed');
  const update = () => {
    const summary = facade.uePrewarm.summary();
    state.official = summary;
    if (summary.failures || summary.made.pipeline_errors) return fail(new Error('UE59 replay reported failures'));
    state.counts.ready = summary.made.pipelines_ready;
    state.counts.hits = summary.hits.render.hit + summary.hits.compute.hit;
    state.counts.misses = summary.hits.render.miss + summary.hits.compute.miss;
    if (!settings.capture && summary.marks.pipelines !== undefined &&
        summary.made.pipelines_ready === pack.pipelines.length && !state.ready) {
      state.ready = true; state.completed = performance.now();
      state.mode = adopted ? 'active' : 'ready'; resolveComplete();
    }
    if (!state.engineReady && globalThis.__webEngineFrames >= 30 && (settings.capture || state.ready)) {
      state.engineReady = performance.now();
      notify('ue-ready');
    }
  };
  if (settings.capture) {
    // This gate is explicitly capture-only, never an approved release.
    state.ready = true; state.mode = 'capture'; resolveComplete();
  }
  poll = setInterval(update, 50);
  update();
  return {
    state, completed,
    take(request) {
      const features = [...request.requiredFeatures || []].sort();
      const expected = [...settings.device.requiredFeatures || []].sort();
      const limits = Object.entries(request.requiredLimits || {});
      if (adopted || state.error || JSON.stringify(features) !== JSON.stringify(expected) ||
          limits.some(([key, value]) => settings.device.requiredLimits[key] !== value) ||
          limits.length !== Object.keys(settings.device.requiredLimits || {}).length) {
        fail(new Error('Current RHI device request differs from UE59 bridge contract')); return null;
      }
      adopted = state.adopted = true; state.adoptedAt = performance.now();
      state.mode = settings.capture ? 'capture' : state.ready ? 'active' : 'overlapping';
      notify('ue-webgpu-device', {page: true, why: 'current Worker bridge'});
      return device;
    },
    dispose() {if (!adopted) {clearInterval(poll); device.destroy();}},
  };
}
