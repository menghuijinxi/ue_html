const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const crypto = require('node:crypto');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('report') || 'baseline';
const folder = option('folder') || 'ue-default-template';
const settings = option('settings');
const scale = Number(option('scale') || 1.5);
const checkClouds = process.argv.includes('--cloud-check');
const expectTAA = process.argv.includes('--expect-taa');
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder) &&
  [1, 1.5, 2].includes(scale));
const report = {date: new Date().toISOString(), pass: false, folder, scale, settings,
  temporalAAVerified: false, cloudOcclusionVerified: false,
  browser: process.argv.includes('--edge') ? 'Edge' : 'Chrome', errors: [], views: [],
  sourceFiles: [audit(__filename)],
  products: ['index.html', 'UEWebEngine.js', 'UEWebEngine.wasm', 'config-files.json'].map(name =>
    audit(path.join(__dirname, 'build', folder, name)))};
let browser;
(async () => {
  try {
    browser = await chromium.launch({headless: true, executablePath: process.argv.includes('--edge') ?
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
      'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page = await browser.newPage({viewport: {width: 3840 / scale, height: 2160 / scale},
      deviceScaleFactor: scale});
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      if (/GPU validation|Fatal error|Assertion failed|DeviceLost/.test(text)) report.errors.push(text);
      if (/ScreenPercentage|AntiAliasing|VolumetricRenderTarget/.test(text))
        (report.settingsLog ||= []).push(text);
    });
    const entries = {};
    const rememberShader = input => {
      if (!input.metadata?.webEntry) return;
      const permutation = Number(input.shader?.match(/^Global\/FTemporalAACS\/(\d+):/)?.[1]);
      entries[input.metadata.webEntry] = {name: input.shaderName,
        mainTAA: input.shaderName === 'FTemporalAACS' && Math.floor(permutation / 2) % 8 <= 2};
    };
    const modules = JSON.parse(fs.readFileSync(path.join(directory,
      'web-desktop-shader-modules-results.json'), 'utf8'));
    report.shaderModulesReport = audit(path.join(directory, 'web-desktop-shader-modules-results.json'));
    for (const shader of modules.shaders) {
      const input = JSON.parse(fs.readFileSync(path.join(path.dirname(shader.artifact.file), 'input.json')));
      rememberShader(input);
    }
    if (option('conversion')) for (const name of fs.readdirSync(option('conversion'))) {
      const file = path.join(option('conversion'), name, 'input.json');
      if (!fs.existsSync(file)) continue;
      const input = JSON.parse(fs.readFileSync(file));
      rememberShader(input);
    }
    await page.addInitScript(entries => { globalThis.qualityEntries = entries; }, entries);
    await page.addInitScript(() => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      let deferred;
      globalThis.qualityPauseAt = Infinity;
      globalThis.qualityResume = () => {
        qualityPauseAt = Infinity;
        if (deferred) { const next = deferred; deferred = null; requestFrame(next); }
      };
      window.requestAnimationFrame = callback => requestFrame(time => {
        if ((globalThis.__webEngineFrames || 0) >= qualityPauseAt) deferred = callback;
        else callback(time);
      });
      const textures = new WeakMap(), attachments = new WeakMap();
      globalThis.imageQuality = {textures: [], viewports: {}, errors: []};
      const pipelines = new WeakMap(), bound = new WeakMap();
      const createPipeline = GPUDevice.prototype.createRenderPipeline;
      GPUDevice.prototype.createRenderPipeline = function(descriptor) {
        const pipeline = createPipeline.call(this, descriptor);
        pipelines.set(pipeline, qualityEntries[descriptor.fragment?.entryPoint]);
        return pipeline;
      };
      const setPipeline = GPURenderPassEncoder.prototype.setPipeline;
      GPURenderPassEncoder.prototype.setPipeline = function(pipeline) {
        bound.set(this, pipelines.get(pipeline));
        return setPipeline.call(this, pipeline);
      };
      for (const method of ['draw', 'drawIndexed']) {
        const original = GPURenderPassEncoder.prototype[method];
        GPURenderPassEncoder.prototype[method] = function(...args) {
          if (imageQuality.skipCloudCompose && bound.get(this)?.name === 'FComposeVolumetricRTOverScenePS') {
            imageQuality.skippedCloudDraws = (imageQuality.skippedCloudDraws || 0) + 1;
            return;
          }
          return original.apply(this, args);
        };
      }
      const createCompute = GPUDevice.prototype.createComputePipeline;
      GPUDevice.prototype.createComputePipeline = function(descriptor) {
        const pipeline = createCompute.call(this, descriptor);
        pipelines.set(pipeline, qualityEntries[descriptor.compute.entryPoint]);
        return pipeline;
      };
      const setCompute = GPUComputePassEncoder.prototype.setPipeline;
      GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
        bound.set(this, pipelines.get(pipeline));
        return setCompute.call(this, pipeline);
      };
      const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
      GPUComputePassEncoder.prototype.dispatchWorkgroups = function(...args) {
        if (bound.get(this)?.mainTAA) imageQuality.mainTAADispatches = (imageQuality.mainTAADispatches || 0) + 1;
        return dispatch.apply(this, args);
      };
      const createTexture = GPUDevice.prototype.createTexture;
      const observedDevices = new WeakSet();
      GPUDevice.prototype.createTexture = function(descriptor) {
        if (!observedDevices.has(this)) {
          observedDevices.add(this);
          this.addEventListener('uncapturederror', event => {
            if (!imageQuality.errors.includes(event.error.message)) imageQuality.errors.push(event.error.message);
          });
        }
        const texture = createTexture.call(this, descriptor);
        const data = {label: texture.label, width: texture.width, height: texture.height,
          format: texture.format};
        textures.set(texture, data);
        if (/SceneColor|GBuffer|TemporalAA|TAA.History|Volumetric|Velocity/.test(data.label)) {
          if (!imageQuality.textures.some(item => JSON.stringify(item) === JSON.stringify(data)))
            imageQuality.textures.push(data);
        }
        return texture;
      };
      const createView = GPUTexture.prototype.createView;
      GPUTexture.prototype.createView = function(descriptor) {
        const view = createView.call(this, descriptor);
        attachments.set(view, textures.get(this));
        return view;
      };
      const begin = GPUCommandEncoder.prototype.beginRenderPass;
      const passes = new WeakMap();
      GPUCommandEncoder.prototype.beginRenderPass = function(descriptor) {
        const pass = begin.call(this, descriptor);
        passes.set(pass, descriptor.colorAttachments?.map(item => attachments.get(item?.view)));
        return pass;
      };
      const viewport = GPURenderPassEncoder.prototype.setViewport;
      GPURenderPassEncoder.prototype.setViewport = function(x, y, width, height, ...rest) {
        for (const item of passes.get(this) || [])
          if (item && /SceneColor|GBuffer|TemporalAA|TAA.History/.test(item.label))
            imageQuality.viewports[item.label] = {x, y, width, height};
        return viewport.call(this, x, y, width, height, ...rest);
      };
    });
    await page.route(`**/${folder}/index.html`, async route => {
      const response = await route.fetch();
      let html = await response.text();
      html = html.replace("arguments: ['-webgpu', '-WebDefaultTemplate'],",
        "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],");
      await route.fulfill({response, body: html});
    });
    if (settings) await page.route(`**/${folder}/config-files.json*`, async route => {
      const response = await route.fetch(), configs = await response.json();
      const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      const data = Buffer.from(Buffer.from(config.data, 'base64').toString() +
        '\n[SystemSettings]\n' + settings.split(',').join('\n') + '\n');
      config.data = data.toString('base64');
      config.sha256 = crypto.createHash('sha256').update(data).digest('hex');
      await route.fulfill({response, json: configs});
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    const frames = async count => {
      const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
      await page.waitForFunction(target => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= target, first + count, {timeout: 180000});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    };
    const capture = async name => {
      const file = path.join(directory, `web-image-quality-${tag}-${name}.png`);
      const image = PNG.sync.read(await page.locator('canvas').screenshot({path: file}));
      return {...audit(file), width: image.width, height: image.height};
    };
    await frames(90);
    report.resolution = await page.evaluate(() => ({
      canvas: {width: Module.canvas.width, height: Module.canvas.height},
      ...imageQuality, view: globalThis.__webRenderView,
      camera: globalThis.__webDefaultCamera, ready: globalThis.__webEngineReady
    }));
    report.fullResolutionImage = await capture('4k');
    await page.setViewportSize({width: 1100, height: 760});
    await frames(60);
    const views = process.argv.includes('--continuous') ?
      Array.from({length: 24}, (_, index) => [index, 30 - index * 2, 120]) :
      checkClouds ? [[0, 0, 120], [1, -8, 120], [2, 5, 120]] :
        [[0, 45, 120], [1, 0, 120], [2, 25, 120], [3, -8, 120], [4, 5, 108], [5, -8, 120]];
    for (const [index, pitch, yaw] of views) {
      const camera = {x: 600, y: -880, z: 220, pitch, yaw};
      await page.evaluate(v => {
        qualityResume();
        Module._WebProjectViewTest(v.x, v.y, v.z, v.pitch, v.yaw);
        qualityPauseAt = __webEngineFrames + 2;
      }, camera);
      await page.waitForFunction(() => __webEngineFrames >= qualityPauseAt, null,
        {timeout: 60000, polling: 50});
      const moved = await capture(`motion-${index}`);
      if (checkClouds) {
        const samples = await page.evaluate(() => {
          Module._WebDefaultSamplesVisibility(1);
          return __webDefaultSamples;
        });
        await page.evaluate(() => {
          qualityResume();
          imageQuality.skipCloudCompose = true;
        });
        await frames(60);
        const clear = await capture(`cloud-off-${index}`);
        const before = PNG.sync.read(fs.readFileSync(moved.file));
        const after = PNG.sync.read(fs.readFileSync(clear.file));
        const regions = samples.samples.filter(item => item.row === 0 && item.column >= 2).flatMap(sample =>
          [['interior', 0, 0.9], ['edge', 0.9, 0.99]].map(([area, inner, outer]) => {
          const screen = sample.screen, radius = screen.radius * outer;
          let total = 0, changed = 0, count = 0, max = 0;
          for (let y = Math.max(0, Math.ceil(screen.y - radius)); y < Math.min(before.height, screen.y + radius); y++)
          for (let x = Math.max(0, Math.ceil(screen.x - radius)); x < Math.min(before.width, screen.x + radius); x++) {
            const distance = Math.hypot(x - screen.x, y - screen.y);
            if (distance > radius || distance < screen.radius * inner) continue;
            const offset = (y * before.width + x) * 4;
            let delta = 0;
            for (let c = 0; c < 3; c++) delta += Math.abs(before.data[offset + c] - after.data[offset + c]);
            delta /= 3;
            max = Math.max(max, delta); total += delta; changed += delta > 8; count++;
          }
          return {column: sample.column, area, screen, count, mean: total / count,
            changedFraction: changed / count, max};
        }));
        (report.cloudOcclusion ||= []).push({index, reference: clear, regions});
        await page.evaluate(() => { imageQuality.skipCloudCompose = false; });
        await frames(60);
      }
      await page.evaluate(() => qualityResume());
      if (!process.argv.includes('--continuous')) await frames(60);
      const settled = process.argv.includes('--continuous') ? null : await capture(`settled-${index}`);
      report.views.push({pitch, yaw, moved, settled});
    }
    report.gpu = await page.evaluate(() => imageQuality);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.gpu.errors, []);
    const view = report.resolution.viewports.SceneColor;
    report.nativeResolution = !!view && view.width === report.resolution.canvas.width &&
      view.height === report.resolution.canvas.height;
    assert(report.nativeResolution, 'SceneColor viewport must match physical canvas resolution');
    if (expectTAA) {
      assert.equal(report.resolution.view?.antiAliasing, 2, 'The UE view must use desktop TAA');
      assert(report.gpu.mainTAADispatches > 0, 'The main TAA pass must execute on the GPU');
      report.temporalAAVerified = true;
    }
    if (checkClouds) {
      assert(report.gpu.skippedCloudDraws > 0 && report.cloudOcclusion.every(view =>
        view.regions.length === 4 && view.regions.every(region =>
          region.count > 100 && region.mean < 2 &&
          region.changedFraction < (region.area === 'edge' ? 0.01 : 0.02))),
        'Clouds must not change opaque matte sphere interiors or leave blocks near their edges');
      report.cloudOcclusionVerified = true;
    }
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-image-quality-${tag}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure,
      browser: report.browser, scale, nativeResolution: report.nativeResolution,
      view: report.resolution?.view, temporalAAVerified: report.temporalAAVerified,
      cloudOcclusionVerified: report.cloudOcclusionVerified, errors: report.errors}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
