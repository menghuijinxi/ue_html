const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const cp = require('node:child_process');

const directory = path.join(__dirname, 'results');
const folder = process.argv.find(value => value.startsWith('--folder='))?.slice(9) ||
  'ue-default-template-distance-fields-threads';
const channel = process.argv.includes('--edge') ? 'msedge' : 'chrome';
const visualClock = process.argv.includes('--visual-clock');
const startupOnly = process.argv.includes('--startup-only');
const requireVelocity = process.argv.includes('--require-velocity');
assert(!startupOnly || !visualClock, 'Startup regression must use the normal render clock');
assert(!requireVelocity || startupOnly, '--require-velocity requires --startup-only');
const packageFile = path.join(directory, folder.startsWith('ue-default-template') ?
  `web-default-template${folder.slice('ue-default-template'.length)}-package-results.json` :
  `web-project-${folder}-package-results.json`);
const camera = process.argv.find(value => value.startsWith('--camera='))?.slice(9).split(',').map(Number);
const fixedEV = process.argv.find(value => value.startsWith('--fixed-ev='))?.slice(11);
const width = Number(process.argv.find(value => value.startsWith('--width='))?.slice(8) || 1280);
const height = Number(process.argv.find(value => value.startsWith('--height='))?.slice(9) || 720);
const tag = process.argv.find(value => value.startsWith('--tag='))?.slice(6) || `${width}x${height}`;
assert(/^[a-z0-9-]+$/.test(tag));
assert(!camera || camera.length === 5 && camera.every(Number.isFinite));
assert(width >= 320 && width <= 3840 && height >= 240 && height <= 2160);
const report = {date: new Date().toISOString(), pass: false, folder, channel, visualClock, startupOnly, requireVelocity,
  errors: [], logs: [], images: [],
  source: audit(__filename), boundary: 'Browser candidate. GPU pass sums omit copies and gaps; adapter memory includes other apps. Image differences are not a quality score or proof of native parity.'};
let context, page;
const state = () => page.evaluate(() => ({failure: globalThis.__webEngineFailure,
  frames: globalThis.__webEngineFrames || 0, ready: globalThis.__webEngineReady,
  fields: globalThis.__webDistanceFields, gpu: globalThis.__webDistanceFieldsGPU,
  exposure: globalThis.__webDistanceFieldsExposure,
  view: globalThis.__webRenderView, threads: globalThis.__webEngineThreads,
  io: globalThis.__webLocalContentStats, surface: globalThis.__webEngineSurface,
  visualClock: globalThis.__webVisualTestClock || null,
  memory: globalThis.__webTextureStreaming, camera: globalThis.__webDefaultCamera}));
async function advance(count) {
  const before = await state();
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    (globalThis.__webEngineFrames || 0) >= target, before.frames + count, {timeout: 90000});
  const value = await state();
  assert(!value.failure, value.failure);
  return value;
}
async function capture(name) {
  const file = path.join(directory, `distance-field-${folder}-${channel}-${tag}-${name}.png`);
  await page.locator('canvas').screenshot({path: file, timeout: 15000});
  const png = PNG.sync.read(fs.readFileSync(file));
  let min = 255, max = 0, sum = 0;
  for (let offset = 0; offset < png.data.length; offset += 4) {
    const value = (png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
  }
  assert(max - min > 50 && sum / (png.width * png.height) > 10, 'Canvas must contain a rendered scene');
  const item = {...audit(file), name, width: png.width, height: png.height};
  report.images.push(item);
  return png;
}
(async () => {
  try {
    report.profile = path.join(__dirname, `build/browser-profiles/distance-fields-${channel}`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass);
    for (const item of packaged.products)
      assert.equal(audit(item.file).sha256, item.sha256);
    report.package = audit(packageFile);
    report.runtime = packaged.products.filter(item => /\.(wasm|js)$/.test(item.file));
    context = await chromium.launchPersistentContext(report.profile, {channel, headless: true,
      viewport: {width, height},
      args: ['--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text))
        report.errors.push(text);
    });
    await page.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `
        globalThis.__webDistanceFieldsGPU = {textures: {}, compute: {}, raster: {}, errors: [], losses: [],
          historyBindings: 0, historyVelocityBindings: 0};
        const dfPipelines = new WeakMap(), dfPasses = new WeakMap(), dfViews = new WeakMap();
        let dfDeviceHandle, dfQuery, dfResolve, dfReadback, dfCapture, dfFrame = 0;
        const dfDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function(descriptor) {
          const features = [...(descriptor.requiredFeatures || [])];
          if (this.features.has('timestamp-query') && !features.includes('timestamp-query'))
            features.push('timestamp-query');
          const device = dfDeviceHandle = await dfDevice.call(this, {...descriptor, requiredFeatures: features});
          if (features.includes('timestamp-query')) {
            dfQuery = device.createQuerySet({type: 'timestamp', count: 4096});
            dfResolve = device.createBuffer({size: 32768, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
            dfReadback = device.createBuffer({size: 32768, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          }
          __webDistanceFieldsGPU.adapter = {vendor: this.info?.vendor, description: this.info?.description};
          device.addEventListener('uncapturederror', event => __webDistanceFieldsGPU.errors.push(event.error.message));
          device.lost.then(info => {
            if (info.reason !== 'destroyed') __webDistanceFieldsGPU.losses.push(info.message);
          });
          return device;
        };
        for (const name of ['beginRenderPass', 'beginComputePass']) {
          const original = GPUCommandEncoder.prototype[name];
          GPUCommandEncoder.prototype[name] = function(descriptor = {}) {
            if (dfCapture) {
              if (dfCapture.passes >= 2048 || descriptor.timestampWrites)
                throw new Error('Distance-field GPU timestamp capacity exceeded');
              const index = dfCapture.passes++ * 2;
              descriptor = {...descriptor, timestampWrites: {querySet: dfQuery,
                beginningOfPassWriteIndex: index, endOfPassWriteIndex: index + 1}};
            }
            return original.call(this, descriptor);
          };
        }
        Object.defineProperty(globalThis, '__webEngineFrames', {configurable: true, enumerable: true,
          get: () => dfFrame, set(value) {
            dfFrame = value;
            if (!dfCapture) return;
            const sample = dfCapture;
            dfCapture = null;
            if (!sample.passes) { sample.reject(new Error('No GPU passes captured')); return; }
            const count = sample.passes * 2, encoder = dfDeviceHandle.createCommandEncoder();
            encoder.resolveQuerySet(dfQuery, 0, count, dfResolve, 0);
            encoder.copyBufferToBuffer(dfResolve, 0, dfReadback, 0, count * 8);
            dfDeviceHandle.queue.submit([encoder.finish()]);
            dfReadback.mapAsync(GPUMapMode.READ).then(() => {
              const values = new BigUint64Array(dfReadback.getMappedRange());
              let milliseconds = 0;
              for (let index = 0; index < count; index += 2)
                milliseconds += Number(values[index + 1] - values[index]) / 1e6;
              dfReadback.unmap();
              sample.resolve({frame: value, passes: sample.passes, milliseconds});
            }, sample.reject);
          }});
        globalThis.__dfSampleGPU = () => {
          if (!dfQuery) return Promise.resolve(null);
          if (dfCapture) throw new Error('Overlapping distance-field GPU sample');
          return new Promise((resolve, reject) => { dfCapture = {passes: 0, resolve, reject}; });
        };
        for (const [method, stage] of [['createComputePipeline', 'compute'], ['createRenderPipeline', 'fragment']]) {
          const original = GPUDevice.prototype[method];
          GPUDevice.prototype[method] = function(descriptor) {
            const pipeline = original.call(this, descriptor);
            dfPipelines.set(pipeline, descriptor[stage]?.entryPoint || descriptor.label || 'unknown');
            return pipeline;
          };
        }
        for (const [prototype, methods, category] of [
          [GPUComputePassEncoder.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'], 'compute'],
          [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'], 'raster']]) {
          const originalPipeline = prototype.setPipeline;
          prototype.setPipeline = function(pipeline) {
            dfPasses.set(this, dfPipelines.get(pipeline));
            return originalPipeline.call(this, pipeline);
          };
          for (const method of methods) {
            const original = prototype[method];
            prototype[method] = function(...args) {
              const entry = dfPasses.get(this);
              const counts = __webDistanceFieldsGPU[category];
              if (entry) counts[entry] = (counts[entry] || 0) + 1;
              return original.apply(this, args);
            };
          }
        }
        const dfTexture = GPUDevice.prototype.createTexture;
        GPUDevice.prototype.createTexture = function(descriptor) {
          if (/DistanceField|GlobalDistance|BentNormal|SceneVelocity/.test(descriptor.label || ''))
            __webDistanceFieldsGPU.textures[descriptor.label] = {
              size: descriptor.size, format: descriptor.format, dimension: descriptor.dimension,
              mipLevelCount: descriptor.mipLevelCount
            };
          return dfTexture.call(this, descriptor);
        };
        const dfView = GPUTexture.prototype.createView;
        GPUTexture.prototype.createView = function(...args) {
          const view = dfView.apply(this, args);
          dfViews.set(view, this.label);
          return view;
        };
        const dfBindGroup = GPUDevice.prototype.createBindGroup;
        GPUDevice.prototype.createBindGroup = function(descriptor) {
          const labels = descriptor.entries.map(entry => dfViews.get(entry.resource));
          if (labels.includes('DistanceFieldAOHistory')) {
            ++__webDistanceFieldsGPU.historyBindings;
            if (labels.includes('SceneVelocity')) ++__webDistanceFieldsGPU.historyVelocityBindings;
          }
          return dfBindGroup.call(this, descriptor);
        };
      ` + await response.text()});
    });
    if (visualClock) await page.route('**/index.html', async route => {
      const response = await route.fetch();
      const source = await response.text();
      assert(source.includes("arguments: ['-webgpu',"));
      await route.fulfill({response, body: source.replace("arguments: ['-webgpu',",
        "arguments: ['-WebVisualTestClock', '-webgpu',")});
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    report.startup = await advance(90);
    if (!visualClock) assert.equal(report.startup.visualClock, null, 'Normal startup must not freeze rendering');
    assert(report.startup.fields?.meshes > 0, 'Cooked mesh distance fields must be loaded');
    assert.equal(report.startup.fields.ao, 1, 'The shipped page must start with DFAO enabled');
    const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js'));
    assert(owner);
    if (camera) {
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), camera), 1);
      await advance(30);
      report.camera = camera;
    }
    if (fixedEV !== undefined) {
      assert(camera && Number.isFinite(Number(fixedEV)));
      assert.equal(await page.evaluate(value => __webEngineRPC('WebDistanceFieldTestExposure', value), Number(fixedEV)), 1);
      report.fixedEV100 = Number(fixedEV);
      await advance(90);
    }
    const pixels = [];
    report.states = {};
    for (const [name, enabled] of startupOnly ? [] : [['off', 0], ['on', 1], ['restore', 0]]) {
      assert.equal(await page.evaluate(value => __webEngineRPC('WebDistanceFieldTest', value), enabled), 1);
      report.states[name] = await advance(240);
      assert.equal(report.states[name].fields.ao, enabled);
      report.states[name].gpuSamples = [];
      for (let sample = 0; sample < 12; ++sample)
        report.states[name].gpuSamples.push(await owner.evaluate(() => __dfSampleGPU()));
      report.states[name].adapterMemory = cp.execFileSync('nvidia-smi',
        ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], {encoding: 'utf8'}).trim();
      pixels.push(await capture(name));
    }
    const difference = (a, b) => {
      let total = 0, changed = 0;
      assert.equal(a.data.length, b.data.length);
      for (let index = 0; index < a.data.length; index += 4) {
        let delta = 0;
        for (let c = 0; c < 3; ++c) delta += Math.abs(a.data[index + c] - b.data[index + c]);
        total += delta;
        if (delta > 12) ++changed;
      }
      return {mean: total / (a.width * a.height * 3), fraction: changed / (a.width * a.height)};
    };
    if (!startupOnly) {
      report.contribution = difference(pixels[0], pixels[1]);
      report.restore = difference(pixels[0], pixels[2]);
      if (visualClock) {
        assert(report.contribution.mean > report.restore.mean * 2 && report.contribution.mean > 0.1,
          'DFAO contribution must exceed the restore residual');
        assert(report.restore.mean < 2, 'Restored state must remain visually close');
      }
    } else {
      report.running = await advance(240);
      assert(report.running.gpu.historyBindings > 100,
        'Normal startup must execute DFAO history reprojection');
      if (requireVelocity) {
        assert(report.running.gpu.textures.SceneVelocity, 'This regression must exercise the real velocity buffer');
        assert(report.running.gpu.historyVelocityBindings > 100,
          'DFAO must repeatedly bind the real velocity buffer with its history texture');
      }
      await capture('startup');
    }
    if (camera) {
      await page.evaluate(() => __webEngineRPC('WebDistanceFieldTest', 1));
      report.motion = [];
      for (let step = 0; step < 12; ++step) {
        const values = [...camera];
        values[0] += Math.sin(step / 11 * Math.PI) * 150;
        values[4] += step * 15;
        assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), values), 1);
        report.motion.push(await advance(10));
      }
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values),
        [-175, -80, 160, -5, 230]), 1);
      await advance(120);
      await capture('teleport');
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), camera), 1);
      await advance(240);
      await capture('motion-return');
    }
    if (startupOnly) {
      report.resizes = [];
      for (const viewport of [{width: 960, height: 540}, {width, height}]) {
        await page.setViewportSize(viewport);
        const value = await advance(90);
        assert.deepEqual(value.surface, viewport);
        assert.equal(value.view.width, viewport.width);
        assert.equal(value.view.height, viewport.height);
        assert.equal(value.fields.ao, 1);
        assert.equal(value.visualClock, null);
        report.resizes.push(value);
      }
      await capture('resize-return');
    }
    report.final = await advance(60);
    assert.deepEqual(report.final.surface, {width, height});
    assert.equal(report.final.view.width, width);
    assert.equal(report.final.view.height, height);
    assert.deepEqual(report.final.gpu?.errors, []);
    assert.deepEqual(report.final.gpu?.losses, []);
    assert.deepEqual(report.errors, []);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    if (page) report.final = await state().catch(() => null);
  } finally {
    await context?.close();
    const file = path.join(directory, `web-distance-field-${folder}-${channel}-${tag}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, report: file, final: report.final,
      contribution: report.contribution, errors: report.errors.slice(-4), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
