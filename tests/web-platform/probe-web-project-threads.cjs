const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const smoke = process.argv.includes('--smoke');
const seconds = Number(option('seconds') || 4);
const heights = (option('resolutions') || '1080,2160').split(',').map(Number);
assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && seconds >= 2 && seconds <= 15);
assert(heights.length && heights.every(height => [720, 1080, 2160].includes(height)));
assert(!option('browser') || ['Chrome', 'Edge'].includes(option('browser')));
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const distribution = values => {
  assert(values.length);
  const sorted = [...values].sort((a, b) => a - b);
  return {count: sorted.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor((sorted.length - 1) * 0.95)]};
};
const report = {date: new Date().toISOString(), pass: false, id, smoke, seconds, heights,
  source: audit(__filename), runs: [], comparisons: [], headless: true,
  boundary: 'Same Cook, config, source revision, camera, output and internal pixel size; normal game time. ' +
    'Scene resolution follows its packaged profile; actual internal and output sizes are recorded separately. ' +
    'RAF CPU callback time includes WASM and JS submission, not separate Game/Draw CPU timers. ' +
    'GPU pass sums omit copies and gaps; headless frame rates are local observations, not display FPS. ' +
    'Game and Render/RHI are not separated in this candidate.'};
let context;
const renderSettings = view => ({width: view.width, height: view.height,
  outputWidth: view.outputWidth, outputHeight: view.outputHeight, antiAliasing: view.antiAliasing});

function observe() {
  const state = globalThis.__threadBenchmark = {cpu: [], intervals: [], ui: [], measuring: false,
    errors: [], losses: [], adapter: null};
  let device, query, resolveBuffer, readback, capture, frame = 0, previousFrame;
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = callback => raf(time => {
    const before = frame, start = performance.now();
    try { return callback(time); }
    finally {
      if (state.measuring && frame > before) {
        const end = performance.now();
        state.cpu.push(end - start);
        if (previousFrame !== undefined) state.intervals.push(end - previousFrame);
        previousFrame = end;
      }
    }
  });
  if (typeof document !== 'undefined') {
    let previous = performance.now();
    setInterval(() => {
      const now = performance.now();
      if (state.uiMeasuring) state.ui.push(now - previous);
      previous = now;
    }, 10);
  }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
    state.adapter = Object.fromEntries(['vendor', 'architecture', 'device', 'description'].map(key =>
      [key, this.info?.[key] || '']));
    state.timestampSupported = this.features.has('timestamp-query');
    const requiredFeatures = [...(descriptor.requiredFeatures || [])];
    if (state.timestampSupported && !requiredFeatures.includes('timestamp-query'))
      requiredFeatures.push('timestamp-query');
    device = await requestDevice.call(this, {...descriptor, requiredFeatures});
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.losses.push({reason: info.reason, message: info.message});
    });
    if (state.timestampSupported) {
      query = device.createQuerySet({type: 'timestamp', count: 512});
      resolveBuffer = device.createBuffer({size: 4096,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      readback = device.createBuffer({size: 4096,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    }
    return device;
  };
  for (const name of ['beginRenderPass', 'beginComputePass']) {
    const begin = GPUCommandEncoder.prototype[name];
    GPUCommandEncoder.prototype[name] = function(descriptor = {}) {
      if (capture) {
        if (descriptor.timestampWrites || capture.passes >= 256)
          throw new Error('GPU timestamp capture capacity exceeded');
        const index = capture.passes++ * 2;
        descriptor = {...descriptor, timestampWrites: {querySet: query,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}};
      }
      return begin.call(this, descriptor);
    };
  }
  Object.defineProperty(globalThis, '__webEngineFrames', {configurable: true, enumerable: true,
    get: () => frame,
    set(value) {
      frame = value;
      if (!capture) return;
      const completed = capture;
      capture = null;
      if (!completed.passes) { completed.reject(new Error('No GPU passes captured')); return; }
      const count = completed.passes * 2, encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(query, 0, count, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readback, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const timestamps = new BigUint64Array(readback.getMappedRange());
        let passMilliseconds = 0;
        for (let index = 0; index < count; index += 2)
          passMilliseconds += Number(timestamps[index + 1] - timestamps[index]) / 1e6;
        readback.unmap();
        completed.resolve({frame, passes: completed.passes, passMilliseconds});
      }, completed.reject);
    }
  });
  globalThis.__threadBenchmarkGPU = () => {
    if (!query) return Promise.resolve(null);
    if (capture) throw new Error('Overlapping GPU sample');
    return new Promise((resolve, reject) => { capture = {passes: 0, resolve, reject}; });
  };
  globalThis.__threadBenchmarkSample = async milliseconds => {
    await device.queue.onSubmittedWorkDone();
    previousFrame = undefined;
    state.cpu = []; state.intervals = []; state.measuring = true;
    const first = frame, start = performance.now();
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    state.measuring = false;
    return {elapsed: performance.now() - start, frames: frame - first,
      cpu: state.cpu, intervals: state.intervals};
  };
}

async function advance(page, count) {
  const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= target, first + count, {timeout: 240000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
}
async function screenshot(page, label) {
  const file = path.join(directory, `web-project-${id}-threads-${label}.png`);
  const session = await context.newCDPSession(page);
  try {
    const box = await page.locator('canvas').boundingBox();
    const {data} = await session.send('Page.captureScreenshot', {format: 'png', fromSurface: true,
      captureBeyondViewport: false, clip: {...box, scale: 1}});
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  } finally { await session.detach(); }
  const png = PNG.sync.read(fs.readFileSync(file));
  let visible = 0;
  const colors = new Set();
  for (let offset = 0; offset < png.data.length; offset += 4) {
    if (png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 24) ++visible;
    colors.add(png.data.readUInt32LE(offset));
  }
  assert(visible / (png.width * png.height) > 0.5 && colors.size > 1000, 'Villa must be visibly rendered');
  return {...audit(file), width: png.width, height: png.height, visibleFraction: visible / (png.width * png.height)};
}
async function scene(owner) {
  return owner.evaluate(() => ({
    frame: __webEngineFrames, camera: globalThis.__webDefaultCamera,
    ready: globalThis.__webEngineThreads, surface: {width: Module.canvas.width, height: Module.canvas.height},
    view: globalThis.__webRenderView, streaming: globalThis.__webTextureStreaming,
    heapBytes: HEAPU8.buffer.byteLength, shared: HEAPU8.buffer instanceof SharedArrayBuffer,
    local: globalThis.__webContentIO?.stats, bulkFiles: globalThis.__webContentIO?.files.size,
    gpu: {errors: __threadBenchmark.errors, losses: __threadBenchmark.losses,
      adapter: __threadBenchmark.adapter}
  }));
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 90000);
    })]);
  } finally { clearTimeout(timer); }
}

(async () => {
  try {
    const packages = {};
    report.packages = {};
    for (const threaded of smoke ? [true] : [false, true]) {
      const key = threaded ? 'threads' : 'single';
      const file = path.join(directory, `web-project-${id}${threaded ? '-threads' : '-desktop'}-package-results.json`);
      const packaged = packages[key] = read(file);
      assert(packaged.pass && packaged.renderer === 'desktop-deferred' &&
        packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
        valid(packaged.buildReport) && valid(packaged.stageReport));
      report.packages[key] = audit(file);
    }
    if (!smoke) {
      for (const name of ['content.bin', 'content-files.json', 'config-files.json']) {
        const products = Object.values(packages).map(item =>
          item.products.find(product => path.basename(product.file) === name));
        assert.equal(products[0].sha256, products[1].sha256, 'A/B resources must match: ' + name);
      }
      const single = read(packages.single.buildReport.file), threaded = read(packages.threads.buildReport.file);
      assert(single.sourceFiles.every(valid) && threaded.sourceFiles.every(valid));
      const shared = single.sourceFiles.filter(item => threaded.sourceFiles.some(other => other.file === item.file));
      assert(shared.length > 50, 'Both builds must audit common engine sources');
      assert(shared.every(item => threaded.sourceFiles.find(other => other.file === item.file).sha256 === item.sha256));
      report.commonBuildSources = shared.length;
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      if (option('browser') && option('browser') !== name) continue;
      const profile = fs.mkdtempSync(path.join(directory, 'villa-threads-' + name.toLowerCase() + '-'));
      context = await chromium.launchPersistentContext(profile, {executablePath, headless: true,
        viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
      await context.addInitScript(observe);
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
      });
      for (const [index, threaded] of (smoke ? [true] : [false, true, true, false]).entries()) {
        const run = {browser: name, version: context.browser().version(), index, threaded,
          pass: false, errors: [], log: [], measurements: []};
        report.runs.push(run);
        const page = await context.newPage();
        page.on('pageerror', error => run.errors.push(error.message));
        page.on('console', message => {
          const text = message.text();
          run.log.push(text);
          if (run.log.length > 50) run.log.shift();
          if (/Assertion failed|Fatal error:|GPU validation:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(text))
            run.errors.push(text);
        });
        const buildName = id + (threaded ? '-threads' : '-desktop');
        await page.goto(`http://127.0.0.1:8765/build/${buildName}/index.html`, {waitUntil: 'commit'});
        await advance(page, smoke ? 60 : 120);
        const owner = threaded ? page.workers().find(worker => worker.url().includes('/web-engine-worker.js')) : page;
        assert(owner, 'The engine owner must be observable');
        run.startup = await scene(owner);
        const ready = await page.evaluate(() => globalThis.__webEngineReady);
        assert.equal(ready.featureLevel, 3);
        assert.equal(ready.shaderPlatform, 47);
        assert.equal(run.startup.shared, threaded);
        if (threaded) assert(run.startup.ready.engineWorker &&
          run.startup.ready.gameThread !== run.startup.ready.taskThread);
        const views = [
          ['interior', [-175, -80, 160, -5, 50]],
          ['wall', [-175, -80, 160, -5, 230]]
        ];
        for (const height of smoke ? [720] : heights) {
          await page.setViewportSize({width: height * 16 / 9, height});
          for (const [label, camera] of views) {
            assert.equal(await owner.evaluate(values => Module._WebProjectViewTest(...values), camera), 1);
            await advance(page, smoke ? 30 : 90);
            const before = await scene(owner);
            assert.deepEqual(before.surface, {width: height * 16 / 9, height});
            assert.equal(before.view.outputWidth, before.surface.width);
            assert.equal(before.view.outputHeight, before.surface.height);
            assert(before.view.width > 0 && before.view.width <= before.surface.width &&
              before.view.height > 0 && before.view.height <= before.surface.height);
            const measurement = {label, height, before};
            run.measurements.push(measurement);
            if (!smoke) {
              await page.evaluate(() => {
                __threadBenchmark.ui = []; __threadBenchmark.uiMeasuring = true;
              });
              const sample = await bounded(owner.evaluate(milliseconds =>
                __threadBenchmarkSample(milliseconds), seconds * 1000), 'Frame sample');
              const ui = await page.evaluate(() => {
                __threadBenchmark.uiMeasuring = false; return __threadBenchmark.ui;
              });
              assert(sample.cpu.length >= 10 && sample.intervals.length >= 9 && ui.length);
              measurement.fps = sample.frames * 1000 / sample.elapsed;
              measurement.callbackMs = distribution(sample.cpu);
              measurement.frameIntervalMs = distribution(sample.intervals);
              measurement.uiTimerMs = distribution(ui);
              measurement.raw = sample;
              measurement.gpu = [];
              for (let count = 0; count < 5; ++count) {
                const gpu = await bounded(owner.evaluate(() => __threadBenchmarkGPU()), 'GPU sample');
                if (gpu) measurement.gpu.push(gpu);
              }
              if (measurement.gpu.length)
                measurement.gpuPassMs = distribution(measurement.gpu.map(item => item.passMilliseconds));
            }
            measurement.after = await scene(owner);
            assert.deepEqual(renderSettings(measurement.after.view), renderSettings(before.view),
              'Render settings must remain stable during measurement');
            assert.deepEqual(measurement.after.gpu.errors, []);
            assert.deepEqual(measurement.after.gpu.losses, []);
            if (index < 2 || smoke)
              measurement.image = await screenshot(page, `${name.toLowerCase()}-${threaded ? 'thread' : 'single'}-${height}-${label}`);
            console.log(JSON.stringify({browser: name, index, threaded, label, height,
              fps: measurement.fps, callbackMs: measurement.callbackMs?.mean,
              gpuMs: measurement.gpuPassMs?.mean}));
          }
        }
        assert.deepEqual(run.errors, []);
        run.pass = true;
        await page.close();
      }
      await context.close();
      context = null;
    }
    if (!smoke) {
      for (const browser of new Set(report.runs.map(run => run.browser)))
        for (const height of heights) for (const label of ['interior', 'wall']) {
          const samples = threaded => report.runs.filter(run => run.browser === browser && run.threaded === threaded)
            .flatMap(run => run.measurements.filter(sample => sample.height === height && sample.label === label));
          const single = samples(false), threaded = samples(true);
          assert(single.length === 2 && threaded.length === 2);
          const settings = renderSettings(single[0].before.view);
          for (const sample of [...single, ...threaded])
            assert.deepEqual(renderSettings(sample.before.view), settings,
              'A/B internal resolution and anti-aliasing must match');
          const mean = (values, get) => values.reduce((total, value) => total + get(value), 0) / values.length;
          const singleFPS = mean(single, x => x.fps), threadFPS = mean(threaded, x => x.fps);
          report.comparisons.push({browser, height, label, renderSettings: settings, singleFPS, threadFPS,
            fpsChangePercent: (threadFPS / singleFPS - 1) * 100,
            singleCallbackMs: mean(single, x => x.callbackMs.mean),
            threadCallbackMs: mean(threaded, x => x.callbackMs.mean),
            singleP95Ms: mean(single, x => x.frameIntervalMs.p95),
            threadP95Ms: mean(threaded, x => x.frameIntervalMs.p95),
            singleUITimerP95Ms: mean(single, x => x.uiTimerMs.p95),
            threadUITimerP95Ms: mean(threaded, x => x.uiTimerMs.p95),
            singleGPUPassMs: single.every(x => x.gpuPassMs) ? mean(single, x => x.gpuPassMs.mean) : null,
            threadGPUPassMs: threaded.every(x => x.gpuPassMs) ? mean(threaded, x => x.gpuPassMs.mean) : null});
        }
    }
    report.pass = report.runs.length > 0 && report.runs.every(run => run.pass);
  } catch (error) { report.failure = error.stack; }
  finally {
    if (context) await context.close();
    const file = path.join(directory, `web-project-${id}-threads${smoke ? '-smoke' : '-benchmark'}${option('browser') ? '-' + option('browser').toLowerCase() : ''}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, comparisons: report.comparisons, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
