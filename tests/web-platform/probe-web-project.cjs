const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const id = option('project');
const suffix = option('report') || 'current';
const seconds = Number(option('seconds') || 5);
const warmupFrames = Number(option('warmup-frames') || 120);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
assert(seconds >= 1 && seconds <= 60);
assert(Number.isInteger(warmupFrames) && warmupFrames >= 2 && warmupFrames <= 120);
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, projectId: id, runs: [],
  warmupFrames, physicalPhoneTested: false, performanceAccepted: false, vramBudgetVerified: false,
  sources: [__filename, path.join(__dirname, 'web-default-template.html')].map(audit)};
let browser;
function instrumentation() {
  const state = globalThis.__projectProbe = {errors: [], deviceLosses: [], frames: null,
    submissions: 0, draws: 0, textures: 0, buffers: 0, bufferBytes: 0, pipelines: 0,
    textureFormats: {}, textureDescriptorBytesCreated: 0, textureUncompressedEquivalentBytesCreated: 0};
  let lastFrame = 0;
  const raf = requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => raf.call(globalThis, time => {
    callback(time);
    const frame = globalThis.__webEngineFrames || 0;
    if (state.frames && frame !== lastFrame) state.frames.push({frame, time: performance.now()});
    lastFrame = frame;
  });
  const requestAdapter = navigator.gpu.requestAdapter;
  navigator.gpu.requestAdapter = async function(...args) {
    const adapter = await requestAdapter.apply(this, args);
    if (adapter) {
      state.adapter = Object.fromEntries(['vendor', 'architecture', 'device', 'description']
        .map(key => [key, adapter.info?.[key] || '']));
      state.adapterFeatures = Array.from(adapter.features);
    }
    return adapter;
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    state.deviceFeatures = Array.from(device.features);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.deviceLosses.push({reason: info.reason, message: info.message});
    });
    globalThis.__projectIdle = () => device.queue.onSubmittedWorkDone();
    return device;
  };
  for (const [prototype, method, counter] of [
    [GPUQueue.prototype, 'submit', 'submissions'],
    [GPUDevice.prototype, 'createRenderPipeline', 'pipelines'],
    [GPURenderPassEncoder.prototype, 'draw', 'draws'],
    [GPURenderPassEncoder.prototype, 'drawIndexed', 'draws']
  ]) {
    const original = prototype[method];
    prototype[method] = function(...args) {
      const result = original.apply(this, args);
      ++state[counter];
      return result;
    };
  }
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    ++state.textures;
    const compressed = /^bc/.test(descriptor.format);
    const block = compressed ? 4 : 1;
    const bytes = compressed ? (/^bc[14]-/.test(descriptor.format) ? 8 : 16) : ({
      r8unorm: 1, r8uint: 1, rg8unorm: 2, r16float: 2, r16uint: 2,
      rg16float: 4, r32float: 4, r32uint: 4, rgba16float: 8,
      rgba8uint: 4, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4,
      depth32float: 4, 'depth24plus-stencil8': 4
    }[descriptor.format]);
    const size = descriptor.size;
    const width = size.width ?? size[0];
    const height = size.height ?? size[1] ?? 1;
    const depth = size.depthOrArrayLayers ?? size[2] ?? 1;
    let total = 0, equivalent = 0;
    if (bytes) for (let mip = 0; mip < (descriptor.mipLevelCount || 1); ++mip) {
      const x = Math.max(1, width >> mip), y = Math.max(1, height >> mip);
      const z = descriptor.dimension === '3d' ? Math.max(1, depth >> mip) : depth;
      total += Math.ceil(x / block) * Math.ceil(y / block) * z * bytes;
      equivalent += x * y * z * (compressed ? (/^bc6h-/.test(descriptor.format) ? 8 : 4) : bytes);
    }
    const entry = state.textureFormats[descriptor.format] ||= {count: 0, descriptorBytesCreated: 0,
      uncompressedEquivalentBytesCreated: 0, mipLevels: 0};
    ++entry.count;
    entry.mipLevels += descriptor.mipLevelCount || 1;
    entry.descriptorBytesCreated += total;
    entry.uncompressedEquivalentBytesCreated += equivalent;
    state.textureDescriptorBytesCreated += total;
    state.textureUncompressedEquivalentBytesCreated += equivalent;
    if (!bytes) entry.unknownByteSize = true;
    return texture;
  };
  const createBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function(descriptor) {
    const result = createBuffer.call(this, descriptor);
    ++state.buffers;
    state.bufferBytes += descriptor.size;
    return result;
  };
}
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
function pixels(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  let nonBlack = 0, total = 0;
  const colors = new Set();
  for (let index = 0; index < png.data.length; index += 4) {
    const sum = png.data[index] + png.data[index + 1] + png.data[index + 2];
    total += sum;
    if (sum > 12) ++nonBlack;
    colors.add(png.data.readUInt32LE(index));
  }
  return {width: png.width, height: png.height, nonBlackFraction: nonBlack / (png.width * png.height),
    colors: colors.size, mean: total / (png.width * png.height * 3)};
}
(async () => {
  try {
    const packageFile = path.join(directory, `web-project-${id}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.packageReport = audit(packageFile);
    const browsers = [['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']];
    for (const [name, executablePath] of browsers.filter(([name]) => !option('browser') || option('browser') === name)) {
      browser = await chromium.launch({headless: true, executablePath});
      const profiles = option('smoke') === '1' ? [{name: 'desktop-720p', width: 1280, height: 720, dpr: 1}] : [
        {name: 'desktop-720p', width: 1280, height: 720, dpr: 1},
        {name: 'desktop-high-dpi', width: 1280, height: 720, dpr: 2},
        {name: 'mobile-portrait', width: 360, height: 626, dpr: 3, mobile: true}
      ];
      for (const profile of profiles) {
        const run = {browser: name, version: browser.version(), profile, pass: false,
          emulatedMobile: !!profile.mobile, errors: [], contentErrors: [], log: []};
        report.runs.push(run);
        const context = await browser.newContext({viewport: {width: profile.width, height: profile.height},
          deviceScaleFactor: profile.dpr, isMobile: !!profile.mobile, hasTouch: !!profile.mobile});
        const page = await context.newPage();
        const started = Date.now();
        page.on('pageerror', error => run.errors.push(error.stack || error.message));
        page.on('console', message => {
          run.log.push(message.text());
          if (run.log.length > 400) run.log.shift();
          if (/Log(?:Material|Linker|Streaming|Class|Blueprint|UObjectGlobals): Error:|Failed to load.*(?:Class|Package)|Can't find file/.test(message.text()) &&
              run.contentErrors.length < 80) run.contentErrors.push(message.text());
        });
        try {
          await page.addInitScript(instrumentation);
          await page.goto(`http://127.0.0.1:8765/build/${id}/index.html`, {waitUntil: 'commit'});
          await page.waitForFunction(frames => globalThis.__webEngineFailure ||
            globalThis.__projectProbe?.deviceLosses.length || globalThis.__webEngineFrames >= frames,
          warmupFrames, {timeout: 240000});
          run.startupToWarmupFramesMs = Date.now() - started;
          run.startup = await page.evaluate(() => startupSnapshot());
          assert(!run.startup.failure && run.startup.frames >= warmupFrames, run.startup.failure || 'No engine frames');
          run.world = await page.evaluate(() => globalThis.__webEngineWorld);
          run.scene = await page.evaluate(() => globalThis.__webRenderScene);
          run.compatibilityOverrides = run.log.filter(line => line.startsWith('P3_PROJECT_COMPATIBILITY '));
          assert(run.world?.package === packaged.map && run.world.begunPlay && run.scene?.meshes > 0);
          await page.waitForFunction(() => document.getElementById('loading').hidden);
          await page.evaluate(() => globalThis.__projectIdle());
          const before = await page.evaluate(() => ({...globalThis.__projectProbe,
            heap: globalThis.__webEngineRuntime?.heapBytes || null}));
          const sample = await page.evaluate(async milliseconds => {
            const state = globalThis.__projectProbe;
            state.frames = [];
            await new Promise(resolve => setTimeout(resolve, milliseconds));
            await globalThis.__projectIdle();
            const frames = state.frames;
            state.frames = null;
            const canvas = document.querySelector('canvas');
            return {...state, frames, canvas: {width: canvas.width, height: canvas.height},
              heapBytes: globalThis.__webEngineRuntime?.heapBytes || null,
              jsHeapBytes: performance.memory?.usedJSHeapSize || null,
              camera: globalThis.__webDefaultCamera, failure: globalThis.__webEngineFailure || null};
          }, seconds * 1000);
          // Save the independent samples before merging the instrumented counters.
          const frameSamples = sample.frames;
          assert(Array.isArray(frameSamples) && frameSamples.length > 5, 'No frame-time samples');
          const intervals = frameSamples.slice(1).map((item, index) => item.time - frameSamples[index].time);
          run.performance = {seconds, sampleFrames: frameSamples.length,
            engineFps: (frameSamples.at(-1).frame - frameSamples[0].frame) * 1000 /
              (frameSamples.at(-1).time - frameSamples[0].time),
            frameMs: {median: quantile(intervals, 0.5), p95: quantile(intervals, 0.95),
              p99: quantile(intervals, 0.99), max: Math.max(...intervals)},
            canvas: sample.canvas, heapBytes: sample.heapBytes,
            heapGrowthBytes: sample.heapBytes != null && before.heap != null ? sample.heapBytes - before.heap : null,
            approximateJSHeapBytes: sample.jsHeapBytes, adapter: sample.adapter,
            buffersCreated: sample.buffers - before.buffers,
            bufferBytesAllocated: sample.bufferBytes - before.bufferBytes,
            pipelinesCreated: sample.pipelines - before.pipelines,
            drawsPerEngineFrame: (sample.draws - before.draws) /
              (frameSamples.at(-1).frame - frameSamples[0].frame), rawSamples: frameSamples};
          run.gpu = {errors: sample.errors, deviceLosses: sample.deviceLosses,
            draws: sample.draws, submissions: sample.submissions, textures: sample.textures,
            buffers: sample.buffers, bufferBytesAllocated: sample.bufferBytes, pipelines: sample.pipelines,
            deviceFeatures: sample.deviceFeatures, textureFormats: sample.textureFormats,
            textureDescriptorBytesCreated: sample.textureDescriptorBytesCreated,
            textureUncompressedEquivalentBytesCreated: sample.textureUncompressedEquivalentBytesCreated,
            memoryBoundary: 'Cumulative texture descriptor estimates; excludes driver alignment, buffers and residency. Not measured VRAM.'};
          if (packaged.textureCompression === 'BC') {
            assert(sample.deviceFeatures.includes('texture-compression-bc'));
            assert(Object.keys(sample.textureFormats).some(format => /^bc/.test(format)), 'No compressed GPU textures');
            run.textureCompressionVerified = true;
          }
          assert(!sample.failure && !sample.errors.length && !sample.deviceLosses.length && !run.errors.length);
          const screenshot = path.join(directory, `web-project-${id}-${name.toLowerCase()}-${profile.name}-${suffix}.png`);
          await page.screenshot({path: screenshot});
          run.screenshot = audit(screenshot);
          run.pixels = pixels(screenshot);
          assert(run.pixels.nonBlackFraction > 0.1 && run.pixels.colors > 64, 'Rendered page is blank');
          run.contentCompatibilityPass = run.contentErrors.length === 0;
          run.pass = true;
        } catch (error) {
          run.failure = error.stack || String(error);
          run.startup ||= await page.evaluate(() => typeof startupSnapshot === 'function' ? startupSnapshot() : null).catch(() => null);
          run.world ||= await page.evaluate(() => globalThis.__webEngineWorld).catch(() => null);
          run.scene ||= await page.evaluate(() => globalThis.__webRenderScene).catch(() => null);
          run.gpu ||= await page.evaluate(() => globalThis.__projectProbe).catch(() => null);
          const screenshot = path.join(directory, `web-project-${id}-${name.toLowerCase()}-${profile.name}-${suffix}-failed.png`);
          await page.screenshot({path: screenshot, timeout: 10000}).then(() => {
            run.screenshot = audit(screenshot);
          }).catch(error => { run.screenshotFailure = error.message; });
        } finally { await context.close(); }
        console.log(JSON.stringify({browser: name, profile: profile.name, pass: run.pass,
          fps: run.performance?.engineFps, startupMs: run.startupToWarmupFramesMs, failure: run.failure}));
        if (!run.pass) break;
      }
      await browser.close();
      browser = null;
    }
    report.pass = report.runs.length > 0 && report.runs.every(run => run.pass);
    report.boundary = 'Desktop browsers with default GPU settings; frame times measure completed engine ticks. ' +
      'Pass verifies startup/rendering/compressed GPU descriptors without a performance or VRAM threshold. ' +
      'The recorded renderer profile excludes unsupported desktop features. No native visual parity or phone performance claim.';
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-project-${id}-${suffix}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file}));
    if (!report.pass) process.exitCode = 1;
  }
})();
