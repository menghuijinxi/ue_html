const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const name = option('browser') || 'Chrome';
const dpr = Number(option('dpr') || 1);
const seconds = Number(option('seconds') || 4);
const gpuTiming = process.argv.includes('--gpu-timing');
const requireReconstruction = process.argv.includes('--require-cloud-reconstruction');
const fullResolutionClouds = process.argv.includes('--full-resolution-clouds');
const maxCloudMilliseconds = Number(option('max-cloud-ms') || 0);
const requestedViews = (option('views') || 'default,sky').split(',');
const cameraViews = {default: [-15, 120], horizon: [0, 120], cloudbank: [20, 120],
  cloudback: [20, 300], cloudleft: [20, 30], cloudright: [20, 210],
  cloudmid: [40, 120], sky: [70, 120], ground: [-80, 120]};
const cloudBudget = Number(option('cloud-budget') || 0);
const budgetSweep = process.argv.includes('--budget-sweep');
const budgetProfiles = (option('budget-profiles') || '0,1,2,3,4,5,6').split(',').map(Number);
const compactCloudTextures = option('compact-cloud-textures') ||
  (process.argv.includes('--compact-cloud-textures') ? 'all' : '');
const diagnosticRuntime = process.argv.includes('--diagnostic-runtime');
const expectedTracingDivisor = Number(option('tracing-divisor') || 8);
const suffix = option('report') || `${name.toLowerCase()}-dpr${dpr}${gpuTiming ? '-gpu' : ''}`;
assert(['Chrome', 'Edge'].includes(name) && dpr > 0 && dpr <= 2 && seconds >= 1 &&
  seconds <= 30 && /^[a-z0-9.-]+$/.test(suffix) &&
  !(requireReconstruction && fullResolutionClouds) && Number.isFinite(maxCloudMilliseconds) &&
  maxCloudMilliseconds >= 0 && (!(requireReconstruction || maxCloudMilliseconds) || gpuTiming) &&
  requestedViews.length && requestedViews.every(view => Object.hasOwn(cameraViews, view)) &&
  Number.isInteger(cloudBudget) && cloudBudget >= 0 && cloudBudget <= 10 &&
  budgetProfiles.every(value => Number.isInteger(value) && value >= 0 && value <= 10) &&
  ['', 'all', 'density'].includes(compactCloudTextures) && [4, 8].includes(expectedTracingDivisor));
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, browser: name, dpr, seconds, gpuTiming,
  requireReconstruction, fullResolutionClouds, maxCloudMilliseconds, requestedViews, cloudBudget, budgetSweep, budgetProfiles, compactCloudTextures, diagnosticRuntime, expectedTracingDivisor,
  viewport: {width: 1848, height: 1120}, headless: true, scheduling: 'default',
  sources: [__filename, path.join(__dirname, 'aim-web-default-camera.cjs')].map(audit), errors: [], measurements: []};
const shaderEntries = new Map();
let browser;
let page;

function observe({gpuTiming, compactCloudTextures}) {
  const state = globalThis.__webPerformance = {errors: [], deviceLosses: [], frameTimes: null, textures: []};
  let device;
  let frame = 0;
  let capture;
  let querySet;
  let resolveBuffer;
  let readBuffer;
  const pipelines = new WeakMap();
  const passes = new WeakMap();
  const bound = new WeakMap();
  const views = new WeakMap();
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const view = createView.apply(this, args);
    views.set(view, {label: this.label, width: this.width, height: this.height, format: this.format});
    return view;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  const compactTextures = new WeakMap();
  GPUDevice.prototype.createTexture = function(descriptor) {
    const channels = descriptor.label === 'VT_PerlinWorley_Balanced' ? 2 :
      descriptor.label === 'VT_Lightning' && compactCloudTextures === 'all' ? 1 : 0;
    const compact = compactCloudTextures && channels && descriptor.dimension === '3d' &&
      descriptor.format === 'rgba16float';
    if (compact) descriptor = {...descriptor, format: channels === 1 ? 'r16float' : 'rg16float'};
    const texture = createTexture.call(this, descriptor);
    if (compact) compactTextures.set(texture, channels);
    if (/VolumetricRenderTarget/.test(texture.label)) {
      const item = {label: texture.label, width: texture.width, height: texture.height, format: texture.format};
      if (!state.textures.some(previous => JSON.stringify(previous) === JSON.stringify(item)))
        state.textures.push(item);
    }
    return texture;
  };
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function(destination, data, layout, size) {
    const channels = compactTextures.get(destination.texture);
    if (!channels) return writeTexture.call(this, destination, data, layout, size);
    const [width, height, depth] = Array.isArray(size) ? size :
      [size.width, size.height || 1, size.depthOrArrayLayers || 1];
    const bytes = ArrayBuffer.isView(data) ?
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const output = new Uint8Array(width * height * depth * channels * 2);
    const pitch = layout.bytesPerRow || width * 8;
    const rows = layout.rowsPerImage || height;
    for (let z = 0; z < depth; ++z) for (let y = 0; y < height; ++y)
    for (let x = 0; x < width; ++x) {
      const source = (layout.offset || 0) + (z * rows + y) * pitch + x * 8;
      output.set(bytes.subarray(source, source + channels * 2),
        ((z * height + y) * width + x) * channels * 2);
    }
    return writeTexture.call(this, destination, output,
      {bytesPerRow: width * channels * 2, rowsPerImage: height}, size);
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor = {}) {
    state.adapter = Object.fromEntries(['vendor', 'architecture', 'device', 'description']
      .map(key => [key, this.info[key]]));
    state.timestampSupported = this.features.has('timestamp-query');
    const requiredFeatures = [...(descriptor.requiredFeatures || [])];
    if (gpuTiming && state.timestampSupported && !requiredFeatures.includes('timestamp-query'))
      requiredFeatures.push('timestamp-query');
    device = await requestDevice.call(this, {...descriptor, requiredFeatures});
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => state.deviceLosses.push({reason: info.reason, message: info.message}));
    if (gpuTiming && state.timestampSupported) {
      querySet = device.createQuerySet({type: 'timestamp', count: 512});
      resolveBuffer = device.createBuffer({size: 4096,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      readBuffer = device.createBuffer({size: 4096,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    }
    return device;
  };
  for (const [create, stage, begin, prototype, commands] of [
    ['createRenderPipeline', 'fragment', 'beginRenderPass', GPURenderPassEncoder.prototype,
      ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']],
    ['createComputePipeline', 'compute', 'beginComputePass', GPUComputePassEncoder.prototype,
      ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']]
  ]) {
    const originalCreate = GPUDevice.prototype[create];
    GPUDevice.prototype[create] = function(descriptor) {
      const pipeline = originalCreate.call(this, descriptor);
      pipelines.set(pipeline, descriptor[stage]?.entryPoint || descriptor.vertex?.entryPoint || '');
      return pipeline;
    };
    const originalBegin = GPUCommandEncoder.prototype[begin];
    GPUCommandEncoder.prototype[begin] = function(descriptor = {}) {
      let record;
      if (capture) {
        if (descriptor.timestampWrites || capture.passes.length >= 256)
          throw new Error('Cannot safely instrument this pass for timestamp measurements.');
        const index = capture.passes.length * 2;
        record = {label: descriptor.label || '', entries: [], index,
          targets: [...(descriptor.colorAttachments || [])].map(item => views.get(item?.view) || null)};
        capture.passes.push(record);
        descriptor = {...descriptor, timestampWrites: {querySet,
          beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}};
      }
      const pass = originalBegin.call(this, descriptor);
      if (record) passes.set(pass, record);
      return pass;
    };
    const setPipeline = prototype.setPipeline;
    prototype.setPipeline = function(pipeline) {
      if (passes.has(this)) bound.set(this, pipelines.get(pipeline));
      return setPipeline.call(this, pipeline);
    };
    for (const command of commands) {
      const execute = prototype[command];
      prototype[command] = function(...args) {
        const record = passes.get(this);
        const entry = bound.get(this);
        if (record && entry && !record.entries.includes(entry)) record.entries.push(entry);
        return execute.apply(this, args);
      };
    }
  }
  Object.defineProperty(globalThis, '__webEngineFrames', {
    configurable: true, get: () => frame,
    set(value) {
      frame = value;
      if (state.frameTimes) state.frameTimes.push(performance.now());
      if (!capture) return;
      const completed = capture;
      capture = null;
      const count = completed.passes.length * 2;
      if (!count) {
        completed.reject(new Error('No GPU passes captured during the UE frame.'));
        return;
      }
      const encoder = device.createCommandEncoder();
      encoder.resolveQuerySet(querySet, 0, count, resolveBuffer, 0);
      encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, count * 8);
      device.queue.submit([encoder.finish()]);
      readBuffer.mapAsync(GPUMapMode.READ).then(() => {
        const values = new BigUint64Array(readBuffer.getMappedRange());
        const result = completed.passes.map(item => ({...item,
          milliseconds: Number(values[item.index + 1] - values[item.index]) / 1e6}));
        readBuffer.unmap();
        completed.resolve({frame, passes: result});
      }, completed.reject);
    }
  });
  globalThis.__webPerformanceGpuFrame = () => {
    if (!querySet) throw new Error('GPU timestamp-query is unavailable.');
    return new Promise((resolve, reject) => { capture = {resolve, reject, passes: []}; });
  };
  globalThis.__webPerformanceIdle = () => device.queue.onSubmittedWorkDone();
}

async function frames(count) {
  const start = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    globalThis.__webPerformance.deviceLosses.length || globalThis.__webEngineFrames >= target,
  start + count, {timeout: 120000});
  const state = await page.evaluate(() => ({failure: globalThis.__webEngineFailure,
    ...globalThis.__webPerformance, frameTimes: null}));
  assert(!state.failure && !state.deviceLosses.length && !state.errors.length &&
    !report.errors.length, JSON.stringify(state));
}

async function mode(clouds, fog) {
  assert.equal(await page.evaluate(clouds => Module._WebDefaultSceneTestMode(clouds ? 0 : 4), clouds), 1);
  assert.equal(await page.evaluate(fog => Module._WebDefaultFogTestMode(fog ? 0 : 1), fog), 1);
  await frames(10);
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {samples: sorted.length, mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)]};
}

async function measure(view, clouds, fog, round) {
  await mode(clouds, fog);
  const sample = await page.evaluate(async milliseconds => {
    await globalThis.__webPerformanceIdle();
    const state = globalThis.__webPerformance;
    state.frameTimes = [];
    await new Promise(resolve => setTimeout(resolve, milliseconds));
    await globalThis.__webPerformanceIdle();
    const times = state.frameTimes;
    state.frameTimes = null;
    const canvas = document.querySelector('canvas');
    return {times, camera: globalThis.__webDefaultCamera, fog: globalThis.__webDefaultFog,
      cloudBudget: globalThis.__webDefaultCloudBudget,
      frame: globalThis.__webEngineFrames, canvas: {width: canvas.width, height: canvas.height},
      failure: globalThis.__webEngineFailure, errors: state.errors, deviceLosses: state.deviceLosses};
  }, seconds * 1000);
  assert(!sample.failure && !sample.errors.length && !sample.deviceLosses.length &&
    !report.errors.length && sample.times.length > 3, JSON.stringify(sample));
  const intervals = sample.times.slice(1).map((time, i) => time - sample.times[i]);
  const result = {view, clouds, fog, round, camera: sample.camera, canvas: sample.canvas,
    heightFog: sample.fog, cloudBudget: sample.cloudBudget, engineFrameMilliseconds: distribution(intervals),
    engineFps: (sample.times.length - 1) * 1000 / (sample.times.at(-1) - sample.times[0])};
  if (gpuTiming) {
    result.gpuSamples = [];
    for (let i = 0; i < 5; ++i) {
      const gpu = await page.evaluate(() => globalThis.__webPerformanceGpuFrame());
      assert(gpu.passes.every(pass => pass.milliseconds >= 0));
      for (const pass of gpu.passes)
        pass.shaderNames = pass.entries.map(entry => shaderEntries.get(entry)?.name || entry);
      assert.equal(gpu.passes.filter(pass => pass.shaderNames.some(name =>
        name.startsWith('FCloudRenderViewPS'))).length, clouds ? 1 : 0,
      'The real cloud pass must follow the component control.');
      assert.equal(gpu.passes.some(pass => pass.entries.some(entry =>
        shaderEntries.get(entry)?.heightFog)), fog,
      'The height fog permutation must follow the component; aerial perspective stays enabled.');
      if (requireReconstruction) {
        assert.equal(gpu.passes.some(pass => pass.shaderNames.includes('FDownsampleDepthPS')),
          clouds, 'Cloud tracing must use the native half-resolution scene depth.');
        assert.equal(gpu.passes.some(pass => pass.shaderNames.includes('FReconstructVolumetricRenderTargetPS')),
          clouds, 'Cloud history reconstruction must actually draw.');
        assert.equal(gpu.passes.some(pass => pass.shaderNames.includes('FComposeVolumetricRTOverScenePS')),
          clouds, 'The reconstructed cloud must actually composite over the scene.');
        for (const pass of gpu.passes.filter(pass => pass.shaderNames.some(name =>
          name.startsWith('FCloudRenderViewPS')))) {
          const divisor = sample.cloudBudget?.tracingDownsample ?
            sample.cloudBudget.tracingDownsample * 2 : expectedTracingDivisor;
          // Pooled textures can retain an earlier creation label when reused.
          assert(pass.targets[0]?.format === 'rgba16float' &&
            Math.abs(pass.targets[0].width - Math.ceil(sample.canvas.width / divisor)) <= 1 &&
            Math.abs(pass.targets[0].height - Math.ceil(sample.canvas.height / divisor)) <= 1,
          `Trace at 1/${divisor} width/height; retain the full-resolution scene.`);
        }
      }
      result.gpuSamples.push(gpu);
    }
    result.gpuPassMilliseconds = distribution(result.gpuSamples.map(item =>
      item.passes.reduce((sum, pass) => sum + pass.milliseconds, 0)));
    result.cloudGpuMilliseconds = distribution(result.gpuSamples.map(item =>
      item.passes.filter(pass => pass.shaderNames.some(name => name.startsWith('FCloudRenderViewPS')))
        .reduce((sum, pass) => sum + pass.milliseconds, 0)));
    result.cloudPipelineGpuMilliseconds = distribution(result.gpuSamples.map(item =>
      item.passes.filter(pass => pass.shaderNames.some(name => /^(FCloudRenderViewPS|FDownsampleDepthPS|FReconstructVolumetricRenderTargetPS|FComposeVolumetricRTOverScenePS)/.test(name)))
        .reduce((sum, pass) => sum + pass.milliseconds, 0)));
    if (clouds && maxCloudMilliseconds)
      assert(result.cloudPipelineGpuMilliseconds.mean <= maxCloudMilliseconds,
        `Cloud pipeline GPU cost ${result.cloudPipelineGpuMilliseconds.mean}ms exceeds ${maxCloudMilliseconds}ms`);
  }
  report.measurements.push(result);
  console.log(JSON.stringify({phase: 'measurement', view, clouds, fog, round,
    engineFps: result.engineFps, gpuPassMilliseconds: result.gpuPassMilliseconds}));
}

(async () => {
  try {
    const packageFile = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
      (diagnosticRuntime || valid(packaged.buildReport)) && valid(packaged.stageReport));
    report.packageReport = audit(packageFile);
    let runtime;
    if (diagnosticRuntime) {
      const file = path.join(directory, 'web-engine-full-build-results.json');
      runtime = read(file);
      assert(runtime.pass && runtime.fullLinkAttempted && runtime.sourceFiles.every(valid) &&
        runtime.products.every(valid) && valid(runtime.log));
      report.diagnosticBuildReport = audit(file);
      report.boundary = 'Browser-only runtime override using verified normal UBT outputs; not a newly cooked or released package.';
    }
    if (gpuTiming) {
      // Cook DDC reuse can retain entry hashes from an earlier conversion directory.
      const cooks = path.join(__dirname, 'build/web-engine-webgpu-es31-default-cook');
      for (const cook of fs.readdirSync(cooks, {withFileTypes: true})) {
        const conversions = path.join(cooks, cook.name, 'ShaderConversion');
        if (!cook.isDirectory() || !fs.existsSync(conversions)) continue;
        for (const job of fs.readdirSync(conversions, {withFileTypes: true})) {
          const input = path.join(conversions, job.name, 'input.json');
          const output = path.join(conversions, job.name, 'output.wgsl');
          if (!job.isDirectory() || !fs.existsSync(input) || !fs.existsSync(output)) continue;
          const detail = read(input);
          if (/^(FCloudRenderViewPS|FMobileFogPS|FDownsampleDepthPS|FReconstructVolumetricRenderTargetPS|FComposeVolumetricRTOverScenePS)/.test(detail.shaderName)) {
            const permutation = detail.shaderName === 'FMobileFogPS' ?
              Number(detail.shader.match(/^Global\/FMobileFogPS\/(\d+):/)[1]) : null;
            // FSupportHeightFog is the first (least significant) permutation dimension.
            shaderEntries.set(detail.metadata.webEntry,
              {name: detail.shaderName, shader: detail.shader, permutation,
                heightFog: permutation !== null && (permutation & 1) !== 0,
                input: audit(input), output: audit(output)});
          }
        }
      }
      report.shaders = Object.fromEntries(shaderEntries);
    }
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: report.viewport, deviceScaleFactor: dpr});
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => {
      if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text()))
        report.errors.push(message.text());
    });
    page.setDefaultTimeout(120000);
    if (runtime) {
      for (const name of ['UEWebEngine.js', 'UEWebEngine.wasm']) {
        const product = runtime.products.find(item => path.basename(item.file) === name);
        assert(valid(product));
        const relative = `build/diagnostic-cloud-runtime/${report.diagnosticBuildReport.sha256.slice(0, 16)}/${name}`;
        const file = path.join(__dirname, relative);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.copyFileSync(product.file, file);
        assert.equal(audit(file).sha256, product.sha256);
        (report.diagnosticProducts ||= []).push(audit(file));
        await page.route('**/build/ue-default-template/' + name,
          route => route.continue({url: 'http://127.0.0.1:8765/' + relative}));
      }
    }
    await page.addInitScript(observe, {gpuTiming, compactCloudTextures});
    await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
    await frames(120);
    if (cloudBudget) {
      assert.equal(await page.evaluate(mode => Module._WebDefaultCloudBudgetTestMode(mode), cloudBudget), 1);
      await frames(30);
    }
    if (fullResolutionClouds) {
      assert.equal(await page.evaluate(() => Module._WebDefaultCloudTracingTestMode(1)), 1);
      await frames(30);
    }
    report.observer = await page.evaluate(() => ({...globalThis.__webPerformance, frameTimes: null}));
    if (gpuTiming) assert(report.observer.timestampSupported);
    if (requireReconstruction)
      assert(report.observer.textures.some(item => item.label === 'VolumetricRenderTarget.Tracing'),
        'The packaged engine must create the low-resolution cloud tracing target.');
    for (const view of requestedViews) {
      const [pitch, yaw] = cameraViews[view];
      const camera = await page.evaluate(() => globalThis.__webDefaultCamera);
      if (Math.abs(camera.pitch - pitch) > 1 ||
          Math.abs(((yaw - camera.yaw + 540) % 360) - 180) > 1)
        await require('./aim-web-default-camera.cjs')(page, frames, pitch, yaw);
      if (budgetSweep) {
        for (const profile of budgetProfiles) {
          assert.equal(await page.evaluate(mode => Module._WebDefaultCloudBudgetTestMode(mode), profile), 1);
          await measure(view, true, true, profile);
        }
        assert.equal(await page.evaluate(() => Module._WebDefaultCloudBudgetTestMode(0)), 1);
        await measure(view, false, true, 0);
      } else {
        for (let round = 0; round < 2; ++round) {
          const controls = [[true, true], [false, true], [true, false], [false, false]];
          if (round) controls.reverse();
          for (const [clouds, fog] of controls) await measure(view, clouds, fog, round);
        }
      }
      await mode(true, true);
      const file = path.join(directory, `web-default-performance-${suffix}-${view}.png`);
      await page.evaluate(() => globalThis.__webPerformanceIdle());
      await page.locator('canvas').screenshot({path: file});
      (report.screenshots ||= []).push(audit(file));
    }
    const actual = report.measurements[0].canvas;
    assert.equal(actual.width, report.viewport.width * dpr);
    assert(Math.abs(actual.height - report.viewport.width * dpr * 9 / 16) < 2);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) report.lastState = await page.evaluate(() => ({frame: globalThis.__webEngineFrames,
      failure: globalThis.__webEngineFailure, performance: globalThis.__webPerformance,
      log: globalThis.__webEngineLog?.slice(-12)})).catch(error => ({error: error.message}));
  } finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-default-performance-${suffix}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, measurements: report.measurements.length,
      failure: report.failure}));
    if (!report.pass) process.exitCode = 1;
  }
})();
