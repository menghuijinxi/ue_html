'use strict';
// Replay real descriptors exported at the WebGPU boundary, without UE, Wasm,
// content IO, rendering or pthread proxy scheduling.
onmessage = async ({data: {url, concurrency, moduleFence, requestLimit, asyncPipelines, targetEntry, progress}}) => {
  try {
    const corpus = await (await fetch(url)).json();
    if (corpus.version !== 1 || corpus.devices.length !== 1) throw Error('Expected one captured device');
    if (targetEntry) {
      const ids = new Set(corpus.descriptors.filter(d =>
        ['vertex', 'fragment', 'compute'].some(stage => d.descriptor[stage]?.entryPoint === targetEntry)).map(d => d.id));
      corpus.requests = corpus.requests.filter(r => ids.has(r.descriptorId));
      if (!corpus.requests.length) throw Error('No captured pipeline for ' + targetEntry);
    }
    if (requestLimit) {
      corpus.requests = corpus.requests.slice(0, requestLimit);
    }
    if (requestLimit || targetEntry) {
      const ids = new Set(corpus.requests.map(r => r.descriptorId));
      corpus.descriptors = corpus.descriptors.filter(d => ids.has(d.id));
      const modules = new Set();
      for (const d of corpus.descriptors) for (const s of ['vertex', 'fragment', 'compute'])
        if (d.descriptor[s]) modules.add(d.descriptor[s].module.id);
      corpus.modules = corpus.modules.filter(m => modules.has(m.id));
    }
    const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
    const device = await adapter.requestDevice(corpus.devices[0].descriptor), errors = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    if (progress) device.lost.then(info => {
      if (info.reason !== 'destroyed') postMessage({error: 'Device lost: ' + info.message});
    });
    const objects = new Map(), descriptors = new Map(), kept = [];
    function decode(value) {
      if (value === null || typeof value !== 'object') return value;
      if (value.$gpu) {
        if (!objects.has(value.id)) throw Error('Missing captured resource ' + JSON.stringify(value));
        return objects.get(value.id);
      }
      if (Array.isArray(value)) return value.map(decode);
      return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, decode(v)]));
    }
    const moduleStart = performance.now();
    for (const m of corpus.modules) objects.set(m.id, device.createShaderModule(m.descriptor));
    const moduleEnd = performance.now();
    if (moduleFence) for (const info of await Promise.all(corpus.modules.map(m => objects.get(m.id).getCompilationInfo())))
      for (const message of info.messages) if (message.type === 'error') errors.push(message.message);
    const moduleReady = performance.now();
    for (const l of corpus.layouts) objects.set(l.id, device[l.$gpu === 'bindGroupLayout' ? 'createBindGroupLayout' : 'createPipelineLayout'](decode(l.descriptor)));
    for (const d of corpus.descriptors) descriptors.set(d.id, decode(d.descriptor));
    const layoutEnd = performance.now(), attempts = [], begin = performance.now();
    let cursor = 0;
    async function lane() {
      while (cursor < corpus.requests.length) {
        const r = corpus.requests[cursor++], start = performance.now();
        const a = {id: r.id, descriptorId: r.descriptorId, method: r.name, start: start - begin}; attempts.push(a);
        if (asyncPipelines && !a.method.endsWith('Async')) a.method += 'Async';
        if (progress) postMessage({progress: {id: a.id, method: a.method, descriptorId: a.descriptorId}});
        try {
          const promise = device[a.method](descriptors.get(r.descriptorId)); a.callMs = performance.now() - start;
          kept.push(await promise); a.success = true;
        } catch (e) {a.success = false; a.error = e.message;}
        a.end = performance.now() - begin;
      }
    }
    await Promise.all(Array.from({length: concurrency}, lane));
    const end = performance.now();
    if (progress) {
      await device.queue.onSubmittedWorkDone();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    // Keep returned objects alive until all requests have completed. This is a
    // fresh-device/reload measurement, never a second call on retained objects.
    const result = {adapter: Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(k => [k, adapter.info[k]])), concurrency, modules: corpus.modules.length,
      moduleChars: corpus.modules.reduce((s,m) => s + m.descriptor.code.length, 0),
      moduleApiMs: moduleEnd - moduleStart, moduleReadyMs: moduleReady - moduleStart, layoutApiMs: layoutEnd - moduleReady,
      pipelineWallMs: end - begin, preparationAndPipelinesMs: end - moduleStart,
      successful: kept.length, failed: attempts.filter(a => !a.success).length, errors, attempts};
    globalThis.__replayObjects = {device, objects, kept};
    postMessage({result}); // Retain the device for cache flush and memory diagnostics.
  } catch (e) {postMessage({error: e.stack || String(e)}); close();}
};
