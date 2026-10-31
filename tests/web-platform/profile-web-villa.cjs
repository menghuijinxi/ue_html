const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag') || 'baseline';
const folder = option('folder') || 'triplex-house-villa-df-distance-fields-threads';
const width = Number(option('width') || 1280), height = Number(option('height') || 720);
const seconds = Number(option('seconds') || 5);
const channel = option('browser') || 'msedge';
assert(['msedge', 'chrome'].includes(channel));
const loaderOnly = process.argv.includes('--loader-only');
const checkVisibility = process.argv.includes('--visibility');
const visibilityOnly = process.argv.includes('--visibility-only');
const phases = option('phases')?.split(',');
const projectSettings = process.argv.includes('--project-settings');
assert(!projectSettings || !checkVisibility && !visibilityOnly &&
  !process.argv.includes('--shadow-cache-check') && !option('shadow-cache-mb') &&
  phases?.every(phase => ['room-on', 'wall-on', 'room-restored'].includes(phase)),
  'Project settings measurements require explicit camera-only phases');
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
const directory = path.join(__dirname, 'results');
const profile = path.join(__dirname, 'build/browser-profiles',
  option('profile') || (channel === 'msedge' ? 'performance-villa' : `performance-villa-${channel}`));
const report = {date: new Date().toISOString(), tag, folder, channel, width, height, seconds, phases: [],
  errors: [], logs: [], stages: [], pass: false,
  boundary: 'Normal game clock, full internal resolution and packaged quality. FPS uses completed RHI presents when available. CPU sample source distinguishes the old combined callback from game ticks including waits; RHI work is reported separately. GPU timestamps exclude copies/gaps. Descriptor bytes are estimates, distinct from WDDM process dedicated usage. Occlusion off phases are diagnostic only.'};
let context, page, owner;

function observe() {
  const state = globalThis.__villaPerformance = {measuring: false, cpu: [], intervals: [], counts: {},
    errors: [], textures: [], buffers: {created: 0, bytes: 0}, passes: [], logCount: 0, frameDraws: {}, trace: []};
  let frame = 0, presented, previous, device, query, resolveBuffer, readback, capture;
  const ticks = [];
  Object.defineProperty(ticks, 'push', {value: function(value) {
    if (state.measuring) (state.gameCPU ||= []).push(value);
    return Array.prototype.push.call(this, value);
  }});
  globalThis.__webThreadFrameTimes = ticks;
  const views = new WeakMap(), passInfo = new WeakMap();
  const count = name => { if (state.measuring) state.counts[name] = (state.counts[name] || 0) + 1; };
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = callback => raf(time => {
    const start = performance.now(), before = frame;
    try { return callback(time); }
    finally {
      if (state.measuring && frame > before) {
        const end = performance.now();
        state.cpu.push(end - start);
        if (previous !== undefined) state.intervals.push(end - previous);
        previous = end;
      }
    }
  });
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
    const features = [...(descriptor.requiredFeatures || [])];
    if (this.features.has('timestamp-query') && !features.includes('timestamp-query')) features.push('timestamp-query');
    device = await requestDevice.call(this, {...descriptor, requiredFeatures: features});
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => { if (info.reason !== 'destroyed') state.errors.push(info.message); });
    if (device.features.has('timestamp-query')) {
      query = device.createQuerySet({type: 'timestamp', count: 2048});
      resolveBuffer = device.createBuffer({size: 16384, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      readback = device.createBuffer({size: 16384, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    }
    return device;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const view = createView.apply(this, args);
    views.set(view, {label: this.label, width: this.width, height: this.height, format: this.format});
    return view;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    count('createTexture');
    state.textures.push({label: descriptor.label, size: descriptor.size, format: descriptor.format,
      mips: descriptor.mipLevelCount || 1, dimension: descriptor.dimension || '2d'});
    return texture;
  };
  for (const [prototype, names] of [
    [GPUDevice.prototype, ['createBuffer', 'createBindGroup', 'createBindGroupLayout', 'createRenderPipeline', 'createComputePipeline']],
    [GPUQueue.prototype, ['submit', 'writeBuffer', 'writeTexture']],
    [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed', 'setBindGroup', 'beginOcclusionQuery']]
  ]) for (const name of names) {
    const original = prototype[name];
    prototype[name] = function(...args) {
      count(name);
      if (name === 'createBuffer') { ++state.buffers.created; state.buffers.bytes += Number(args[0].size); }
      if (name === 'draw' || name === 'drawIndexed') {
        const info = passInfo.get(this);
        if (info?.label === 'SceneColor')
          state.frameDraws.SceneColor = (state.frameDraws.SceneColor || 0) + 1;
        if (info && state.measuring) {
          const key = info.label || 'unknown';
          state.draws[key] = (state.draws[key] || 0) + 1;
          const vertices = name === 'draw' ? args[0] : args[0];
          state.vertices += vertices * (args[1] || 1);
          state.passVertices[key] = (state.passVertices[key] || 0) + vertices * (args[1] || 1);
          if (name === 'drawIndexed' && key === 'SceneColor')
            state.indexCounts[args[0]] = (state.indexCounts[args[0]] || 0) + (args[1] || 1);
        }
      }
      return original.apply(this, args);
    };
  }
  for (const name of ['beginRenderPass', 'beginComputePass']) {
    const original = GPUCommandEncoder.prototype[name];
    GPUCommandEncoder.prototype[name] = function(descriptor = {}) {
      const attachment = descriptor.colorAttachments?.find(value => value)?.view || descriptor.depthStencilAttachment?.view;
      const info = views.get(attachment) || {label: name === 'beginComputePass' ? 'compute' : 'unlabelled'};
      if (capture && capture.entries.length < 1024) {
        const index = capture.entries.length * 2;
        capture.entries.push(info);
        descriptor = {...descriptor, timestampWrites: {querySet: query,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}};
      }
      const pass = original.call(this, descriptor);
      passInfo.set(pass, info);
      return pass;
    };
  }
  function finishFrame() {
      state.trace.push({frame, draws: state.frameDraws, camera: globalThis.__webDefaultCamera});
      if (state.trace.length > 120) state.trace.shift();
      state.frameDraws = {};
      if (!capture) return;
      const completed = capture;
      capture = null;
      const count = completed.entries.length * 2, encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(query, 0, count, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readback, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const times = new BigUint64Array(readback.getMappedRange());
        const entries = completed.entries.map((entry, index) => ({...entry,
          milliseconds: Number(times[index * 2 + 1] - times[index * 2]) / 1e6}));
        readback.unmap();
        completed.resolve(entries);
      }, completed.reject);
  }
  Object.defineProperty(globalThis, '__webEngineFrames', {configurable: true, enumerable: true,
    get: () => frame, set(value) {
      frame = value;
      if (!globalThis.__webEngineThreads?.rhiThread) finishFrame();
    }});
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => presented, set(value) {
      const changed = value > (presented || 0);
      presented = value;
      if (changed) finishFrame();
    }});
  globalThis.__villaSample = async milliseconds => {
    await device.queue.onSubmittedWorkDone();
    state.cpu = []; state.gameCPU = []; state.intervals = []; state.counts = {}; state.draws = {}; state.vertices = 0; state.passVertices = {}; state.indexCounts = {};
    previous = undefined; state.measuring = true;
    const first = frame, firstPresent = presented, firstRhiWork = globalThis.__webThreadStages?.rhiWorkMilliseconds,
      firstResourceProxies = globalThis.__webThreadStages?.resourceProxyCalls,
      start = performance.now();
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    state.measuring = false;
    return {elapsedMs: performance.now() - start, frames: firstPresent === undefined ? frame - first : presented - firstPresent,
      gameFrames: frame - first, frameSource: firstPresent === undefined ? 'engine-loop' : 'rhi-present',
      cpuSource: state.cpu.length ? 'engine-worker-callback' : 'game-thread-tick-including-waits',
      cpu: state.cpu.length ? state.cpu : state.gameCPU,
      rhiWorkMilliseconds: firstRhiWork === undefined ? undefined : globalThis.__webThreadStages.rhiWorkMilliseconds - firstRhiWork,
      resourceProxyCalls: firstResourceProxies === undefined ? undefined : globalThis.__webThreadStages.resourceProxyCalls - firstResourceProxies,
      intervals: state.intervals, counts: state.counts, draws: state.draws, vertices: state.vertices,
      passVertices: state.passVertices, indexCounts: state.indexCounts};
  };
  globalThis.__villaGPU = () => query ?
    new Promise((resolve, reject) => { capture = {entries: [], resolve, reject}; }) : Promise.resolve([]);
}
function memory() {
  const command = '$taskProcesses=Get-CimInstance Win32_Process; ' +
    '$taskRoot=@($taskProcesses | Where-Object {$_.CommandLine -like "*' +
    profile.replaceAll('\\', '/') + '*" -or $_.CommandLine -like "*' + profile + '*"}).ProcessId; ' +
    '$taskIds=@($taskRoot); for($i=0;$i -lt 4;$i++){$taskIds+=@($taskProcesses | Where-Object {$taskIds -contains $_.ParentProcessId}).ProcessId}; ' +
    'Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | ForEach-Object {' +
    '$taskId=[int]([regex]::Match($_.Name,"^pid_(\\d+)_").Groups[1].Value); ' +
    'if($taskIds -contains $taskId){[pscustomobject]@{pid=$taskId;dedicated=$_.DedicatedUsage;shared=$_.SharedUsage;committed=$_.TotalCommitted}}} | ConvertTo-Json -Compress';
  const text = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {encoding: 'utf8', windowsHide: true}).trim();
  return text ? JSON.parse(text) : [];
}
const state = () => owner.evaluate(() => ({frame: __webEngineFrames,
  threads: globalThis.__webEngineThreads, threadStages: globalThis.__webThreadStages,
  view: globalThis.__webRenderView, camera: globalThis.__webDefaultCamera, streaming: globalThis.__webTextureStreaming,
  occlusion: globalThis.__webOcclusionRHI, io: globalThis.__webContentIO?.stats,
  lighting: globalThis.__webDistanceFieldsLighting, runtime: globalThis.__webEngineRuntime,
  errors: __villaPerformance.errors}));
async function settle(count = 60) {
  const before = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure || (globalThis.__webEngineFrames || 0) >= target,
    before + count, {timeout: 240000});
  const failure = await page.evaluate(() => globalThis.__webEngineFailure);
  assert(!failure, JSON.stringify(failure));
}
async function measure(label, view, occlusion = 1) {
  if (visibilityOnly || phases && !phases.includes(label)) return;
  assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), view), 1);
  if (!projectSettings)
    assert.equal(await page.evaluate(value => __webEngineRPC('WebOcclusionTestMode', value, 2), occlusion), 1);
  await settle(80);
  const before = await state();
  const sample = await owner.evaluate(ms => __villaSample(ms), seconds * 1000);
  const gpu = [];
  for (let index = 0; index < 3; ++index) gpu.push(await owner.evaluate(() => __villaGPU()));
  const phase = {label, view, occlusion, before, after: await state(), sample, gpu, memory: memory(),
    fps: sample.frames / sample.elapsedMs * 1000,
    cpuMs: sample.cpu.reduce((a, b) => a + b, 0) / sample.cpu.length,
    rhiWorkerMs: sample.rhiWorkMilliseconds === undefined ? undefined : sample.rhiWorkMilliseconds / sample.frames,
    resourceProxiesPerFrame: sample.resourceProxyCalls === undefined ? undefined : sample.resourceProxyCalls / sample.frames,
    perFrame: Object.fromEntries(Object.entries(sample.counts).map(([key, value]) => [key, value / sample.frames])),
    drawsPerFrame: Object.fromEntries(Object.entries(sample.draws).map(([key, value]) => [key, value / sample.frames]))};
  report.phases.push(phase);
  await page.locator('canvas').screenshot({path: path.join(directory, `villa-performance-${tag}-${label}.png`), timeout: 30000});
  fs.writeFileSync(path.join(directory, `villa-performance-${tag}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({label, fps: phase.fps, cpuMs: phase.cpuMs, rhiWorkerMs: phase.rhiWorkerMs,
    resourceProxiesPerFrame: phase.resourceProxiesPerFrame, perFrame: phase.perFrame,
    gpuMs: gpu.map(entries => entries.reduce((sum, entry) => sum + entry.milliseconds, 0)), memory: phase.memory}));
}
(async () => {
  try {
    context = await chromium.launchPersistentContext(profile, {channel, headless: true,
      viewport: {width, height}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
    });
    page = context.pages()[0];
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const text = message.text();
      if (text.includes('WEB_SHADOW_CACHE')) (report.shadowCacheDecisions ||= []).push(text);
      ++report.logCount;
      if (report.logs.length >= 40) report.logs.shift();
      report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) report.errors.push(text);
    });
    report.logCount = 0;
    const start = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    const stageTimer = setInterval(async () => {
      try {
        const value = await page.evaluate(() => ({stage: __webStartupDiagnostics.stage,
          content: __webStartupDiagnostics.localContent, mount: __webStartupDiagnostics.content, frames: globalThis.__webEngineFrames || 0}));
        report.stages.push({elapsedMs: Date.now() - start, ...value});
      } catch {}
    }, 1000);
    try { await settle(30); } finally { clearInterval(stageTimer); }
    report.startupMs = Date.now() - start;
    owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    report.initial = await state();
    if (loaderOnly) {
      await owner.evaluate(() => __villaSample(0));
      report.initial = await state();
      assert(!report.errors.length && !report.initial.errors.length, 'Startup reported GPU or page errors');
      const image = await page.locator('canvas').screenshot();
      fs.writeFileSync(path.join(directory, `villa-performance-${tag}-startup.png`), image);
      const png = PNG.sync.read(image), colors = new Set();
      let nonBlack = 0;
      for (let index = 0; index < png.data.length; index += 4) {
        const [r, g, b] = png.data.subarray(index, index + 3);
        colors.add((r << 16) | (g << 8) | b);
        if (r + g + b > 30) ++nonBlack;
      }
      report.pixels = {colors: colors.size, nonBlackFraction: nonBlack / (png.width * png.height)};
      assert(colors.size > 256 && report.pixels.nonBlackFraction > 0.25, 'Expected a rendered scene');
      report.pass = true;
      return;
    }
    if (projectSettings) report.settingsOverrides = [];
    if (!projectSettings) assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', -1, 0)), 1);
    if (option('shadow-cache-mb'))
      assert.equal(await page.evaluate(value => __webEngineRPC('WebLightingQualityTest', 12, value),
        Number(option('shadow-cache-mb'))), 1);
    if (process.argv.includes('--shadow-cache-check'))
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 11, 64)), 1);
    console.log(JSON.stringify({startupMs: report.startupMs, initial: report.initial}));
    const room = [-175, -80, 160, -5, 50], wall = [-175, -80, 160, -5, 230];
    assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), room), 1);
    await settle(Number(option('warmup') || 240));
    await measure('room-on', room);
    await measure('wall-on', wall);
    await measure('wall-off', wall, 0);
    await measure('room-off', room, 0);
    await measure('room-restored', room);
    if (process.argv.includes('--shadow-cache-check')) {
      const mode = value => page.evaluate(value => __webEngineRPC('WebLightingQualityTest', 10, value), value);
      assert.equal(await mode(0), 1);
      await measure('room-cache-off', room);
      assert.equal(await mode(1), 1);
      await measure('room-cache-restored', room);
      const off = report.phases.find(value => value.label === 'room-cache-off');
      const on = report.phases.find(value => value.label === 'room-cache-restored');
      assert(off && on && off.drawsPerFrame.WebCubeShadowFace > (on.drawsPerFrame.WebCubeShadowFace || 0) * 1.5,
        'Static shadow cache must reduce six-face draws');
      const a = PNG.sync.read(fs.readFileSync(path.join(directory, `villa-performance-${tag}-room-cache-off.png`)));
      const b = PNG.sync.read(fs.readFileSync(path.join(directory, `villa-performance-${tag}-room-cache-restored.png`)));
      let difference = 0;
      for (let index = 0; index < a.data.length; ++index)
        if (index % 4 !== 3) difference += Math.abs(a.data[index] - b.data[index]);
      report.shadowCachePixelDifference = difference / (a.width * a.height * 3);
      assert(report.shadowCachePixelDifference < 3, 'Cached and uncached shadows must preserve the scene image');
    }
    if (checkVisibility || visibilityOnly) {
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), wall), 1);
      await settle(40);
      await owner.evaluate(() => { __villaPerformance.trace = []; });
      const turn = [...wall]; turn[4] -= 5;
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), turn), 1);
      await settle(16);
      report.turnRecovery = await owner.evaluate(yaw => __villaPerformance.trace.filter(value =>
        value.camera && Math.abs((value.camera.yaw + 360) % 360 - yaw) < 0.1), turn[4]);
      const first = report.turnRecovery[0]?.draws.SceneColor || 0;
      const last = report.turnRecovery.at(-1)?.draws.SceneColor || 0;
      assert(first > 0 && first >= last * 0.9, 'First turned frame must conservatively include visible geometry');
      const rpc = (parameter, value) => page.evaluate(([parameter, value]) =>
        __webEngineRPC('WebVisibilityTest', parameter, value), [parameter, value]);
      assert.equal(await rpc(0, 0), 1);
      report.visibility = await owner.evaluate(() => __webVisibilityAudit);
      assert.equal(report.visibility.components, 2240);
      assert.equal(report.visibility.meshes.length, 590);
      assert.equal(report.visibility.meshes.filter(mesh => mesh.lods.length > 1).length, 16);
      assert.equal(await rpc(3, 1), 1);
      const isolated = await owner.evaluate(() => __webVisibilityAudit.isolated);
      assert(isolated && isolated.radius > 0);
      const center = isolated.center;
      const testView = [center[0] - Math.max(100, isolated.radius * 4), center[1], center[2], 0, 0];
      report.visibility.isolated = isolated;
      report.visibility.checks = [];
      const test = async (label, lod, cull, distance = Math.max(100, isolated.radius * 4)) => {
        assert.equal(await rpc(1, lod), 1);
        assert.equal(await rpc(4, cull), 1);
        const view = [...testView];
        view[0] = center[0] - distance;
        assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), view), 1);
        await settle(40);
        const sample = await owner.evaluate(() => __villaSample(2000));
        const value = {label, frames: sample.frames, verticesPerFrame: sample.vertices / sample.frames,
          indicesPerFrame: Object.fromEntries(Object.entries(sample.indexCounts).map(([key, count]) => [key, count / sample.frames])),
          passVertices: Object.fromEntries(Object.entries(sample.passVertices).map(([key, count]) => [key, count / sample.frames])),
          draws: Object.fromEntries(Object.entries(sample.draws).map(([key, count]) => [key, count / sample.frames]))};
        report.visibility.checks.push(value);
        console.log(JSON.stringify(value));
        return value;
      };
      const fine = await test('isolated-lod0', 0, 0);
      const coarse = await test('isolated-lod2', 2, 0);
      assert(fine.indicesPerFrame[31614] >= 0.9 && coarse.indicesPerFrame[4743] >= 0.9 &&
        !coarse.indicesPerFrame[31614], 'Forced LOD must submit the matching mesh index count');
      const near = await test('isolated-auto-near', -1, 0, isolated.radius * 2);
      const far = await test('isolated-auto-far', -1, 0, isolated.radius * 30);
      assert(near.indicesPerFrame[31614] >= 0.9 && far.indicesPerFrame[4743] >= 0.9 &&
        !far.indicesPerFrame[31614], 'Automatic LOD must submit the coarse mesh at distance');
      const culled = await test('isolated-distance', -1, 1);
      assert((culled.draws.SceneColor || 0) < (fine.draws.SceneColor || 0), 'Distance culling must remove the base-pass draw');
      // This isolated browser closes below; scene restoration is a separate transition, not an LOD assertion.
    }
    report.textures = await owner.evaluate(() => __villaPerformance.textures);
    report.buffers = await owner.evaluate(() => __villaPerformance.buffers);
    assert(!report.errors.length && !report.phases.some(phase => phase.after.errors.length));
    report.pass = true;
  } catch (error) { report.failure = error.stack || String(error); }
  finally {
    await context?.close();
    const file = path.join(directory, `villa-performance-${tag}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
