const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const requireExposure = process.argv.includes('--exposure');
const requireClouds = process.argv.includes('--clouds');
const requireFog = process.argv.includes('--fog');
const consoleCapture = process.argv.includes('--console=page') ? 'page' : 'cdp';
const reportSuffix = process.argv.find(argument => argument.startsWith('--report='))?.slice(9) || '';
assert(/^[a-z0-9-]*$/.test(reportSuffix));
const artifactSuffix = reportSuffix ? '-' + reportSuffix : '';
const requestedBrowser = process.argv.find(argument => argument.startsWith('--browser='))?.slice(10);
const browsers = [
  ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
  ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
].filter(([name]) => !requestedBrowser || name.toLowerCase() === requestedBrowser.toLowerCase());
assert(browsers.length, 'Use --browser=Chrome or --browser=Edge');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, exposureRequired: requireExposure,
  cloudsRequired: requireClouds, fogRequired: requireFog, consoleCapture,
  hostCondition: process.env.UE_WEB_TEST_HOST_CONDITION || 'default scheduling', browserRuns: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};

function capturePostprocess({exposureBindings, fogEntries, consoleCapture}) {
  const state = {textures: [], draws: {}, dispatches: {}, fogPipelines: [], deviceLosses: [], log: []};
  for (const method of consoleCapture === 'page' ? ['log', 'warn', 'error'] : []) {
    const original = console[method];
    console[method] = function(...args) {
      state.log.push(args.map(value => String(value)).join(' '));
      if (state.log.length > 24) state.log.shift();
      return original.apply(this, args);
    };
  }
  const observedDevices = new WeakSet();
  const textures = new Set();
  const pipelines = new WeakMap();
  const bound = new WeakMap();
  const bindGroups = new WeakMap();
  const boundGroups = new WeakMap();
  const volumeUploads = new Map();
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function(destination, data, layout, size) {
    const texture = destination.texture;
    if (texture.dimension === '3d' && texture.format === 'rgba16float' && /^VT_/.test(texture.label)) {
      const bytes = ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const [width, height, depth] = Array.isArray(size) ? size :
        [size.width, size.height || 1, size.depthOrArrayLayers || 1];
      const pitch = layout.bytesPerRow || width * 8;
      const rows = layout.rowsPerImage || height;
      const samples = [[0, 0, 0], [width >> 1, height >> 1, depth >> 1],
        [width - 1, height - 1, depth - 1]].map(([x, y, z]) => {
        const offset = (layout.offset || 0) + (z * rows + y) * pitch + x * 8;
        return {origin: {x, y, z}, expected: Array.from(bytes.subarray(offset, offset + 8))};
      });
      if (!volumeUploads.has(texture)) volumeUploads.set(texture, new Map());
      volumeUploads.get(texture).set(destination.mipLevel || 0, samples);
    }
    return writeTexture.call(this, destination, data, layout, size);
  };
  let volumeDevice;
  let exposure;
  const createBindGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(descriptor) {
    const group = createBindGroup.call(this, descriptor);
    bindGroups.set(group, {device: this, entries: descriptor.entries});
    return group;
  };
  const setBindGroup = GPUComputePassEncoder.prototype.setBindGroup;
  GPUComputePassEncoder.prototype.setBindGroup = function(index, group, ...args) {
    if (!boundGroups.has(this)) boundGroups.set(this, new Map());
    boundGroups.get(this).set(index, bindGroups.get(group));
    return setBindGroup.call(this, index, group, ...args);
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    if (!observedDevices.has(this)) {
      observedDevices.add(this);
      this.lost.then(info => state.deviceLosses.push({reason: info.reason, message: info.message}));
    }
    const texture = createTexture.call(this, descriptor);
    if (texture.dimension === '3d' && /^VT_/.test(texture.label)) volumeDevice = this;
    const key = JSON.stringify([texture.label, texture.format, texture.width, texture.height, texture.depthOrArrayLayers]);
    if (!textures.has(key)) {
      textures.add(key);
      state.textures.push({label: texture.label, format: texture.format, width: texture.width,
        height: texture.height, depth: texture.depthOrArrayLayers, dimension: texture.dimension,
        mips: texture.mipLevelCount});
    }
    return texture;
  };
  for (const [method, stage, encoder, commands, field] of [
    ['createRenderPipeline', 'fragment', GPURenderPassEncoder.prototype, ['draw', 'drawIndexed'], 'draws'],
    ['createComputePipeline', 'compute', GPUComputePassEncoder.prototype, ['dispatchWorkgroups'], 'dispatches']
  ]) {
    const create = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      const pipeline = create.call(this, descriptor);
      state.maxComputeSharedMemory = this.limits.maxComputeWorkgroupStorageSize;
      pipelines.set(pipeline, descriptor[stage]?.entryPoint || '');
      if (fogEntries.includes(descriptor[stage]?.entryPoint))
        state.fogPipelines.push({entry: descriptor[stage].entryPoint,
          depthStencil: descriptor.depthStencil, targets: descriptor.fragment.targets});
      return pipeline;
    };
    const set = encoder.setPipeline;
    encoder.setPipeline = function(pipeline) {
      bound.set(this, pipelines.get(pipeline));
      return set.call(this, pipeline);
    };
    for (const command of commands) {
      const execute = encoder[command];
      encoder[command] = function(...args) {
        const entry = bound.get(this);
        if (entry) state[field][entry] = (state[field][entry] || 0) + 1;
        const binding = exposureBindings[entry];
        if (field === 'dispatches' && binding) {
          const group = boundGroups.get(this)?.get(binding.group);
          const resource = group?.entries.find(item => item.binding === binding.binding)?.resource;
          if (resource?.buffer) exposure = {device: group.device, ...resource};
        }
        return execute.apply(this, args);
      };
    }
  }
  globalThis.__webPostprocess = state;
  globalThis.__webReadCloudVolumeMips = async () => {
    const results = [];
    for (const [texture, mips] of volumeUploads) {
      const entries = [...mips].flatMap(([mipLevel, samples]) =>
        samples.map(sample => ({mipLevel, ...sample})));
      const readback = volumeDevice.createBuffer({size: entries.length * 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      try {
        const encoder = volumeDevice.createCommandEncoder();
        entries.forEach((entry, index) => encoder.copyTextureToBuffer(
          {texture, mipLevel: entry.mipLevel, origin: entry.origin},
          {buffer: readback, offset: index * 256, bytesPerRow: 256, rowsPerImage: 1},
          {width: 1, height: 1, depthOrArrayLayers: 1}));
        volumeDevice.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const bytes = new Uint8Array(readback.getMappedRange());
        const checks = entries.map((entry, index) => ({...entry,
          actual: Array.from(bytes.subarray(index * 256, index * 256 + 8))}));
        results.push({texture: texture.label, mips: texture.mipLevelCount,
          checkedMips: mips.size, checks,
          pass: mips.size === texture.mipLevelCount && checks.every(check =>
            check.expected.length === 8 && check.expected.every((value, i) => value === check.actual[i]))});
        readback.unmap();
      } finally { readback.destroy(); }
    }
    return results;
  };
  globalThis.__webReadExposure = async () => {
    if (!exposure) return null;
    const {device, buffer, offset = 0} = exposure;
    const readback = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, offset, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const values = Array.from(new Float32Array(readback.getMappedRange()));
      readback.unmap();
      return {scale: values[0], targetScale: values[1], averageLuminance: values[2], compensation: values[3]};
    } finally { readback.destroy(); }
  };
}

(async () => {
  let browser;
  try {
    const packageFile = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && valid(packaged.buildReport) && valid(packaged.stageReport));
    report.package = audit(packageFile);
    const cookFile = path.join(directory, 'web-engine-webgpu-es31-default-cook-results.json');
    const cook = read(cookFile);
    assert(cook.pass && cook.minimalRendererSettingsVerified && valid(cook.minimalRendererConfig));
    for (const name of ['r.MobileHDR', 'r.Mobile.AntiAliasing']) {
      const setting = cook.shaderInventory.detail.settings[name];
      assert(setting.host === '1' && setting.target === '1', `${name} must match Cook and runtime`);
    }
    if (requireClouds) {
      for (const [name, value] of Object.entries({
        'r.VolumetricCloud.Support': '1', 'r.VolumetricCloud': '1', 'r.VolumetricRenderTarget': '1',
        'r.VolumetricRenderTarget.Mode': '0', 'r.VolumetricRenderTarget.UpsamplingMode': '4',
        'r.VolumetricCloud.DisableCompute': '1', 'r.VolumetricCloud.ShadowMap': '0',
        'r.VolumetricCloud.SkyAO': '0', 'r.VolumetricCloud.Shadow.SampleAtmosphericLightShadowmap': '0',
        'r.VolumetricCloud.HighQualityAerialPerspective': '0'
      })) {
        const setting = cook.shaderInventory.detail.settings[name];
        assert(setting?.host === value && setting?.target === value, `${name} must match Cook and runtime`);
      }
    }
    if (requireFog) {
      for (const [name, value] of Object.entries({
        'r.Mobile.DisableVertexFog': '1', 'r.Mobile.EarlyZPass': '1',
        'r.Mobile.PixelFogDepthTest': '1', 'r.SupportSkyAtmosphereAffectsHeightFog': '1',
        'r.Mobile.AllowFramebufferFetch': '0', 'r.SupportLocalFogVolumes': '0', 'r.VolumetricFog': '0'
      })) {
        const setting = cook.shaderInventory.detail.settings[name];
        assert(setting?.host === value && setting?.target === value, `${name} must match Cook and runtime`);
      }
    }
    report.cook = audit(cookFile);
    const shaders = new Map();
    const exposureBindings = {};
    // DDC hits can reuse a shader compiled by an earlier Cook. Entry names include its code hash.
    const cooks = path.join(__dirname, 'build/web-engine-webgpu-es31-default-cook');
    for (const entry of fs.readdirSync(cooks, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const conversions = path.join(cooks, entry.name, 'ShaderConversion');
      if (!fs.existsSync(conversions)) continue;
      for (const job of fs.readdirSync(conversions, {withFileTypes: true})) {
        if (!job.isDirectory()) continue;
        const input = path.join(conversions, job.name, 'input.json');
        const output = path.join(conversions, job.name, 'output.wgsl');
        if (!fs.existsSync(input) || !fs.existsSync(output)) continue;
        const detail = read(input);
        shaders.set(detail.metadata.webEntry, {name: detail.shaderName, shader: detail.shader,
          input, output});
        if (/FMobile(?:Histogram|Basic)EyeAdaptationCS/.test(detail.shaderName)) {
          const binding = detail.metadata.spirvBindings.find(item => item.name === 'OutputBuffer');
          assert(binding, 'Auto exposure output must have reflected storage buffer coordinates');
          exposureBindings[detail.metadata.webEntry] = {group: binding.group, binding: binding.binding};
        }
      }
    }
    for (const [name, executablePath] of browsers) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1100, height: 760}});
      const run = {browser: name, pass: false, errors: [], log: []};
      report.browserRuns.push(run);
      page.on('pageerror', error => run.errors.push(error.stack || error.message));
      if (consoleCapture === 'cdp') page.on('console', message => {
        run.log.push(message.text());
        if (run.log.length > 24) run.log.shift();
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.addInitScript(capturePostprocess, {exposureBindings, consoleCapture,
        fogEntries: [...shaders].filter(([, shader]) => shader.name === 'FMobileFogPS').map(([entry]) => entry)});
      if (requireFog) {
        await page.route('**/ue-default-template/index.html', async route => {
          const response = await route.fetch();
          const html = await response.text();
          const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
          assert(html.includes(original));
          await route.fulfill({response, body: html.replace(original,
            "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
        });
      }
      await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 120,
        null, {timeout: 90000});
      const result = await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure || null, frames: globalThis.__webEngineFrames || 0,
        gpuErrors: globalThis.__webCanvas.gpuErrors, state: globalThis.__webPostprocess
      }));
      Object.assign(run, result);
      if (consoleCapture === 'page') run.log = result.state.log;
      assert.equal(result.failure, null);
      assert.equal(run.errors.length, 0);
      assert.equal(result.gpuErrors.length, 0);
      assert.equal(result.state.deviceLosses.length, 0);
      assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      run.executedShaders = {};
      for (const field of ['draws', 'dispatches']) {
        run.executedShaders[field] = Object.entries(result.state[field]).map(([entry, count]) => {
          const shader = shaders.get(entry);
          return {entry, count, name: shader?.name || null, shader: shader?.shader || null,
            ...(shader ? {input: audit(shader.input), output: audit(shader.output)} : {})};
        });
      }
      const executed = run.executedShaders.draws;
      run.hdrSceneColor = result.state.textures.filter(texture =>
        /SceneColor/.test(texture.label) && texture.format === 'rgba16float');
      run.tonemap = executed.filter(shader => shader.name === 'FTonemapPS');
      run.fxaa = executed.filter(shader => /FXAA/i.test(shader.name || ''));
      run.bloom = executed.filter(shader => /FMobileBloom(?:Setup|Down|Up)PS/.test(shader.name || ''));
      run.colorLUT = run.executedShaders.dispatches.filter(shader => shader.name === 'FLUTBlenderCS');
      assert(run.hdrSceneColor.length, 'The scene must render into an actual HDR floating-point texture');
      assert(run.tonemap.length, 'The UE tonemapper must actually draw');
      assert(run.fxaa.length, 'The UE FXAA pass must actually draw');
      assert.equal(run.bloom.length, 3, 'The UE bloom setup, downsample and upsample passes must actually draw');
      assert(run.colorLUT.length, 'The UE color grading LUT must actually dispatch');
      if (requireClouds) {
        run.clouds = {shaders: executed.filter(shader => /^FCloudRenderViewPS/.test(shader.name || '')),
          volumes: result.state.textures.filter(texture => texture.dimension === '3d' &&
            texture.format === 'rgba16float' && /VT_/.test(texture.label))};
        assert(run.clouds.shaders.length, 'The original UE volume cloud material must actually draw');
        assert(run.clouds.volumes.length, 'The cooked UE cloud noise must be uploaded as a real linear volume');
        assert(run.clouds.shaders.some(shader => /Material_\w+\s*:\s*texture_3d/.test(
          fs.readFileSync(shader.output.file, 'utf8'))), 'The cloud material must actually sample its volume noise');
        run.clouds.volumeReadbacks = await page.evaluate(() => globalThis.__webReadCloudVolumeMips());
        assert(run.clouds.volumeReadbacks.length >= 2 &&
          run.clouds.volumeReadbacks.every(result => result.pass) &&
          run.clouds.volumeReadbacks.some(result => result.mips > 1),
        'The actual cloud volume uploads must match GPU readback at every mip');
        const cloudCount = () => page.evaluate(entries => entries.reduce((sum, entry) =>
          sum + (globalThis.__webPostprocess.draws[entry] || 0), 0),
        run.clouds.shaders.map(shader => shader.entry));
        const advance = async frames => {
          const start = await page.evaluate(() => globalThis.__webEngineFrames);
          await page.waitForFunction(frame => globalThis.__webEngineFailure ||
            globalThis.__webEngineFrames >= frame, start + frames, {timeout: 90000});
          assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
          assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
        };
        const capture = async label => {
          const file = path.join(directory, `web-default-cloud-${label}-${name.toLowerCase()}${artifactSuffix}.png`);
          await page.locator('canvas').screenshot({path: file});
          return {file: audit(file), pixels: PNG.sync.read(fs.readFileSync(file))};
        };
        const delta = (first, second) => {
          let total = 0, changed = 0, count = 0;
          for (let y = 2; y < first.height * 0.4; ++y)
          for (let x = 2; x < first.width - 2; ++x) {
            const offset = (y * first.width + x) * 4;
            let value = 0;
            for (let c = 0; c < 3; ++c)
              value += Math.abs(first.data[offset + c] - second.data[offset + c]);
            total += value / 3;
            changed += value > 30;
            ++count;
          }
          return {mean: total / count, changedFraction: changed / count};
        };
        await advance(120);
        const normal = await capture('on');
        assert.equal(await page.evaluate(() => Module._WebDefaultSceneTestMode(4)), 1);
        await advance(30);
        const offStart = await cloudCount();
        await advance(120);
        const offEnd = await cloudCount();
        const disabled = await capture('off');
        run.clouds.disabledDraws = offEnd - offStart;
        run.clouds.difference = delta(normal.pixels, disabled.pixels);
        assert.equal(run.clouds.disabledDraws, 0, 'Hiding the original cloud component must stop cloud draws');
        assert(run.clouds.difference.mean > 2 && run.clouds.difference.changedFraction > 0.08,
          'Disabling clouds must visibly change the sky');
        assert.equal(await page.evaluate(() => Module._WebDefaultSceneTestMode(0)), 1);
        await advance(120);
        const restored = await capture('restored');
        run.clouds.restoredDraws = await cloudCount() - offEnd;
        run.clouds.restoredDifference = delta(normal.pixels, restored.pixels);
        run.clouds.screenshots = {normal: normal.file, disabled: disabled.file, restored: restored.file};
        assert(run.clouds.restoredDraws > 30, 'Restoring the original component must resume cloud draws');
        assert(run.clouds.restoredDifference.mean < run.clouds.difference.mean * 0.5,
          'Restoring clouds must recover the original sky');
      }
      if (requireFog) {
        run.fog = {shaders: executed.filter(shader => shader.name === 'FMobileFogPS'),
          pipelines: result.state.fogPipelines};
        assert(run.fog.shaders.length, 'UE mobile pixel fog must actually draw');
        assert(run.fog.pipelines.length && run.fog.pipelines.every(pipeline =>
          pipeline.depthStencil?.format === 'depth24plus-stencil8' &&
          pipeline.depthStencil.depthCompare === 'greater-equal' &&
          pipeline.depthStencil.stencilFront?.compare === 'not-equal' &&
          pipeline.depthStencil.stencilReadMask !== 0 &&
          pipeline.targets[0].blend?.color.dstFactor === 'src-alpha'),
        'Fog must preserve the UE depth test, sky stencil exclusion and transmittance blending');
        const clock = await page.evaluate(() => globalThis.__webVisualTestClock);
        assert(clock?.renderTimeFrozen && clock.deltaSeconds > 0.00001);
        run.fog.clock = clock;
        const count = () => page.evaluate(entries => entries.reduce((sum, entry) =>
          sum + (globalThis.__webPostprocess.draws[entry] || 0), 0), run.fog.shaders.map(shader => shader.entry));
        const capture = async (mode, label) => {
          assert.equal(await page.evaluate(value => Module._WebDefaultFogTestMode(value), mode), 1,
            'The original template must contain exactly one height fog component');
          let previous, stable = 0;
          for (let i = 0; i < 48; ++i) {
            await page.waitForTimeout(250);
            assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
            const value = await page.evaluate(() => globalThis.__webReadExposure());
            assert(value && value.scale > 0);
            stable = previous && Math.abs(value.scale - previous.scale) / value.scale < 0.002 &&
              Math.abs(value.scale - value.targetScale) / value.scale < 0.02 ? stable + 1 : 0;
            previous = value;
            if (stable >= 3) break;
          }
          assert(stable >= 3, 'Fog comparisons must wait for automatic exposure to converge');
          assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
          const file = path.join(directory, `web-default-fog-${label}-${name.toLowerCase()}${artifactSuffix}.png`);
          const image = await page.locator('canvas').screenshot({path: file});
          return {file: audit(file), pixels: PNG.sync.read(image), exposure: previous,
            component: await page.evaluate(() => globalThis.__webDefaultFog)};
        };
        const delta = (a, b, minY, maxY) => {
          let total = 0, changed = 0, samples = 0;
          for (let y = Math.ceil(a.height * minY); y < a.height * maxY; ++y)
          for (let x = Math.ceil(a.width * 0.1); x < a.width * 0.9; ++x) {
            const offset = (y * a.width + x) * 4;
            let value = 0;
            for (let c = 0; c < 3; ++c) value += Math.abs(a.data[offset + c] - b.data[offset + c]);
            total += value / 3;
            changed += value > 3;
            ++samples;
          }
          return {mean: total / samples, changedFraction: changed / samples};
        };
        const contrast = (image, minY, maxY) => {
          let total = 0, samples = 0;
          for (let y = Math.ceil(image.height * minY); y < image.height * maxY; ++y)
          for (let x = Math.ceil(image.width * 0.1); x < image.width * 0.9; ++x) {
            const offset = (y * image.width + x) * 4;
            for (let c = 0; c < 3; ++c)
              total += Math.abs(image.data[offset + c] - image.data[offset + c + 4]);
            samples += 3;
          }
          return total / samples;
        };
        const normal = await capture(0, 'on');
        assert(Math.abs(normal.component.density - 0.0436) < 0.0001 &&
          Math.abs(normal.component.heightFalloff - 0.2) < 0.0001 &&
          normal.component.visible && !normal.component.volumetric,
        'Use the original default map fog values without enabling volumetric fog');
        const disabled = await capture(1, 'off');
        run.fog.difference = delta(normal.pixels, disabled.pixels, 0.48, 0.98);
        run.fog.nearDifference = delta(normal.pixels, disabled.pixels, 0.85, 0.98);
        run.fog.farDifference = delta(normal.pixels, disabled.pixels, 0.48, 0.6);
        assert(run.fog.difference.mean > 0.5 && run.fog.difference.changedFraction > 0.1,
          'Hiding the original fog must visibly change the rendered ground');
        // Exposure changes global brightness; compare checker contrast instead of absolute pixel deltas.
        run.fog.contrast = Object.fromEntries([['far', 0.48, 0.6], ['near', 0.85, 0.98]]
          .map(([key, minY, maxY]) => {
            const on = contrast(normal.pixels, minY, maxY);
            const off = contrast(disabled.pixels, minY, maxY);
            return [key, {on, off, ratio: on / off}];
          }));
        assert(run.fog.contrast.far.ratio < run.fog.contrast.near.ratio &&
          run.fog.contrast.far.ratio < 1,
        'Fog must reduce distant checker contrast more than nearby checker contrast');
        const dense = await capture(2, 'dense');
        assert(Math.abs(dense.component.density - normal.component.density * 2) < 0.0001);
        run.fog.densityDifference = delta(normal.pixels, dense.pixels, 0.48, 0.98);
        assert(run.fog.densityDifference.mean > 0.5, 'Increasing fog density must affect the rendered ground');
        const distant = await capture(3, 'start-distance');
        assert.equal(distant.component.startDistance, 50000);
        run.fog.startDistanceDifference = delta(normal.pixels, distant.pixels, 0.48, 0.98);
        assert(run.fog.startDistanceDifference.mean > 0.5,
          'Moving the fog start beyond the floor must affect the rendered ground');
        const falloff = await capture(4, 'height-falloff');
        assert(Math.abs(falloff.component.heightFalloff - normal.component.heightFalloff * 4) < 0.0001);
        run.fog.heightFalloffDifference = delta(normal.pixels, falloff.pixels, 0.48, 0.98);
        assert(run.fog.heightFalloffDifference.mean > 0.1, 'Height falloff must affect the rendered ground');
        const restored = await capture(0, 'restored');
        run.fog.restoredDifference = delta(normal.pixels, restored.pixels, 0.48, 0.98);
        assert(run.fog.restoredDifference.mean < run.fog.difference.mean * 0.25,
          'Restoring the original fog must recover the ground appearance');
        const start = await count();
        const frames = await page.evaluate(() => globalThis.__webEngineFrames);
        await page.waitForFunction(frame => globalThis.__webEngineFrames >= frame + 60,
          frames, {timeout: 60000});
        run.fog.restoredDraws = await count() - start;
        assert(run.fog.restoredDraws >= 60, 'Restored fog must keep drawing on consecutive frames');
        run.fog.controls = Object.fromEntries(Object.entries({normal, disabled, dense, distant, falloff, restored})
          .map(([key, value]) => [key, {screenshot: value.file, exposure: value.exposure, component: value.component}]));
        assert.equal((await page.evaluate(() => globalThis.__webCanvas.gpuErrors)).length, 0);
        assert.equal(run.errors.length, 0);
      }
      if (requireExposure) {
        run.eyeAdaptation = run.executedShaders.dispatches.filter(shader =>
          /FMobile(?:Histogram|Basic)EyeAdaptationCS/.test(shader.name || ''));
        assert(run.eyeAdaptation.length, 'The UE mobile auto exposure must actually dispatch');
        const sample = async () => {
          const value = await page.evaluate(() => globalThis.__webReadExposure());
          assert(value && Object.values(value).every(Number.isFinite) &&
            value.scale > 0 && value.averageLuminance > 0, 'The GPU exposure result must be finite and positive');
          return value;
        };
        const settle = async mode => {
          assert.equal(await page.evaluate(value => Module._WebDefaultSceneTestMode(value), mode), 1);
          let last;
          for (let i = 0; i < 40; ++i) {
            await page.waitForTimeout(250);
            const value = await sample();
            if (last && Math.abs(value.scale - last.scale) / value.scale < 0.005 &&
                Math.abs(value.scale - value.targetScale) / value.scale < 0.02) return value;
            last = value;
          }
          assert.fail('Exposure must converge within ten seconds');
        };
        run.exposure = {normal: await settle(0)};
        run.exposure.dimmedSun = await settle(3);
        assert(run.exposure.dimmedSun.averageLuminance < run.exposure.normal.averageLuminance * 0.9 &&
          run.exposure.dimmedSun.scale > run.exposure.normal.scale * 1.1,
          'Dimming the original sunlight must lower measured luminance and increase exposure');
        run.exposure.restored = await settle(0);
        assert(Math.abs(run.exposure.restored.scale - run.exposure.normal.scale) / run.exposure.normal.scale < 0.05,
          'Restoring the original light must restore the measured exposure');
        assert.equal((await page.evaluate(() => globalThis.__webCanvas.gpuErrors)).length, 0);
      }
      const screenshot = path.join(directory, `web-default-postprocess-${name.toLowerCase()}${artifactSuffix}.png`);
      await page.locator('canvas').screenshot({path: screenshot});
      run.screenshot = audit(screenshot);
      run.finalFrames = await page.evaluate(() => globalThis.__webEngineFrames);
      run.deviceLosses = await page.evaluate(() => globalThis.__webPostprocess.deviceLosses);
      assert.equal(run.deviceLosses.length, 0);
      if (consoleCapture === 'page') run.log = await page.evaluate(() => globalThis.__webPostprocess.log);
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.pass = report.browserRuns.length === browsers.length && report.browserRuns.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-default-postprocess${reportSuffix ? '-' + reportSuffix : ''}-results.json`),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure,
      runs: report.browserRuns.map(run => ({browser: run.browser, pass: run.pass, frames: run.frames,
        finalFrames: run.finalFrames, failure: run.failure, errors: run.errors, gpuErrors: run.gpuErrors,
        ...(!run.pass ? {log: run.log} : {}), exposure: run.exposure,
        fog: run.fog && {shaders: run.fog.shaders.map(shader => shader.name),
          difference: run.fog.difference, nearDifference: run.fog.nearDifference,
          farDifference: run.fog.farDifference, densityDifference: run.fog.densityDifference,
          startDistanceDifference: run.fog.startDistanceDifference,
          heightFalloffDifference: run.fog.heightFalloffDifference,
          restoredDifference: run.fog.restoredDifference, restoredDraws: run.fog.restoredDraws},
        clouds: run.clouds && {shaders: run.clouds.shaders.map(shader => shader.name),
          volumeReadbacks: run.clouds.volumeReadbacks?.map(result => ({
            texture: result.texture, checkedMips: result.checkedMips, samples: result.checks.length, pass: result.pass})),
          disabledDraws: run.clouds.disabledDraws, restoredDraws: run.clouds.restoredDraws,
          difference: run.clouds.difference, restoredDifference: run.clouds.restoredDifference},
        hdrSceneColor: run.hdrSceneColor, tonemapDraws: run.tonemap?.reduce((sum, shader) => sum + shader.count, 0),
        fxaaDraws: run.fxaa?.reduce((sum, shader) => sum + shader.count, 0)}))}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
