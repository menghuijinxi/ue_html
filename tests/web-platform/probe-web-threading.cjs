const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const browserName = option('browser') || 'Chrome';
const project = option('project');
const seconds = Number(option('seconds') || 3);
const resolutions = (option('resolutions') || '1080,2160,2160,1080').split(',').map(Number);
assert(['Chrome', 'Edge'].includes(browserName) && seconds >= 2 && seconds <= 15);
assert(!project || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project));
assert(resolutions.length > 0 && resolutions.every(height => [1080, 2160].includes(height)));
const directory = path.join(__dirname, 'results');
const root = path.resolve(__dirname, '../..');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, browser: browserName,
  project: project || null, seconds, resolutions, headless: true, measurements: [], errors: [],
  sourceFiles: [__filename, 'run-browser.cjs', 'serve.cjs'].map(file =>
    audit(path.isAbsolute(file) ? file : path.join(__dirname, file)))};
const distribution = values => {
  assert(values.length);
  const sorted = [...values].sort((a, b) => a - b);
  return {count: sorted.length, mean: values.reduce((a, b) => a + b, 0) / values.length,
    median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.floor(sorted.length * 0.95)]};
};

function observe() {
  const state = globalThis.threadingProbe = {cpu: [], intervals: [], errors: [], losses: [], measuring: false};
  let device, query, resolve, readback, capture, frame = 0, previousFrame;
  const request = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => request(time => {
    const before = globalThis.__webEngineFrames || 0, start = performance.now();
    try { return callback(time); }
    finally {
      if (state.measuring && (globalThis.__webEngineFrames || 0) > before) {
        const end = performance.now();
        state.cpu.push(end - start);
        if (previousFrame !== undefined) state.intervals.push(end - previousFrame);
        previousFrame = end;
      }
    }
  });
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
    state.timestampSupported = this.features.has('timestamp-query');
    state.hardwareConcurrency = navigator.hardwareConcurrency;
    const features = [...(descriptor.requiredFeatures || [])];
    if (state.timestampSupported && !features.includes('timestamp-query')) features.push('timestamp-query');
    device = await requestDevice.call(this, {...descriptor, requiredFeatures: features});
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => state.losses.push({reason: info.reason, message: info.message}));
    if (state.timestampSupported) {
      query = device.createQuerySet({type: 'timestamp', count: 512});
      resolve = device.createBuffer({size: 4096,
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
  Object.defineProperty(globalThis, '__webEngineFrames', {configurable: true,
    get: () => frame,
    set(value) {
      frame = value;
      if (!capture) return;
      const completed = capture;
      capture = null;
      if (!completed.passes) { completed.reject(new Error('No GPU passes captured')); return; }
      const count = completed.passes * 2, encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(query, 0, count, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readback.mapAsync(GPUMapMode.READ).then(() => {
        const timestamps = new BigUint64Array(readback.getMappedRange());
        let passMilliseconds = 0;
        for (let index = 0; index < count; index += 2)
          passMilliseconds += Number(timestamps[index + 1] - timestamps[index]) / 1e6;
        const spanMilliseconds = Number(timestamps[count - 1] - timestamps[0]) / 1e6;
        readback.unmap();
        completed.resolve({frame, passes: completed.passes, passMilliseconds, spanMilliseconds});
      }, completed.reject);
    }
  });
  globalThis.threadingGpuSample = () => {
    if (!query) throw new Error('GPU timestamp-query is unavailable');
    if (capture) throw new Error('Overlapping GPU capture');
    return new Promise((resolve, reject) => { capture = {passes: 0, resolve, reject}; });
  };
  globalThis.threadingSample = async milliseconds => {
    await device.queue.onSubmittedWorkDone();
    previousFrame = undefined;
    state.cpu = []; state.intervals = []; state.measuring = true;
    const start = performance.now();
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    state.measuring = false;
    return {elapsedMilliseconds: performance.now() - start, cpu: state.cpu, intervals: state.intervals};
  };
}

(async () => {
  let browser;
  const bounded = async (operation, label) => {
    let timer;
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 90000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const p0File = path.join(directory, `threads-research-${browserName.toLowerCase()}-results.json`);
    const p0 = read(p0File);
    assert(p0.length === 3 && p0.every(run => run.pass));
    assert(p0.some(run => run.variant === 'abi64-thread' && run.report.threads &&
      run.report.pointerBytes === 8 && run.report.atomicCounter === 20000));
    assert(p0.filter(run => run.variant === 'gpu64-thread').length === 2);
    report.workerCapability = audit(p0File);
    report.workerProducts = ['abi64-thread', 'gpu64-thread'].flatMap(name =>
      ['js', 'wasm'].map(extension => audit(path.join(__dirname, 'build/web', `${name}.${extension}`))));
    report.workerSources = ['abi.cpp', 'probe.cpp', 'build-web.ps1', 'index.html'].map(name =>
      audit(path.join(__dirname, name)));
    report.platformSources = [
      'reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformProcess.h',
      'reference-engine/Engine/Platforms/Web/Source/Runtime/Core/Public/Web/WebPlatformMisc.h',
      'reference-engine/Engine/Platforms/Web/Source/Programs/UnrealBuildTool/WebToolChain.cs',
      'reference-engine/Engine/Source/Runtime/Core/Private/GenericPlatform/GenericPlatformProcess.cpp',
      'reference-engine/Engine/Source/Runtime/Core/Private/GenericPlatform/GenericPlatformMisc.cpp',
      'tests/ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp',
      'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
      'tests/web-platform/web-content-io.js'
    ].map(name => audit(path.join(root, name)));
    const buildFile = path.join(directory, 'web-engine-full-build-results.json'), build = read(buildFile);
    assert(build.pass && build.sourceFiles.every(valid) && build.products.every(valid) &&
      valid(build.linkResponse));
    report.buildReport = audit(buildFile);
    report.linkResponse = build.linkResponse;
    report.pthreadLinkEnabled = /(?:^|\s)-pthread(?:\s|$)/m.test(fs.readFileSync(build.linkResponse.file, 'utf8'));
    const prefix = project ? `web-project-${project}-desktop` : 'web-default-template-desktop';
    const packagedFile = path.join(directory, `${prefix}-package-results.json`), packaged = read(packagedFile);
    assert(packaged.pass && packaged.sourceFiles.every(valid) && packaged.products.every(valid));
    report.packageReport = audit(packagedFile);
    const releaseFile = path.join(directory, project ? `${prefix}-publish-results.json` :
      'web-default-desktop-publish-results.json'), release = read(releaseFile);
    assert(release.pass && release.products.every(valid));
    report.publishReport = audit(releaseFile);
    report.products = release.products;
    report.runtimeMatchesLatestBuild = release.products.filter(item =>
      ['UEWebEngine.js', 'UEWebEngine.wasm'].includes(path.basename(item.file))).every(item =>
      build.products.some(product => path.basename(product.file) === path.basename(item.file) &&
        product.sha256 === item.sha256));
    browser = await chromium.launch({headless: true, executablePath: browserName === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    const page = await browser.newPage({viewport: {width: 1920, height: 1080}, deviceScaleFactor: 1});
    report.workers = [];
    page.on('worker', worker => report.workers.push(worker.url()));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      if (/Fatal error|Assertion failed|GPU validation|GPUValidationError/.test(message.text()))
        report.errors.push(message.text());
    });
    await page.addInitScript(observe);
    await page.goto(`http://127.0.0.1:8765/build/${project || 'ue-default-template'}/index.html`,
      {waitUntil: 'commit', timeout: 90000});
    const frames = async count => {
      const start = await page.evaluate(() => globalThis.__webEngineFrames || 0);
      await page.waitForFunction(target => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= target, start + count, {timeout: 240000});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    };
    await frames(120);
    report.environment = await page.evaluate(() => ({
      isolated: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      memoryShared: HEAPU8.buffer instanceof SharedArrayBuffer, heapBytes: HEAPU8.buffer.byteLength,
      hardwareConcurrency: navigator.hardwareConcurrency, ready: __webEngineReady
    }));
    for (const height of resolutions) {
      const width = height * 16 / 9;
      await page.setViewportSize({width, height});
      await frames(60);
      const sample = await bounded(
        page.evaluate(milliseconds => threadingSample(milliseconds), seconds * 1000), 'CPU sample');
      assert(sample.cpu.length > 3 && sample.intervals.length > 2);
      const gpu = [];
      for (let index = 0; index < 5; index++)
        gpu.push(await bounded(page.evaluate(() => threadingGpuSample()), 'GPU sample'));
      const state = await page.evaluate(() => ({
        canvas: {width: Module.canvas.width, height: Module.canvas.height},
        renderView: globalThis.__webRenderView || null, camera: __webDefaultCamera,
        errors: threadingProbe.errors, losses: threadingProbe.losses
      }));
      assert.equal(state.canvas.width, width);
      assert.equal(state.canvas.height, height);
      assert.deepEqual(state.errors, []); assert.deepEqual(state.losses, []);
      const measurement = {...state, callbackMilliseconds: distribution(sample.cpu),
        frameIntervalMilliseconds: distribution(sample.intervals),
        gpuPassMilliseconds: distribution(gpu.map(item => item.passMilliseconds)),
        gpuSpanMilliseconds: distribution(gpu.map(item => item.spanMilliseconds)), gpu};
      report.measurements.push(measurement);
      console.log(JSON.stringify({canvas: state.canvas, renderView: state.renderView,
        callbackMilliseconds: measurement.callbackMilliseconds,
        gpuPassMilliseconds: measurement.gpuPassMilliseconds}));
    }
    assert.deepEqual(report.errors, []);
    report.currentEngineSingleThreaded = !report.environment.memoryShared;
    report.threadedWorkerGPUVerified = true;
    report.pass = true;
    report.boundary = 'Measures synchronous browser RAF callbacks that complete UE frames, not isolated Game/Draw CPU timers. GPU pass sums exclude copies and gaps; GPU spans may include starvation between submissions. Headless runs and API instrumentation are diagnostic, not display FPS or a scalability guarantee. Threaded standalone samples do not enable UE worker/render/RHI threads.';
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    const output = path.join(directory,
      `web-threading-${project || 'default'}-${browserName.toLowerCase()}-results.json`);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file: output, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
