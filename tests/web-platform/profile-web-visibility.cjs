const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const suffix = process.argv.find(value => value.startsWith('--report='))?.slice(9) || 'visibility-before';
const occlusion = process.argv.includes('--occlusion');
const cpuProfile = !process.argv.includes('--no-cpu-profile');
const warmupFrames = Number(process.argv.find(value => value.startsWith('--warmup-frames='))?.slice(16) || 600);
const bufferedFrames = Number(process.argv.find(value => value.startsWith('--buffered-frames='))?.slice(18) || 0);
const browserName = process.argv.find(value => value.startsWith('--browser='))?.slice(10) || 'Chrome';
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
assert(/^[a-z0-9-]+$/.test(suffix));
assert(Number.isInteger(bufferedFrames) && bufferedFrames >= 0 && bufferedFrames <= 4);
assert(Number.isInteger(warmupFrames) && warmupFrames >= 60);
const report = {date: new Date().toISOString(), pass: false, browser: browserName, occlusion, cpuProfile, bufferedFrames,
  warmupFrames,
  fixedClock: process.argv.includes('--fixed-clock'),
  source: audit(__filename), phases: [], errors: []};
let browser;
function instrument({cpuTiming}) {
  const state = globalThis.__visibilityCost = {counts: {}, cpu: {}, times: [], callbacks: [], errors: [], losses: [],
    occlusionSamples: 0, occluded: 0, visible: 0};
  let device, query, resolve, readback, capture;
  const passRecords = new WeakMap();
  const queryTypes = new WeakMap(), occlusionBuffers = new WeakSet();
  const createQueries = GPUDevice.prototype.createQuerySet;
  GPUDevice.prototype.createQuerySet = function(desc) {
    const result = createQueries.call(this, desc);
    queryTypes.set(result, desc.type);
    return result;
  };
  const resolveQueries = GPUCommandEncoder.prototype.resolveQuerySet;
  GPUCommandEncoder.prototype.resolveQuerySet = function(set, start, count, buffer, offset) {
    if (queryTypes.get(set) === 'occlusion') occlusionBuffers.add(buffer);
    return resolveQueries.call(this, set, start, count, buffer, offset);
  };
  const copy = GPUCommandEncoder.prototype.copyBufferToBuffer;
  GPUCommandEncoder.prototype.copyBufferToBuffer = function(source, offset, target, ...args) {
    if (occlusionBuffers.has(source)) occlusionBuffers.add(target);
    return copy.call(this, source, offset, target, ...args);
  };
  const mapped = GPUBuffer.prototype.getMappedRange;
  GPUBuffer.prototype.getMappedRange = function(...args) {
    const result = mapped.apply(this, args);
    if (state.measuring && occlusionBuffers.has(this)) {
      for (const value of new BigUint64Array(result)) {
        ++state.occlusionSamples;
        if (value === 0n) ++state.occluded; else ++state.visible;
      }
    }
    return result;
  };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(desc = {}) {
    const features = [...(desc.requiredFeatures || []), 'timestamp-query'];
    device = await request.call(this, {...desc, requiredFeatures: [...new Set(features)]});
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(value => { if (value.reason !== 'destroyed') state.losses.push(value); });
    query = device.createQuerySet({type: 'timestamp', count: 512});
    resolve = device.createBuffer({size: 4096, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
    readback = device.createBuffer({size: 4096, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    return device;
  };
  const raf = requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => raf.call(globalThis, time => {
    const start = performance.now();
    callback(time);
    if (state.measuring) { state.times.push(time); state.callbacks.push(performance.now() - start); }
    if (capture && capture.passes.length) {
      const current = capture; capture = null;
      const encoder = device.createCommandEncoder(), count = current.passes.length * 2;
      encoder.resolveQuerySet(query, 0, count, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const values = new BigUint64Array(readback.getMappedRange());
        const passes = current.passes.map((pass, index) => ({...pass,
          ms: Number(values[index * 2 + 1] - values[index * 2]) / 1e6}));
        readback.unmap();
        current.done(passes);
      }, current.reject);
    }
  });
  for (const name of ['beginRenderPass', 'beginComputePass']) {
    const begin = GPUCommandEncoder.prototype[name];
    GPUCommandEncoder.prototype[name] = function(desc = {}) {
      let item;
      if (capture) {
        const index = capture.passes.length * 2;
        if (desc.timestampWrites || index >= 512) throw new Error('Timestamp instrumentation conflict');
        item = {label: desc.label || name, draws: 0};
        capture.passes.push(item);
        desc = {...desc, timestampWrites: {querySet: query,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}};
      }
      const pass = begin.call(this, desc);
      if (item) passRecords.set(pass, item);
      return pass;
    };
  }
  for (const [prototype, names] of [
    [GPUDevice.prototype, ['createBindGroup', 'createBindGroupLayout', 'createBuffer', 'createRenderPipeline']],
    [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed', 'setBindGroup', 'beginOcclusionQuery']],
    [GPUQueue.prototype, ['submit', 'writeBuffer', 'writeTexture']]
  ]) for (const name of names) {
    const method = prototype[name], key = prototype.constructor.name + '.' + name;
    prototype[name] = function(...args) {
      const start = cpuTiming ? performance.now() : 0, result = method.apply(this, args);
      if (state.measuring) {
        state.counts[key] = (state.counts[key] || 0) + 1;
        if (cpuTiming) state.cpu[key] = (state.cpu[key] || 0) + performance.now() - start;
      }
      if (name === 'draw' || name === 'drawIndexed') {
        const item = passRecords.get(this);
        if (item) ++item.draws;
      }
      return result;
    };
  }
  globalThis.__visibilityGpuFrame = () => new Promise((done, reject) => { capture = {passes: [], done, reject}; });
}
(async () => {
  try {
    report.package = audit(path.join(directory, 'web-project-triplex-house-villa-package-results.json'));
    assert(['Chrome', 'Edge'].includes(browserName));
    browser = await chromium.launch({headless: true,
      executablePath: browserName === 'Chrome' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' :
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage({viewport: {width: 1280, height: 720}});
    page.on('pageerror', error => report.errors.push(error.stack));
    await page.addInitScript(instrument, {cpuTiming: cpuProfile});
    if (process.argv.includes('--fixed-clock')) await page.route('**/build/triplex-house-villa/index.html', async route => {
      const response = await route.fetch(), html = await response.text();
      const args = "arguments: ['-webgpu', '-WebProjectMap=/Game/BigTriplexHouseVilla/Maps/BigTriplexHouseVilla'],";
      assert(html.includes(args));
      await route.fulfill({response, body: html.replace(args, args.replace('],', ", '-WebVisualTestClock'],"))});
    });
    await page.goto('http://127.0.0.1:8765/build/triplex-house-villa/index.html', {waitUntil: 'commit'});
    await page.waitForFunction(frames => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= frames,
      warmupFrames, {timeout: 180000});
    const client = cpuProfile ? await page.context().newCDPSession(page) : null;
    if (client) await client.send('Profiler.enable');
    const phases = occlusion ? [
      ['room-off', 50, 1280, 720, 0], ['room-on', 50, 1280, 720, 1],
      ['wall-on', 230, 1280, 720, 1], ['wall-off', 230, 1280, 720, 0],
      ['room-on-repeat', 50, 1280, 720, 1], ['room-off-repeat', 50, 1280, 720, 0]
    ] : [
      ['room', 50, 1280, 720], ['wall', 230, 1280, 720], ['room-half', 50, 640, 360],
      ['room-repeat', 50, 1280, 720]
    ];
    for (const [label, yaw, width, height, enabled] of phases) {
      await page.setViewportSize({width, height});
      if (occlusion) assert(await page.evaluate(([value, frames]) =>
        Module._WebOcclusionTestMode(value, frames), [enabled, bufferedFrames]));
      assert(await page.evaluate(yaw => Module._WebProjectViewTest(-175, -80, 160, -5, yaw), yaw));
      const start = await page.evaluate(() => __webEngineFrames);
      await page.waitForFunction(frame => globalThis.__webEngineFailure || __webEngineFrames >= frame + 180, start, {timeout: 120000});
      if (cpuProfile) await client.send('Profiler.start');
      const sample = await page.evaluate(async () => {
        const state = __visibilityCost;
        state.counts = {}; state.cpu = {}; state.times = []; state.callbacks = [];
        state.occlusionSamples = 0; state.occluded = 0; state.visible = 0;
        const first = __webEngineFrames, start = performance.now();
        const firstOcclusionRHI = {...globalThis.__webOcclusionRHI};
        state.measuring = true;
        await new Promise(done => setTimeout(done, 4000));
        state.measuring = false;
        return {elapsed: performance.now() - start, frames: __webEngineFrames - first, ...state,
          streaming: globalThis.__webTextureStreaming, camera: globalThis.__webDefaultCamera,
          occlusionRHI: globalThis.__webOcclusionRHI,
          firstOcclusionRHI,
          failure: globalThis.__webEngineFailure || null};
      });
      const profile = cpuProfile ? (await client.send('Profiler.stop')).profile : null;
      const file = path.join(directory, `${suffix}-${label}.cpuprofile`);
      if (profile) fs.writeFileSync(file, JSON.stringify(profile));
      const weights = new Map(), nodes = new Map(profile?.nodes.map(node => [node.id, node.callFrame]));
      for (let index = 0; index < (profile?.samples.length || 0); ++index) {
        const id = profile.samples[index];
        weights.set(id, (weights.get(id) || 0) + profile.timeDeltas[index]);
      }
      const top = [...weights].map(([id, value]) => ({...nodes.get(id), ms: value / 1000}))
        .sort((a, b) => b.ms - a.ms).slice(0, 30);
      const gpu = [];
      for (let frame = 0; frame < 4; ++frame) gpu.push(await page.evaluate(() => __visibilityGpuFrame()));
      const screenshot = path.join(directory, `${suffix}-${label}.png`);
      await page.locator('canvas').screenshot({path: screenshot});
      const phase = {label, enabled, sample, top, profile: profile ? audit(file) : null, gpu, screenshot: audit(screenshot),
        fps: sample.frames * 1000 / sample.elapsed,
        callbackMs: sample.callbacks.reduce((sum, value) => sum + value, 0) / sample.callbacks.length,
        callsPerFrame: Object.fromEntries(Object.entries(sample.counts).map(([key, value]) => [key, value / sample.frames]))};
      report.phases.push(phase);
      assert(!sample.failure && !sample.errors.length && !sample.losses.length && !report.errors.length);
      if (occlusion && enabled) assert(sample.occlusionSamples > 0 && sample.occluded > 0 && sample.visible > 0);
      if (occlusion && !enabled) assert(!sample.counts['GPURenderPassEncoder.beginOcclusionQuery']);
      console.log(JSON.stringify({label, fps: phase.fps, callback: phase.callbackMs, calls: phase.callsPerFrame,
        occlusionRHI: sample.occlusionRHI,
        gpuMs: gpu.map(passes => passes.reduce((sum, pass) => sum + pass.ms, 0))}));
    }
    if (occlusion) {
      const image = label => PNG.sync.read(fs.readFileSync(
        report.phases.find(phase => phase.label === label).screenshot.file));
      const difference = (a, b) => {
        assert.equal(a.width, b.width); assert.equal(a.height, b.height);
        let sum = 0, changed = 0;
        for (let pixel = 0; pixel < a.width * a.height; ++pixel) {
          let maximum = 0;
          for (let channel = 0; channel < 3; ++channel) {
            const delta = Math.abs(a.data[pixel * 4 + channel] - b.data[pixel * 4 + channel]);
            sum += delta * delta; maximum = Math.max(maximum, delta);
          }
          changed += maximum > 20;
        }
        return {rms: Math.sqrt(sum / (a.width * a.height * 3)), changedFraction: changed / (a.width * a.height)};
      };
      report.visual = {
        room: difference(image('room-off'), image('room-on')),
        roomRepeat: difference(image('room-off-repeat'), image('room-on-repeat')),
        wall: difference(image('wall-off'), image('wall-on')),
        timeDrift: difference(image('room-off'), image('room-off-repeat'))
      };
      for (const value of [report.visual.room, report.visual.roomRepeat, report.visual.wall])
        assert(value.rms < 3 && value.changedFraction < 0.01, 'Occlusion changed the visible scene');
    }
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    await browser?.close();
    fs.writeFileSync(path.join(directory, `${suffix}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure}));
  }
})();
