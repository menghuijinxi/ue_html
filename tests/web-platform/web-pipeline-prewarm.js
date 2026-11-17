'use strict';
// Per-device interning uses complete descriptors, including shader source. A
// miss always reaches WebGPU; no pipeline or draw is substituted or skipped.
function createWebPipelineCache(device) {
  const resources = new WeakMap(), records = new Map(), pipelines = new Map(), pending = new Map();
  const native = {}, counts = {modules: 0, layouts: 0, ready: 0, hits: 0, misses: 0,
    pendingHits: 0, syncWhilePending: 0, active: 0, peakActive: 0};
  const queue = [];
  let sequence = 0, compileLimit = 2;
  function pump() {
    while (counts.active < compileLimit && queue.length) {
      const {kind, descriptor, key, resolve, reject} = queue.shift();
      ++counts.active;
      counts.peakActive = Math.max(counts.peakActive, counts.active);
      let creation;
      try {creation = native['create' + kind + 'PipelineAsync'](descriptor);}
      catch (error) {creation = Promise.reject(error);}
      Promise.resolve(creation).then(pipeline => {
        pipelines.set(key, pipeline); ++counts.ready;
        pending.delete(key); --counts.active; resolve(pipeline); pump();
      }, error => {
        pending.delete(key); --counts.active; reject(error); pump();
      });
    }
  }
  function compile(kind, descriptor, key) {
    if (pipelines.has(key)) return Promise.resolve(pipelines.get(key));
    if (pending.has(key)) return pending.get(key);
    let resolve, reject;
    const promise = new Promise((success, failure) => {resolve = success; reject = failure;});
    pending.set(key, promise);
    queue.push({kind, descriptor, key, resolve, reject});
    pump();
    return promise;
  }
  const encode = value => {
    if (value === null || typeof value !== 'object') return value;
    if (resources.has(value)) return {$resource: resources.get(value)};
    if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, encode);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error('Unknown pipeline descriptor resource');
    return Object.fromEntries(Object.keys(value).sort()
      .filter(key => value[key] !== undefined).map(key => [key, encode(value[key])]));
  };
  const keyFor = (kind, descriptor) => {
    const {label, ...semantic} = descriptor;
    return kind + ':' + JSON.stringify(encode(semantic));
  };
  for (const name of ['createShaderModule', 'createBindGroupLayout', 'createPipelineLayout',
    'createRenderPipeline', 'createComputePipeline', 'createRenderPipelineAsync', 'createComputePipelineAsync'])
    native[name] = device[name].bind(device);
  for (const name of ['createShaderModule', 'createBindGroupLayout', 'createPipelineLayout']) {
    device[name] = descriptor => {
      const key = keyFor(name, descriptor);
      if (records.has(key)) return records.get(key);
      const value = native[name](descriptor);
      resources.set(value, ++sequence); records.set(key, value);
      ++counts[name === 'createShaderModule' ? 'modules' : 'layouts'];
      return value;
    };
  }
  for (const kind of ['Render', 'Compute']) {
    for (const suffix of ['', 'Async']) {
      const name = 'create' + kind + 'Pipeline' + suffix;
      device[name] = descriptor => {
        const key = keyFor(kind, descriptor), value = pipelines.get(key);
        if (value) {++counts.hits; return suffix ? Promise.resolve(value) : value;}
        if (pending.has(key)) {
          if (suffix) {++counts.hits; ++counts.pendingHits; return pending.get(key);}
          ++counts.syncWhilePending;
        }
        ++counts.misses;
        return suffix ? compile(kind, descriptor, key) : native[name](descriptor);
      };
    }
  }
  async function replay(pack, concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
      throw new Error('Invalid pipeline replay concurrency');
    compileLimit = concurrency;
    const objects = new Map(), definitions = new Map(), creating = new Set();
    for (const [kind, records] of [['module', pack.modules], ['layout', pack.layouts]])
      for (const record of records) {
        if (definitions.has(record.id)) throw new Error('Duplicate prewarm resource ' + record.id);
        definitions.set(record.id, {kind, record});
      }
    const objectFor = reference => {
      const {id, $gpu: type} = reference;
      const definition = definitions.get(id);
      if (!definition) throw new Error('Missing prewarm resource ' + id);
      const {kind, record} = definition;
      if (type !== (kind === 'module' ? 'module' : record.$gpu))
        throw new Error('Wrong prewarm resource type ' + id);
      if (objects.has(id)) return objects.get(id);
      if (creating.has(id)) throw new Error('Cyclic prewarm resource ' + id);
      creating.add(id);
      const method = kind === 'module' ? 'createShaderModule' :
        record.$gpu === 'bindGroupLayout' ? 'createBindGroupLayout' : 'createPipelineLayout';
      const value = device[method](decode(record.descriptor));
      objects.set(id, value);
      creating.delete(id);
      return value;
    };
    const decode = value => {
      if (value === null || typeof value !== 'object') return value;
      if (value.$gpu) return objectFor(value);
      if (Array.isArray(value)) return value.map(decode);
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
    };
    // Build only the next pipeline's dependencies, then submit it immediately.
    // Dawn can compile it while subsequent WGSL modules are being prepared.
    let next = 0;
    await Promise.all(Array.from({length: concurrency}, async () => {
      while (next < pack.descriptors.length) {
        const record = pack.descriptors[next++], descriptor = decode(record.descriptor);
        const kind = record.kind === 'render' ? 'Render' : 'Compute', key = keyFor(kind, descriptor);
        if (pipelines.has(key)) continue;
        if (pending.has(key)) {await pending.get(key); continue;}
        await compile(kind, descriptor, key);
      }
    }));
  }
  return {counts, replay};
}

async function prepareWebPipelinePrewarm(assets) {
  const requestDevice = GPUAdapter.prototype.requestDevice;
  const settings = assets.pipelinePrewarm;
  if (settings.handoff !== undefined && !['complete', 'overlap'].includes(settings.handoff))
    throw new Error('Invalid pipeline prewarm handoff');
  const concurrency = settings.concurrency ?? Math.min(16, Math.max(2,
    Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error('Invalid pipeline prewarm concurrency');
  const state = globalThis.__webPipelinePrewarm = {
    mode: 'preparing', start: performance.now(), ready: false, adopted: false, concurrency,
    handoff: settings.handoff || 'overlap'
  };
  const [adapter, pack] = await Promise.all([
    navigator.gpu.requestAdapter({powerPreference: 'high-performance'}),
    (async () => {
      const response = await fetch(settings.url + '?v=' + settings.sha256);
      if (!response.ok) throw new Error('Prewarm pack HTTP ' + response.status);
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        value => value.toString(16).padStart(2, '0')).join('');
      if (hash !== settings.sha256) throw new Error('Prewarm pack hash mismatch');
      return JSON.parse(new TextDecoder().decode(bytes));
    })()
  ]);
  if (pack.version !== 1 || pack.wasm !== assets.wasm.sha256 || pack.content !== settings.content ||
      pack.config !== settings.config || pack.devices.length !== 1 || !pack.descriptors.length)
    throw new Error('Prewarm pack does not match this build');
  if (!adapter) throw new Error('No adapter for pipeline prewarm');
  const device = await requestDevice.call(adapter, pack.devices[0].descriptor);
  let lost, validation;
  device.addEventListener('uncapturederror', event => {
    validation = event.error; state.error = event.error.message;
  });
  device.lost.then(info => {
    lost = info;
    state.lost = {reason: info.reason, message: info.message, at: performance.now()};
  });
  try {
    const cache = createWebPipelineCache(device);
    state.counts = cache.counts;
    const completed = cache.replay(pack, state.concurrency).then(() => {
      if (lost) throw new Error('Prewarm device lost: ' + lost.message);
      if (validation) throw validation;
      state.ready = true; state.mode = state.adopted ? 'active' : 'ready'; state.completed = performance.now();
    }).catch(error => {
      state.error = error.message; state.mode = 'failed'; device.destroy(); throw error;
    });
    // Overlap callers still observe completion/failure before exposing the scene.
    completed.catch(() => {});
    if (state.handoff === 'complete') await completed;
    return {
      state, completed,
      take(request) {
        const features = Array.from(request.requiredFeatures || []);
        const fits = features.every(feature => device.features.has(feature)) &&
          Object.entries(request.requiredLimits || {}).every(([name, value]) =>
            name.startsWith('min') ? device.limits[name] <= value : device.limits[name] >= value);
        if (!fits || state.adopted || lost || state.error) return null;
        state.adopted = true; state.adoptedAt = performance.now();
        state.mode = state.ready ? 'active' : 'overlapping'; return device;
      },
      dispose() {if (!state.adopted) device.destroy();}
    };
  } catch (error) {device.destroy(); throw error;}
}
if (typeof module !== 'undefined' && module.exports)
  module.exports = {createWebPipelineCache, prepareWebPipelinePrewarm};
