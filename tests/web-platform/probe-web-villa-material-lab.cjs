const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, views: [], errors: [],
  log: [],
  source: audit(__filename), boundary: 'Scene, input, camera, native pixel size and browser rendering checks. ' +
    'Screenshots support manual material inspection; these checks do not certify desktop visual parity.'};
let context;
(async () => {
  try {
    const packageFile = path.join(directory, 'web-project-villa-material-lab-threads-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.renderer === 'desktop-deferred' && packaged.threads);
    assert(packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.package = audit(packageFile);
    report.profile = fs.mkdtempSync(path.join(directory, 'villa-material-lab-chrome-'));
    context = await chromium.launchPersistentContext(report.profile, {
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
      viewport: {width: 1600, height: 900}, deviceScaleFactor: 1
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      report.log.push(text);
      if (report.log.length > 100) report.log.shift();
      if (/Assertion failed|Fatal error:|GPU validation:|DeviceLost|Local bulk IO failed|Unavailable|GPUValidationError/.test(text))
        report.errors.push(text);
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `
        const originalRequest = GPUAdapter.prototype.requestDevice;
        globalThis.__villaLabGPU = {errors: [], losses: []};
        GPUAdapter.prototype.requestDevice = async function(descriptor) {
          const device = await originalRequest.call(this, descriptor);
          device.addEventListener('uncapturederror', event => __villaLabGPU.errors.push(event.error.message));
          device.lost.then(info => {if(info.reason !== 'destroyed') __villaLabGPU.losses.push(info.message)});
          return device;
        };\n` + await response.text()});
    });
    await page.goto('http://127.0.0.1:8765/build/villa-material-lab-threads/index.html',
      {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 180 && globalThis.__villaMaterialLabView, null, {timeout: 240000});
    report.startupFailure = await page.evaluate(() => globalThis.__webEngineFailure || null);
    assert.equal(report.startupFailure, null);
    const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js'));
    assert(owner);
    const capture = async name => {
      const frame = await page.evaluate(() => __webEngineFrames);
      await page.waitForFunction(first => globalThis.__webEngineFailure || __webEngineFrames > first + 90,
        frame, {timeout: 90000});
      const state = await owner.evaluate(() => ({
        view: globalThis.__webRenderView,
        streaming: globalThis.__webTextureStreaming, camera: globalThis.__webDefaultCamera,
        gpu: globalThis.__villaLabGPU
      }));
      Object.assign(state, await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure || null, world: globalThis.__webEngineWorld,
        ready: globalThis.__webEngineReady
      })));
      assert.equal(state.failure, null);
      assert.equal(state.world.package, '/Game/WebVillaMaterialLab');
      assert.equal(state.ready.featureLevel, 3);
      assert.equal(state.view.width, 1600);
      assert.equal(state.view.height, 900);
      assert.equal(state.view.antiAliasing, 2);
      assert.deepEqual(state.gpu, {errors: [], losses: []});
      assert.deepEqual(report.errors, []);
      const control = await page.evaluate(() => __villaMaterialLabView);
      assert(Math.hypot(state.camera.x - control.camera[0], state.camera.y - control.camera[1],
        state.camera.z - control.camera[2]) < 0.1, 'The actual view must match the selected sample');
      const session = await context.newCDPSession(page);
      let bytes;
      try {
        const box = await page.locator('canvas').boundingBox();
        const result = await session.send('Page.captureScreenshot', {format: 'png', fromSurface: true,
          captureBeyondViewport: false, clip: {...box, scale: 1}});
        bytes = Buffer.from(result.data, 'base64');
      } finally { await session.detach(); }
      const image = PNG.sync.read(bytes);
      const colors = new Set();
      for (let offset = 0; offset < image.data.length; offset += 4)
        colors.add(image.data.readUInt32LE(offset));
      assert(colors.size > 1000, 'The material scene must contain rendered detail');
      const file = path.join(directory, `villa-material-lab-web-${name}.png`);
      fs.writeFileSync(file, bytes);
      report.views.push({name, state, control, image: audit(file), colors: colors.size});
      console.log(JSON.stringify({view: name, frame: state.view.frame, colors: colors.size}));
    };
    await capture('overview');
    for (const sample of packaged.layout.samples) {
      await page.selectOption('#villa-lab select', sample.id);
      await page.waitForFunction(id => __villaMaterialLabView.id === id, sample.id);
      await capture(sample.id);
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
    fs.writeFileSync(path.join(directory, 'villa-material-lab-browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, views: report.views.length, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
