const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const browser = option('browser') || 'Chrome';
const scale = Number(option('scale') || 1);
const interactionOnly = process.argv.includes('--interaction-only');
assert(['Chrome', 'Edge'].includes(browser) && scale >= 1 && scale <= 2);
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, browser, scale, views: [], errors: [],
  log: [],
  source: audit(__filename), boundary: 'Scene, input, camera, native pixel size and browser rendering checks. ' +
    'Keyboard movement and mouse rotation are checked after preset selection. Motion mode animates only the ' +
    'test session to exercise the real TAA velocity texture; these checks do not certify desktop visual parity.'};
let context;
(async () => {
  try {
    const packageFile = path.join(directory, 'web-project-villa-material-lab-threads-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.renderer === 'desktop-deferred' && packaged.threads);
    assert(packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.package = audit(packageFile);
    report.profile = fs.mkdtempSync(path.join(directory, `villa-material-lab-${browser.toLowerCase()}-`));
    context = await chromium.launchPersistentContext(report.profile, {
      executablePath: browser === 'Edge' ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
        'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      viewport: {width: 1600, height: 900}, deviceScaleFactor: scale
    });
    const initialPages = context.pages();
    const page = await context.newPage();
    for (const initial of initialPages) await initial.close();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      if (text.startsWith('VILLA_GPU_DEVICE ')) report.device = JSON.parse(text.slice(17));
      if (text.startsWith('VILLA_GPU_TEXTURE ')) (report.velocityTextures ||= []).push(JSON.parse(text.slice(18)));
      report.log.push(text);
      if (report.log.length > 100) report.log.shift();
      if (/Assertion failed|Fatal error:|GPU validation:|DeviceLost|Local bulk IO failed|Unavailable|GPUValidationError/.test(text))
        report.errors.push(text);
    });
    if (process.argv.includes('--motion')) {
      await context.route('**/index.html', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = "arguments: ['-webgpu', '-WebProjectMap=/Game/WebVillaMaterialLab'],";
        assert(source.includes(marker));
        await route.fulfill({response, body: source.replace(marker,
          "arguments: ['-webgpu', '-WebProjectMap=/Game/WebVillaMaterialLab', '-WebMaterialLabMotionTest'],")});
      });
    }
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `
        const originalRequest = GPUAdapter.prototype.requestDevice;
        globalThis.__villaLabGPU = {errors: [], losses: []};
        globalThis.__villaLabDevice = {};
        GPUAdapter.prototype.requestDevice = async function(descriptor) {
          const device = await originalRequest.call(this, descriptor);
          Object.assign(__villaLabDevice, {adapter: Object.fromEntries(
            ['vendor', 'architecture', 'device', 'description'].map(key => [key, this.info?.[key] || ''])),
            requested: descriptor.requiredFeatures, enabled: [...device.features]});
          console.log('VILLA_GPU_DEVICE ' + JSON.stringify(__villaLabDevice));
          device.addEventListener('uncapturederror', event => __villaLabGPU.errors.push(event.error.message));
          device.lost.then(info => {if(info.reason !== 'destroyed') __villaLabGPU.losses.push(info.message)});
          return device;
        };
        const originalTexture = GPUDevice.prototype.createTexture;
        GPUDevice.prototype.createTexture = function(descriptor) {
          if (descriptor.label === 'SceneVelocity')
            console.log('VILLA_GPU_TEXTURE ' + JSON.stringify(descriptor));
          return originalTexture.call(this, descriptor);
        };
        const views = new WeakMap(), layouts = new WeakMap();
        const pipelineLayouts = new WeakMap(), pipelines = new WeakMap();
        const originalView = GPUTexture.prototype.createView;
        GPUTexture.prototype.createView = function(descriptor) {
          const view = originalView.call(this, descriptor);
          views.set(view, this.label);
          return view;
        };
        const originalLayout = GPUDevice.prototype.createBindGroupLayout;
        GPUDevice.prototype.createBindGroupLayout = function(descriptor) {
          const layout = originalLayout.call(this, descriptor);
          layouts.set(layout, descriptor.entries);
          return layout;
        };
        const originalPipelineLayout = GPUDevice.prototype.createPipelineLayout;
        GPUDevice.prototype.createPipelineLayout = function(descriptor) {
          const layout = originalPipelineLayout.call(this, descriptor);
          pipelineLayouts.set(layout, descriptor.bindGroupLayouts.map(item => layouts.get(item)));
          return layout;
        };
        for (const [name, prototype] of [
          ['createRenderPipeline', GPURenderPipeline.prototype],
          ['createComputePipeline', GPUComputePipeline.prototype]]) {
          const originalPipeline = GPUDevice.prototype[name];
          GPUDevice.prototype[name] = function(descriptor) {
            const pipeline = originalPipeline.call(this, descriptor);
            pipelines.set(pipeline, pipelineLayouts.get(descriptor.layout));
            return pipeline;
          };
          const originalGetLayout = prototype.getBindGroupLayout;
          prototype.getBindGroupLayout = function(index) {
            const layout = originalGetLayout.call(this, index);
            layouts.set(layout, pipelines.get(this)?.[index]);
            return layout;
          };
        }
        const originalGroup = GPUDevice.prototype.createBindGroup;
        GPUDevice.prototype.createBindGroup = function(descriptor) {
          const entry = descriptor.entries.find(item => views.get(item.resource) === 'SceneVelocity');
          if (entry && !globalThis.__villaLabVelocityBinding) {
            globalThis.__villaLabVelocityBinding = {
              binding: entry.binding, layout: layouts.get(descriptor.layout)};
            console.log('VILLA_GPU_VELOCITY ' + JSON.stringify(__villaLabVelocityBinding));
          }
          return originalGroup.call(this, descriptor);
        };\n` + await response.text()});
    });
    if (process.argv.includes('--startup-movement')) {
      await context.route('**/villa-material-lab-ui.js?*', async route => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = 'if (!globalThis.__webEngineReady || !globalThis.__webEngineFrames) return;';
        assert(source.includes(marker));
        await route.fulfill({response, body: source.replace(marker,
          'if (!globalThis.__allowVillaLabUI || !globalThis.__webEngineReady || !globalThis.__webEngineFrames) return;')});
      });
    }
    await page.goto('http://127.0.0.1:8765/build/villa-material-lab-threads/index.html',
      {waitUntil: 'commit'});
    if (process.argv.includes('--resize-startup')) {
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 30,
        null, {timeout: 240000});
      await page.setViewportSize({width: 1670, height: 940});
    }
    if (process.argv.includes('--startup-movement')) {
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 30,
        null, {timeout: 240000});
      await page.locator('canvas').focus();
      const first = await page.evaluate(() => __webEngineFrames);
      await page.keyboard.down('KeyW');
      await page.waitForFunction(frame => globalThis.__webEngineFailure || __webEngineFrames >= frame,
        first + 30, {timeout: 90000});
      await page.keyboard.up('KeyW');
      await page.evaluate(() => { globalThis.__allowVillaLabUI = true; });
    }
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 180 && globalThis.__villaMaterialLabView, null, {timeout: 240000});
    report.startupFailure = await page.evaluate(() => globalThis.__webEngineFailure || null);
    assert.equal(report.startupFailure, null);
    const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js'));
    assert(owner);
    report.device = await owner.evaluate(() => __villaLabDevice);
    if (process.argv.includes('--motion')) {
      report.motion = await owner.evaluate(() => globalThis.__webMaterialMotionTest);
      assert(report.motion?.frame > 0, 'The test must actually animate a visible sample');
      assert(report.velocityTextures?.length > 0, 'The motion test must allocate the real velocity target');
    }
    const advance = async (frames = 30) => {
      const first = await page.evaluate(() => __webEngineFrames);
      await page.waitForFunction(frame => globalThis.__webEngineFailure || __webEngineFrames >= frame,
        first + frames, {timeout: 90000});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
      return owner.evaluate(() => ({...__webDefaultCamera}));
    };
    if (process.argv.includes('--resize-startup')) {
      report.resizes = [];
      for (const viewport of [{width: 1670, height: 940}, {width: 1280, height: 720},
        {width: 1600, height: 900}]) {
        await page.setViewportSize(viewport);
        await advance(30);
        const state = await page.evaluate(() => ({
          view: __webRenderView, surface: __webEngineSurface,
          width: Module.canvas.getBoundingClientRect().width,
          height: Module.canvas.getBoundingClientRect().height, dpr: devicePixelRatio
        }));
        assert.equal(state.surface.width, Math.round(state.width * state.dpr));
        assert.equal(state.surface.height, Math.round(state.height * state.dpr));
        assert.equal(state.view.width, state.surface.width);
        assert.equal(state.view.height, state.surface.height);
        assert.equal(state.view.antiAliasing, 2);
        report.resizes.push(state);
      }
    }
    const capture = async name => {
      const frame = await page.evaluate(() => __webEngineFrames);
      await page.waitForFunction(first => globalThis.__webEngineFailure || __webEngineFrames > first + 90,
        frame, {timeout: 90000});
      const state = await owner.evaluate(() => ({
        view: globalThis.__webRenderView,
        streaming: globalThis.__webTextureStreaming, camera: globalThis.__webDefaultCamera,
        gpu: globalThis.__villaLabGPU, browserState: globalThis.__webBrowserState
      }));
      Object.assign(state, await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure || null, world: globalThis.__webEngineWorld,
        ready: globalThis.__webEngineReady
      })));
      report.lastCapture = {name, state, dpr: await page.evaluate(() => devicePixelRatio)};
      assert.equal(state.failure, null);
      assert.equal(state.world.package, '/Game/WebVillaMaterialLab');
      assert.equal(state.ready.featureLevel, 3);
      assert.equal(state.view.width, 1600 * scale);
      assert.equal(state.view.height, 900 * scale);
      assert.equal(state.view.antiAliasing, 2);
      assert.deepEqual(state.gpu, {errors: [], losses: []});
      assert.deepEqual(report.errors, []);
      const control = await page.evaluate(() => __villaMaterialLabView);
      assert(Math.hypot(state.camera.x - control.camera[0], state.camera.y - control.camera[1],
        state.camera.z - control.camera[2]) < 0.1, 'The actual view must match the selected sample');
      const box = await page.locator('canvas').boundingBox();
      const bytes = await page.screenshot({clip: box, scale: 'device', timeout: 30000});
      const image = PNG.sync.read(bytes);
      const colors = new Set();
      for (let offset = 0; offset < image.data.length; offset += 4)
        colors.add(image.data.readUInt32LE(offset));
      assert(colors.size > 1000, 'The material scene must contain rendered detail');
      const file = path.join(directory, `villa-material-lab-web-${browser.toLowerCase()}-${scale}-${name}.png`);
      fs.writeFileSync(file, bytes);
      report.views.push({name, state, control, image: audit(file), colors: colors.size});
      console.log(JSON.stringify({view: name, frame: state.view.frame, colors: colors.size}));
    };
    if (!interactionOnly) {
      await capture('overview');
      for (const sample of packaged.layout.samples) {
        await page.selectOption('#villa-lab select', sample.id);
        await page.waitForFunction(id => __villaMaterialLabView.id === id, sample.id);
        await capture(sample.id);
      }
    }
    await page.selectOption('#villa-lab select', 'brick-wall');
    await page.waitForFunction(() => __villaMaterialLabView.id === 'brick-wall');
    await page.locator('canvas').focus();
    report.movement = {before: await advance(5)};
    await page.keyboard.down('KeyW');
    await advance(30);
    await page.keyboard.up('KeyW');
    report.movement.after = await advance(10);
    assert(Math.hypot(report.movement.after.x - report.movement.before.x,
      report.movement.after.y - report.movement.before.y,
      report.movement.after.z - report.movement.before.z) > 1,
    'W must move the visible camera after selecting a model');
    report.mouse = {before: report.movement.after};
    await page.mouse.move(800, 450);
    await page.mouse.down({button: 'right'});
    await page.mouse.move(810, 455);
    await page.mouse.move(880, 490, {steps: 8});
    await page.mouse.up({button: 'right'});
    report.mouse.after = await advance(15);
    assert(Math.abs(report.mouse.after.yaw - report.mouse.before.yaw) +
      Math.abs(report.mouse.after.pitch - report.mouse.before.pitch) > 0.1,
    'Dragging must rotate the visible camera after selecting a model');
    await page.selectOption('#villa-lab select', 'sink');
    await page.waitForFunction(() => __villaMaterialLabView.id === 'sink');
    await page.locator('canvas').focus();
    report.secondSelection = {before: await advance(5)};
    await page.keyboard.down('KeyD');
    await advance(20);
    await page.keyboard.up('KeyD');
    report.secondSelection.after = await advance(10);
    assert(Math.hypot(report.secondSelection.after.x - report.secondSelection.before.x,
      report.secondSelection.after.y - report.secondSelection.before.y,
      report.secondSelection.after.z - report.secondSelection.before.z) > 1,
    'Free movement must remain available after selecting another model');
    await advance(180);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(await owner.evaluate(() => __villaLabGPU), {errors: [], losses: []});
    if (process.argv.includes('--motion')) {
      report.velocityBinding = await owner.evaluate(() => globalThis.__villaLabVelocityBinding);
      const binding = report.velocityBinding;
      assert(binding?.layout?.some(item => item.binding === binding.binding &&
        item.texture?.sampleType === 'unfilterable-float'),
      'The real velocity target must use an unfilterable texture layout');
      report.motionAfter = await owner.evaluate(() => globalThis.__webMaterialMotionTest);
      assert(report.motionAfter.frame > report.motion.frame + 180);
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(500);
    report.narrowPanel = await page.locator('#villa-lab').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {right: rect.right, width: rect.width, viewportWidth: innerWidth,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth};
    });
    assert(report.narrowPanel.right <= report.narrowPanel.viewportWidth);
    assert(report.narrowPanel.scrollWidth <= report.narrowPanel.clientWidth);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (context) await context.close();
    const suffix = option('report') || `${browser.toLowerCase()}-${scale}`;
    assert(/^[a-z0-9.-]+$/.test(suffix));
    fs.writeFileSync(path.join(directory, `villa-material-lab-browser-${suffix}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, views: report.views.length, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
