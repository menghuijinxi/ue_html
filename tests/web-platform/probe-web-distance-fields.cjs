const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
const shaderCapture = process.argv.includes('--shader-capture');
const shaderOverridesFile = process.argv.find(value => value.startsWith('--shader-overrides='))?.slice(19);
const shaderOverrides = shaderOverridesFile ? JSON.parse(fs.readFileSync(shaderOverridesFile, 'utf8')) : [];
const engineArgsFile = process.argv.find(value => value.startsWith('--engine-args='))?.slice(14);
const engineArgs = engineArgsFile ? JSON.parse(fs.readFileSync(engineArgsFile, 'utf8')) : [];
const rendererSettingsFile = process.argv.find(value => value.startsWith('--renderer-settings='))?.slice(20);
const rendererSettings = rendererSettingsFile ?
  JSON.parse(fs.readFileSync(rendererSettingsFile, 'utf8')) : {};
assert(rendererSettings && !Array.isArray(rendererSettings) && typeof rendererSettings === 'object');
assert(Object.entries(rendererSettings).every(([name, value]) =>
  /^(?:r|landscape)\.[A-Za-z0-9.]+$/.test(name) && Number.isFinite(value)));
assert(Array.isArray(engineArgs) && engineArgs.every(value => typeof value === 'string'));
assert(!engineArgs.some(value => /^-ini:/i.test(value)),
  'The browser launcher does not forward -ini overrides; use --renderer-settings instead');
assert(Array.isArray(shaderOverrides) && shaderOverrides.every(value =>
  typeof value.contains === 'string' && typeof value.pattern === 'string' && typeof value.replacement === 'string'));
if (shaderOverridesFile)
  console.log('Diagnostic shader overrides are active; this run cannot validate the shipped shaders.');
assert(!startupOnly || !visualClock, 'Startup regression must use the normal render clock');
assert(!requireVelocity || startupOnly, '--require-velocity requires --startup-only');
const packageFile = path.join(directory, folder.startsWith('ue-default-template') ?
  `web-default-template${folder.slice('ue-default-template'.length)}-package-results.json` :
  `web-project-${folder}-package-results.json`);
const camera = process.argv.find(value => value.startsWith('--camera='))?.slice(9).split(',').map(Number);
const fixedEV = process.argv.find(value => value.startsWith('--fixed-ev='))?.slice(11);
const casesFile = process.argv.find(value => value.startsWith('--cases='))?.slice(8);
const width = Number(process.argv.find(value => value.startsWith('--width='))?.slice(8) || 1280);
const height = Number(process.argv.find(value => value.startsWith('--height='))?.slice(9) || 720);
const tag = process.argv.find(value => value.startsWith('--tag='))?.slice(6) || `${width}x${height}`;
assert(/^[a-z0-9-]+$/.test(tag));
assert(!camera || camera.length === 5 && camera.every(Number.isFinite));
assert(width >= 320 && width <= 3840 && height >= 240 && height <= 2160);
const report = {date: new Date().toISOString(), pass: false, folder, channel, visualClock, startupOnly, requireVelocity,
  errors: [], logs: [], images: [],
  source: audit(__filename), boundary: 'Browser candidate. GPU pass sums omit copies and gaps; adapter memory includes other apps. Image differences are not a quality score or proof of native parity.'};
if (shaderOverridesFile) {
  report.shaderOverrides = audit(shaderOverridesFile);
  report.boundary += ' Diagnostic shader replacements are active; this run does not validate the shipped shaders.';
}
if (engineArgsFile) report.engineArguments = {source: audit(engineArgsFile), arguments: engineArgs};
if (rendererSettingsFile) {
  report.rendererSettings = {source: audit(rendererSettingsFile), values: rendererSettings};
  report.boundary += ' Diagnostic runtime renderer configuration is active; this run does not validate the shipped defaults.';
}
let context, page;
const liveFile = path.join(directory, `distance-field-${channel}-${tag}-live.log`);
fs.writeFileSync(liveFile, '');
const trace = text => fs.appendFileSync(liveFile, `${new Date().toISOString()} ${text}\n`);
const deadline = setTimeout(() => {
  report.failure = 'Browser regression exceeded the five-minute deadline; inspect the live log';
  report.pass = false;
  fs.writeFileSync(path.join(directory, `web-distance-field-${folder}-${channel}-${tag}-results.json`),
    JSON.stringify(report, null, 2));
  console.error(report.failure);
  context?.close().catch(() => {}).finally(() => process.exit(1));
  setTimeout(() => process.exit(1), 5000);
}, 300000);
const state = () => page.evaluate(() => ({failure: globalThis.__webEngineFailure,
  frames: globalThis.__webEngineFrames || 0, ready: globalThis.__webEngineReady,
  fields: globalThis.__webDistanceFields, gpu: globalThis.__webDistanceFieldsGPU,
  exposure: globalThis.__webDistanceFieldsExposure,
  lighting: globalThis.__webDistanceFieldsLighting,
  view: globalThis.__webRenderView, threads: globalThis.__webEngineThreads,
  io: globalThis.__webLocalContentStats, surface: globalThis.__webEngineSurface,
  visualClock: globalThis.__webVisualTestClock || null,
  memory: globalThis.__webTextureStreaming, camera: globalThis.__webDefaultCamera}));
async function advance(count) {
  trace(`advance ${count}: reading state`);
  const before = await state();
  trace(`advance ${count}: frame ${before.frames}`);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    (globalThis.__webEngineFrames || 0) >= target, before.frames + count, {timeout: 90000});
  const value = await state();
  trace(`advance ${count}: reached ${value.frames}`);
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
    page.on('pageerror', error => {report.errors.push(error.message); trace(error.stack || error.message);});
    page.on('console', message => {
      const text = message.text();
      trace(text);
      report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text))
        report.errors.push(text);
    });
    if (rendererSettingsFile) await context.route('**/config-files.json', async route => {
      const response = await route.fetch();
      const configs = await response.json();
      const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      assert(config, 'Renderer configuration must exist');
      let text = Buffer.from(config.data, 'base64').toString('utf8');
      assert(text.includes('[SystemSettings]'));
      report.rendererSettings.originalConfig = config.sha256;
      for (const name of Object.keys(rendererSettings)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`^${escaped}=.*\\r?\\n?`, 'gm'), '');
      }
      text = text.replace('[SystemSettings]', '[SystemSettings]\n' +
        Object.entries(rendererSettings).map(([name, value]) => `${name}=${value}`).join('\n'));
      config.data = Buffer.from(text).toString('base64');
      config.sha256 = crypto.createHash('sha256').update(text).digest('hex');
      report.rendererSettings.runtimeConfig = config.sha256;
      await route.fulfill({response, body: JSON.stringify(configs)});
    });
    await page.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `
        globalThis.__webDistanceFieldsGPU = {textures: {}, compute: {}, raster: {}, errors: [], losses: [],
          historyBindings: 0, historyVelocityBindings: 0, ssrDraws: 0, ssaoDraws: 0,
          cubeShadowDraws: 0, cubeShadowCopies: {}};
        const dfPipelines = new WeakMap(), dfPasses = new WeakMap(), dfViews = new WeakMap();
        const dfSSRModules = new WeakSet(), dfSSREntries = new Set();
        const dfSSAOModules = new WeakSet(), dfSSAOEntries = new Set();
        const dfCubeShadowModules = new WeakSet(), dfCubeShadowEntries = new Set();
        {
          globalThis.__dfShaderSources = {};
          globalThis.__dfShaderOverrides = [];
          const dfOverrides = ${JSON.stringify(shaderOverrides)};
          const dfModule = GPUDevice.prototype.createShaderModule;
          GPUDevice.prototype.createShaderModule = function(descriptor) {
            let code = descriptor.code;
            for (const override of dfOverrides) {
              if (!code.includes(override.contains)) continue;
              const expression = new RegExp(override.pattern, 'g');
              const count = [...code.matchAll(expression)].length;
              if (!count) throw new Error('Diagnostic shader override did not match: ' + override.contains);
              code = code.replace(expression, override.replacement);
              __dfShaderOverrides.push({contains: override.contains, count});
            }
            descriptor = {...descriptor, code};
            const entry = descriptor.code.match(/fn (main\\w*)\\(/)?.[1];
            if (${shaderCapture} && entry) __dfShaderSources[entry] = descriptor.code;
            const module = dfModule.call(this, descriptor);
            if (descriptor.code.includes('SSRParams')) dfSSRModules.add(module);
            if (descriptor.code.includes('ScreenSpaceAOParams')) dfSSAOModules.add(module);
            if (descriptor.code.includes('PointLightDepthBias')) dfCubeShadowModules.add(module);
            return module;
          };
        }
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
            if (descriptor.fragment && dfSSRModules.has(descriptor.fragment.module))
              dfSSREntries.add(descriptor.fragment.entryPoint);
            if (descriptor.fragment && dfSSAOModules.has(descriptor.fragment.module))
              dfSSAOEntries.add(descriptor.fragment.entryPoint);
            if (descriptor.fragment && dfCubeShadowModules.has(descriptor.fragment.module))
              dfCubeShadowEntries.add(descriptor.fragment.entryPoint);
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
              if (category === 'raster' && dfSSREntries.has(entry)) ++__webDistanceFieldsGPU.ssrDraws;
              if (category === 'raster' && dfSSAOEntries.has(entry)) ++__webDistanceFieldsGPU.ssaoDraws;
              if (category === 'raster' && dfCubeShadowEntries.has(entry)) ++__webDistanceFieldsGPU.cubeShadowDraws;
              return original.apply(this, args);
            };
          }
        }
        const dfTexture = GPUDevice.prototype.createTexture;
        GPUDevice.prototype.createTexture = function(descriptor) {
          if (/DistanceField|GlobalDistance|BentNormal|SceneVelocity|SSR|ScreenSpaceReflections|ScreenSpaceAO|GGX\\.LTC|Sheen\\.LTC|CubeShadow|WebCubeShadow/.test(descriptor.label || ''))
            __webDistanceFieldsGPU.textures[descriptor.label] = {
              size: descriptor.size, format: descriptor.format, dimension: descriptor.dimension,
              mipLevelCount: descriptor.mipLevelCount
            };
          return dfTexture.call(this, descriptor);
        };
        const dfCopyTexture = GPUCommandEncoder.prototype.copyTextureToTexture;
        GPUCommandEncoder.prototype.copyTextureToTexture = function(source, destination, size) {
          if (source.texture.label === 'WebCubeShadowFace' && destination.texture.label === 'CubeShadowDepthZ') {
            const face = destination.origin?.z ?? destination.origin?.[2] ?? 0;
            const counts = __webDistanceFieldsGPU.cubeShadowCopies;
            counts[face] = (counts[face] || 0) + 1;
          }
          return dfCopyTexture.call(this, source, destination, size);
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
    if (visualClock || engineArgs.length) await page.route('**/index.html', async route => {
      const response = await route.fetch();
      const source = await response.text();
      assert(source.includes("arguments: ['-webgpu',"));
      const args = [...(visualClock ? ['-WebVisualTestClock'] : []), ...engineArgs, '-webgpu'];
      await route.fulfill({response, body: source.replace("arguments: ['-webgpu',",
        `arguments: [${args.map(value => JSON.stringify(value)).join(',')},`)});
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    trace('navigation committed');
    report.startup = await advance(90);
    if (rendererSettingsFile) {
      assert(report.rendererSettings.runtimeConfig, 'Diagnostic renderer configuration must be fetched');
      for (const [name, value] of Object.entries(rendererSettings))
        assert(report.logs.some(text => text.includes(`Set CVar [[${name}:${value}]]`)),
          `Diagnostic renderer setting must reach the engine: ${name}=${value}`);
    }
    if (!visualClock) assert.equal(report.startup.visualClock, null, 'Normal startup must not freeze rendering');
    assert(report.startup.fields?.meshes > 0, 'Cooked mesh distance fields must be loaded');
    assert.equal(report.startup.fields.ao, 1, 'The shipped page must start with DFAO enabled');
    const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js'));
    assert(owner);
    if (casesFile) {
      assert(!visualClock && !startupOnly && !camera, 'Quality cases use the normal clock and their own cameras');
      const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8').replace(/^\uFEFF/, ''));
      report.casesSource = audit(casesFile);
      report.cases = [];
      for (const entry of cases) {
        assert(/^[a-z0-9-]+$/.test(entry.name));
        if (entry.camera) {
          trace(`case ${entry.name}: setting camera`);
          assert.equal(entry.camera.length, 5);
          assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), entry.camera), 1);
          await advance(30);
          if (entry.ev100 !== undefined)
            assert.equal(await page.evaluate(value => __webEngineRPC('WebDistanceFieldTestExposure', value), entry.ev100), 1);
        }
        for (const control of entry.controls || [])
          assert.equal(await page.evaluate(values => __webEngineRPC('WebLightingQualityTest', ...values), control), 1);
        const valueBeforeSSR = (await state()).gpu.ssrDraws;
        const valueBeforeSSAO = (await state()).gpu.ssaoDraws;
        const valueBeforeCubeShadow = (await state()).gpu.cubeShadowDraws;
        await advance(entry.frames || 180);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', -1, 0)), 1);
        await advance(2);
        const current = await state();
        if (entry.requireDFAO)
          assert.equal(current.fields.ao, 1, 'Quality regression must keep DFAO enabled');
        if (entry.requireSSR) {
          assert(current.gpu.ssrDraws > valueBeforeSSR, 'SSR must draw during this case');
          assert(current.gpu.textures.ScreenSpaceReflections, 'SSR color output must exist');
        }
        if (entry.requireSSAO)
          assert(current.gpu.ssaoDraws > valueBeforeSSAO, 'SSAO must draw during this case');
        if (entry.requireCubeShadows) {
          assert(current.gpu.cubeShadowDraws > valueBeforeCubeShadow,
            'Point/rect cubemap shadows must project during this case');
          for (let face = 0; face < 6; ++face)
            assert(current.gpu.cubeShadowCopies[face] > 0, `Cubemap shadow face ${face} must be rendered and copied`);
        }
        if (entry.requireLTC)
          for (const [name, format, size] of [['GGX.LTCMat', 'rgba16float', 64],
            ['GGX.LTCAmp', 'rg16float', 64], ['Sheen.LTC', 'rgba16float', 32]]) {
            const texture = current.gpu.textures[name];
            assert.equal(texture?.format, format, `${name}: lookup texture format`);
            assert.equal(texture.size.width, size, `${name}: lookup texture width`);
            assert.equal(texture.size.height, size, `${name}: lookup texture height`);
          }
        for (const [key, expected] of Object.entries(entry.expect || {}))
          assert.equal(current.lighting[key], expected, `${entry.name}: ${key}`);
        const png = await capture(entry.name);
        const regions = {};
        for (const [name, rect] of Object.entries(entry.regions || {})) {
          assert(rect.length === 4 && rect.every(Number.isFinite) &&
            rect[0] >= 0 && rect[1] >= 0 && rect[2] > 0 && rect[3] > 0 &&
            rect[0] + rect[2] <= 1 && rect[1] + rect[3] <= 1, `Invalid region: ${name}`);
          let sum = 0, count = 0, black = 0;
          const [x, y, w, h] = rect.map((v, i) => Math.round(v * (i % 2 ? png.height : png.width)));
          for (let py = y; py < y + h; ++py)
            for (let px = x; px < x + w; ++px) {
              const offset = (py * png.width + px) * 4;
              const luminance = (png.data[offset] + png.data[offset + 1] + png.data[offset + 2]) / 3;
              sum += luminance; ++count;
              if (luminance < 12) ++black;
            }
          regions[name] = {mean: sum / count, blackFraction: black / count};
        }
        report.cases.push({entry, state: current, regions,
          ssrDraws: current.gpu.ssrDraws - valueBeforeSSR,
          cubeShadowDraws: current.gpu.cubeShadowDraws - valueBeforeCubeShadow,
          ssaoDraws: current.gpu.ssaoDraws - valueBeforeSSAO});
        console.log(JSON.stringify({case: entry.name, lighting: current.lighting, regions}));
        for (const [name, limits] of Object.entries(entry.regionLimits || {})) {
          const measured = regions[name];
          assert(measured, `Missing measured region: ${name}`);
          if (limits.minMean !== undefined)
            assert(measured.mean >= limits.minMean, `${entry.name}/${name}: ${measured.mean} < ${limits.minMean}`);
          if (limits.maxBlackFraction !== undefined)
            assert(measured.blackFraction <= limits.maxBlackFraction,
              `${entry.name}/${name}: black fraction ${measured.blackFraction} > ${limits.maxBlackFraction}`);
        }
      }
      report.final = await advance(60);
      if (shaderOverrides.length) {
        report.appliedShaderOverrides = await owner.evaluate(() => globalThis.__dfShaderOverrides);
        assert(report.appliedShaderOverrides.length > 0, 'Diagnostic overrides must execute');
      }
      assert.deepEqual(report.final.gpu?.errors, []);
      assert.deepEqual(report.final.gpu?.losses, []);
      assert.deepEqual(report.errors, []);
      report.pass = true;
      return;
    }
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
    if (shaderCapture && page) {
      const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js'));
      if (owner) {
        const sources = await owner.evaluate(() => globalThis.__dfShaderSources).catch(() => null);
        if (sources) {
          const file = path.join(directory, `distance-field-${channel}-${tag}-shaders.json`);
          fs.writeFileSync(file, JSON.stringify(sources));
          report.shaders = audit(file);
        }
      }
    }
    await context?.close();
    clearTimeout(deadline);
    report.liveLog = audit(liveFile);
    const file = path.join(directory, `web-distance-field-${folder}-${channel}-${tag}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, report: file, final: report.final,
      contribution: report.contribution, errors: report.errors.slice(-4), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
