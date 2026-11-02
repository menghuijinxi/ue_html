'use strict';
// Matched standalone WebGPU/D3D12 workload. Shader translation and opaque driver
// caches are deliberately reported separately from explicit pipeline-library hits.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag') || 'pso-api-v1';
assert(/^[a-z0-9-]+$/.test(tag));
const root = __dirname, output = path.join(root, 'results', tag);
const profile = path.join(root, 'build/browser-profiles', tag);
const build = path.join(root, 'build/pso-api-benchmark');
const N = 64, SEED = 700001;
const noDiskCache = process.argv.includes('--no-disk-cache');
const webOnly = process.argv.includes('--web-only');
const browserRounds = Number(option('browsers') || 3);
assert(Number.isInteger(browserRounds) && browserRounds >= 1 && browserRounds <= 5);

async function workload({N, SEED, concurrency, runtime}) {
  const summary = values => {
    const a = [...values].sort((a, b) => a - b);
    return {count: a.length, sumMs: a.reduce((a, b) => a + b, 0), medianMs: a[Math.floor(a.length / 2)],
      p95Ms: a[Math.floor(a.length * .95)], maxMs: a.at(-1)};
  };
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const deviceId = crypto.randomUUID(), errors = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.lost.then(info => {if (info.reason !== 'destroyed') errors.push(info.message);});
  const adapterInfo = {vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device,
    description: adapter.info.description};
  const source = (seed, compute) => `fn calc(input: u32) -> u32 {var v = input; for(var i=0u;i<64u;i++){v=v*1664525u+1013904223u;}return v;}
    ${compute ? `@group(0) @binding(0) var<storage,read_write> output:array<u32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){output[id.x]=calc(id.x+${seed}u);}` :
    `@fragment fn main(@builtin(position) p:vec4f)->@location(0) vec4f{let v=calc(u32(p.x)+u32(p.y)*16u+${seed}u);
      return vec4f(f32(v&255u),f32((v>>8u)&255u),f32((v>>16u)&255u),255.0)/255.0;}`}`;
  const vertexCode = `@vertex fn main(@builtin(vertex_index) id:u32)->@builtin(position) vec4f{
    var p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[id],0,1);}`;
  const modulesAt = performance.now();
  const vs = device.createShaderModule({code: vertexCode});
  const ps = Array.from({length: N}, (_, i) => device.createShaderModule({code: source(SEED + i, false)}));
  const cs = Array.from({length: N}, (_, i) => device.createShaderModule({code: source(SEED + i, true)}));
  const moduleEnqueueMs = performance.now() - modulesAt;
  const graphicsLayout = device.createPipelineLayout({bindGroupLayouts: []});
  const computeBGL = device.createBindGroupLayout({entries: [{binding: 0, visibility: GPUShaderStage.COMPUTE,
    buffer: {type: 'storage', minBindingSize: 256}}]});
  const computeLayout = device.createPipelineLayout({bindGroupLayouts: [computeBGL]});
  const gp = [], cp = [], calls = [], wallAt = performance.now();
  let next = 0, created = 0;
  const work = async () => {
    while (next < 2 * N) {
      const j = next++, i = Math.floor(j / 2), compute = j % 2, at = performance.now();
      if (compute) cp[i] = await device.createComputePipelineAsync({layout: computeLayout, compute: {module: cs[i], entryPoint: 'main'}});
      else gp[i] = await device.createRenderPipelineAsync({layout: graphicsLayout, vertex: {module: vs, entryPoint: 'main'},
        fragment: {module: ps[i], entryPoint: 'main', targets: [{format: 'rgba8unorm'}]}, primitive: {topology: 'triangle-list', cullMode: 'none'}});
      created++; calls.push({index: j, kind: compute ? 'compute' : 'graphics', ms: performance.now() - at});
    }
  };
  await Promise.all(Array.from({length: concurrency}, work));
  const creationWallMs = performance.now() - wallAt;
  const report = {deviceId, adapter: adapterInfo, pipelines: 2 * N, created, concurrency, moduleEnqueueMs,
    creationWallMs, creationCalls: summary(calls.map(x => x.ms)), calls, runtime: [], errors};
  const texture = device.createTexture({size: [16, 16], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
  const view = texture.createView(), buffer = device.createBuffer({size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
  const group = device.createBindGroup({layout: computeBGL, entries: [{binding: 0, resource: {buffer}}]});
  const readback = device.createBuffer({size: 8192, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
  function begin(compute) {
    const encoder = device.createCommandEncoder();
    const pass = compute ? encoder.beginComputePass() : encoder.beginRenderPass({colorAttachments: [{view, loadOp: 'load', storeOp: 'store'}]});
    if (compute) pass.setBindGroup(0, group);
    else {pass.setViewport(0, 0, 16, 16, 0, 1); pass.setScissorRect(0, 0, 1, 1);}
    return {encoder, pass};
  }
  const workOne = (pass, compute) => compute ? pass.dispatchWorkgroups(1) : pass.draw(3);
  async function submit({encoder, pass}) {const at = performance.now(); pass.end(); device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone(); return performance.now() - at;}
  // Force every pipeline through actual execution before measuring existing objects.
  for (const compute of [false, true]) {
    const batch = begin(compute);
    for (const pipeline of compute ? cp : gp) {batch.pass.setPipeline(pipeline); workOne(batch.pass, compute);}
    await submit(batch);
  }
  if (runtime) for (const compute of [false, true]) for (let mode = 0; mode < 3; mode++) {
    const pipelines = compute ? cp : gp, binds = [], encode = [], completion = [];
    for (let frame = 0; frame < 90; frame++) {
      let batch = begin(compute), start = performance.now();
      batch.pass.setPipeline(pipelines[0]);
      for (let j = 0; j < 1000; j++) {if (mode) batch.pass.setPipeline(pipelines[mode === 2 ? j % N : 0]); workOne(batch.pass, compute);}
      const encoded = performance.now() - start, finished = await submit(batch);
      batch = begin(compute); start = performance.now();
      for (let j = 0; j < 10000; j++) batch.pass.setPipeline(pipelines[mode === 2 ? j % N : 0]);
      const binding = performance.now() - start; await submit(batch);
      if (frame >= 10) {encode.push(encoded); completion.push(finished); binds.push(binding);}
    }
    report.runtime.push({kind: compute ? 'compute' : 'graphics', mode, operationsPerFrame: 1000, bindOnlyOperations: 10000,
      encode: summary(encode), closeSubmitFence: summary(completion), bindOnly: summary(binds)});
  }
  // Check both shader paths, including the last pipeline in the switching loop.
  for (const compute of [false, true]) {
    const batch = begin(compute), pipelines = compute ? cp : gp;
    for (let j = 0; j < 1000; j++) {batch.pass.setPipeline(pipelines[j % N]); workOne(batch.pass, compute);}
    await submit(batch);
  }
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, readback, 0, 256);
  encoder.copyTextureToBuffer({texture}, {buffer: readback, offset: 512, bytesPerRow: 256}, [16, 16]);
  device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
  const mapped = readback.getMappedRange(), ints = new Uint32Array(mapped, 0, 64), pixel = new Uint8Array(mapped, 512, 4);
  const hash = input => {let v = input; for (let i = 0; i < 64; i++) v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v;};
  const seed = SEED + 999 % N, v = hash(seed);
  if (ints.some((n, i) => n !== hash(i + seed)) || pixel.some((n, i) => n !== (i === 3 ? 255 : (v >>> (i * 8)) & 255)))
    throw new Error('Standalone shader output mismatch');
  readback.unmap();
  if (errors.length) throw new Error(errors.join('\n'));
  report.createdDuringRuntime = created - 2 * N;
  report.outputVerified = true;
  // Hold actual objects until this device is destroyed. Runtime never creates PSOs.
  globalThis.__standalonePSO = {device, gp, cp};
  return report;
}

(async () => {
  const report = {date: new Date().toISOString(), tag, pass: false, N, SEED, noDiskCache, webOnly, browserRounds, runs: [],
    environment: {cpu: os.cpus()[0].model, logicalCores: os.cpus().length, os: os.version(), node: process.version},
    workload: {graphics: '64 full-screen triangle shaders; RGBA8 16x16 target, 1x1 scissor, no depth/blend/culling',
      compute: '64 shaders, one 64-thread workgroup, 256-byte storage output',
      arithmetic: '64 uint32 multiply-add iterations per invocation; differing constant seed per pipeline',
      creationConcurrency: 1, measuredFramesPerMode: 80, warmupFramesPerMode: 10,
      runtimeModes: ['one setPipeline, 1000 draws/dispatches', '1000 redundant sets + draws/dispatches', '1000 cycling sets + draws/dispatches'],
      bindOnly: '10000 setPipeline calls per sample; CPU encoding only; no draw/dispatch',
      timingBoundary: 'WGSL input for WebGPU, prepared DXIL for D3D12; no source compilation in native PSO timer. Queue completion includes GPU execution, IPC, scheduling and notification.'},
    cacheBoundary: 'A new browser profile is not a cleared NVIDIA/Windows driver cache. Dawn generic cache hits are not a final-PSO hit rate.',
    source: [__filename, path.join(root, 'pso-api-benchmark.cpp')].map(file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
  const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
  try {
    assert(fs.existsSync(path.join(build, 'pso-api-benchmark.exe')), 'Build the native benchmark first');
    assert(!fs.existsSync(profile), 'Use a new tag for an untouched diagnostic browser profile');
    for (let browserRound = 0; browserRound < browserRounds; browserRound++) {
      const requestedAdditionalArguments = noDiskCache ? ['--disable-gpu-shader-disk-cache'] : [];
      const context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
        viewport: {width: 640, height: 480}, args: requestedAdditionalArguments});
      try {
        await context.route('**/standalone-pso.html', route => route.fulfill({status: 200, contentType: 'text/html',
          headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
          body: '<!doctype html><title>Standalone pipeline cache benchmark</title><p>128 equivalent WebGPU / D3D12 pipelines</p>'}));
        const page = context.pages()[0], cdp = await context.newCDPSession(page);
        report.browser = await cdp.send('Browser.getVersion');
        report.browserCommand = await cdp.send('Browser.getBrowserCommandLine').catch(e => ({unavailable: e.message,
          requestedAdditionalArguments, note: 'This installed browser does not expose its command line through CDP.'}));
        for (let pageRound = 0; pageRound < 2; pageRound++) {
          const state = browserRound === 0 && pageRound === 0 ? 'new-profile' : pageRound ? 'page-reload' : 'browser-reopen';
          if (pageRound) await page.reload(); else await page.goto('http://127.0.0.1:8765/standalone-pso.html');
          await page.bringToFront();
          // All comparable creation and runtime timings have browser tracing off.
          const run = await page.evaluate(workload, {N, SEED, concurrency: 1, runtime: pageRound === 1});
          run.backend = 'WebGPU'; run.state = state; run.browserRound = browserRound; run.pageRound = pageRound;
          report.runs.push(run); save();
          console.log(`WebGPU ${state}: ${run.creationWallMs.toFixed(3)} ms / ${run.pipelines}`);
          // Separate diagnostic only: tracing adds measurable overhead to creation.
          if (pageRound === 1) {
            await page.evaluate(() => __standalonePSO.device.destroy());
            const trace = [], onData = e => trace.push(...e.value);
            cdp.on('Tracing.dataCollected', onData);
            await cdp.send('Tracing.start', {categories: 'disabled-by-default-gpu.dawn,gpu,toplevel', options: 'record-until-full'});
            const use = await page.evaluate(workload, {N, SEED, concurrency: 1, runtime: false});
            const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
            await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', onData);
            const traceFile = output + `-b${browserRound}-trace.json`;
            fs.writeFileSync(traceFile, JSON.stringify({traceEvents: trace}));
            const tasks = trace.filter(e => e.name === 'DawnPlatformImpl::RunWorkerTask' && e.ph === 'X');
            use.trace = {file: traceFile, genericCacheHits: trace.filter(e => e.name === 'DawnCachingInterface::CacheHit').length,
              workerTasks: tasks.length, workerWallSumMs: tasks.reduce((s, e) => s + e.dur, 0) / 1000};
            use.backend = 'WebGPU'; use.state = 'cache-trace-diagnostic'; use.browserRound = browserRound;
            report.runs.push(use); save();
          }
        }
      } finally {await context.close();}
    }
    if (!webOnly) {
    const exe = path.join(build, 'pso-api-benchmark.exe'), assets = path.join(build, 'assets');
    report.nativeExecutable = {file: exe, sha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')};
    report.dxil = fs.readdirSync(assets).filter(name => name.endsWith('.dxil')).map(name => ({name,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(assets, name))).digest('hex')}));
    // A new library path avoids silently inheriting another test's explicit cache.
    const nativeDir = path.join(build, tag); fs.mkdirSync(nativeDir);
    for (const name of fs.readdirSync(assets)) if (name.endsWith('.dxil')) fs.copyFileSync(path.join(assets, name), path.join(nativeDir, name));
    for (const state of ['new-library', 'library-reopen-1', 'implicit-cache', 'library-reopen-2', 'new-blobs', 'blobs-reopen-1', 'blobs-reopen-2']) {
      const file = output + '-dx12-' + state + '.json';
      const mode = state === 'implicit-cache' ? 'implicit' : state.includes('blobs') ? 'blob' : 'library';
      execFileSync(exe, ['run', nativeDir, file, mode], {stdio: 'inherit', timeout: 300000});
      const result = JSON.parse(fs.readFileSync(file)); result.state = state; result.file = file;
      assert(result.pass && result.outputVerified);
      if (state.startsWith('library-reopen')) assert.equal(result.libraryHits, 2 * N);
      if (state.startsWith('blobs-reopen')) assert.equal(result.cachedBlobsSucceeded, 2 * N);
      report.runs.push(result); save();
    }
    }
    const devices = report.runs.filter(x => x.deviceId).map(x => x.deviceId);
    assert.equal(new Set(devices).size, devices.length, 'Every restart creates a different device');
    assert(report.runs.every(x => x.outputVerified)); report.pass = true;
  } finally {save();}
})().catch(e => {console.error(e); process.exitCode = 1;});
