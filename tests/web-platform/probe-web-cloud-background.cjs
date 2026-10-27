const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('report') || 'cloud-background';
const folder = option('folder') || 'ue-default-template';
const scale = Number(option('scale') || 1);
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder) && [1, 1.5, 2].includes(scale));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, folder, scale,
  fixedVisualClock: true, shaderOverrides: false, cloudBackgroundVerified: false,
  browser: process.argv.includes('--edge') ? 'Edge' : 'Chrome', errors: [], views: [],
  sourceFiles: [audit(__filename), audit(path.resolve(__dirname,
    '../../reference-engine/Engine/Source/Runtime/Renderer/Private/VolumetricCloudRendering.cpp'))],
  products: ['index.html', 'UEWebEngine.js', 'UEWebEngine.wasm', 'config-files.json',
    'content-files.json', 'content.bin', 'web-content-io.js', 'web-content-worker.js']
    .map(name => audit(path.join(__dirname, 'build', folder, name)))};
let browser;
(async () => {
  try {
    browser = await chromium.launch({headless: true, executablePath: process.argv.includes('--edge') ?
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
      'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: scale});
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      if (/GPU validation|Fatal error|Assertion failed|DeviceLost/.test(message.text()))
        report.errors.push(message.text());
    });
    await page.addInitScript(() => {
      const request = requestAnimationFrame.bind(window);
      let deferred;
      globalThis.cloudPauseAt = Infinity;
      globalThis.cloudResume = () => {
        cloudPauseAt = Infinity;
        if (deferred) { const next = deferred; deferred = null; request(next); }
      };
      window.requestAnimationFrame = callback => request(time => {
        if ((globalThis.__webEngineFrames || 0) >= cloudPauseAt) deferred = callback;
        else callback(time);
      });
      globalThis.cloudErrors = [];
      const requestDevice = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function(...args) {
        const device = await requestDevice.apply(this, args);
        device.addEventListener('uncapturederror', event => cloudErrors.push(event.error.message));
        return device;
      };
    });
    await page.route(`**/${folder}/index.html`, async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: (await response.text()).replace(
        "arguments: ['-webgpu', '-WebDefaultTemplate'],",
        "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
    });
    await page.route(`**/${folder}/config-files.json*`, async route => {
      const response = await route.fetch(), configs = await response.json();
      const config = configs.find(item => item.path === '/Engine/Platforms/Web/Config/WebEngine.ini');
      const data = Buffer.from(Buffer.from(config.data, 'base64').toString() +
        '\n[SystemSettings]\nr.EyeAdaptationQuality=0\nr.BloomQuality=0\n');
      config.data = data.toString('base64');
      config.sha256 = crypto.createHash('sha256').update(data).digest('hex');
      await route.fulfill({response, json: configs});
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    const advance = async count => {
      await page.evaluate(count => {
        cloudResume();
        cloudPauseAt = (globalThis.__webEngineFrames || 0) + count;
      }, count);
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= cloudPauseAt, null, {timeout: 180000, polling: 50});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    };
    const capture = async name => {
      const file = path.join(directory, `web-${tag}-${name}.png`);
      await page.locator('canvas').screenshot({path: file});
      return audit(file);
    };
    await advance(120);
    assert.equal(await page.evaluate(() => globalThis.__webVisualTestClock?.renderTimeFrozen), true);
    await page.setViewportSize({width: 1920, height: 1080});
    await advance(60);
    report.resolution = await page.evaluate(() => ({width: Module.canvas.width, height: Module.canvas.height}));
    assert.deepEqual(report.resolution, {width: 1920 * scale, height: 1080 * scale});
    const cameras = [
      {x: 830, y: -170, z: 15, pitch: 20, yaw: 120},
      {x: 650, y: -400, z: 10, pitch: 15, yaw: 110},
      {x: 600, y: -600, z: 20, pitch: 12, yaw: 110}
    ];
    for (const [index, camera] of cameras.entries()) {
      await page.evaluate(camera => {
        Module._WebDefaultSamplesVisibility(1);
        Module._WebProjectViewTest(camera.x, camera.y, camera.z, -25, camera.yaw - 8);
      }, camera);
      await advance(60);
      await page.evaluate(camera =>
        Module._WebProjectViewTest(camera.x, camera.y, camera.z, camera.pitch, camera.yaw), camera);
      const captures = [];
      let fixture;
      let frameCount = 0;
      for (const step of [2, 8, 60]) {
        await advance(step);
        frameCount += step;
        fixture = await page.evaluate(() => {
          Module._WebDefaultSamplesVisibility(1);
          return __webDefaultSamples;
        });
        captures.push({frameCount, image: await capture(`${index}-objects-${frameCount}`)});
      }
      assert(fixture.sceneUnchanged && fixture.count === 8 &&
        camera.z - fixture.floor.top <= 21 &&
        fixture.samples.some(sample => sample.screen.radius > fixture.viewport.width * 0.07));
      await page.evaluate(() => Module._WebDefaultSamplesVisibility(0));
      await advance(90);
      const reference = await capture(`${index}-sky-reference`);
      const baseline = PNG.sync.read(fs.readFileSync(reference.file));
      const samples = fixture.samples;
      const view = {camera, fixture, reference, samples: []};
      report.views.push(view);
      for (const {frameCount, image} of captures) {
        const actual = PNG.sync.read(fs.readFileSync(image.file));
        assert.equal(actual.width, baseline.width);
        const ratio = actual.width / fixture.viewport.width;
        const projected = samples.map(sample => ({x: sample.screen.x * ratio,
          y: sample.screen.y * ratio, radius: sample.screen.radius * ratio, row: sample.row}));
        const foreground = projected.filter(sample => sample.row === 0);
        const top = Math.max(0, Math.floor(Math.min(...foreground.map(sample =>
          sample.y - sample.radius * 1.5))));
        const bottom = Math.min(actual.height, Math.ceil(Math.max(...foreground.map(sample =>
          sample.y - sample.radius * 0.2))));
        let count = 0, changed = 0, sum = 0, cloudPixels = 0;
        for (let y = top; y < bottom; y++) for (let x = 0; x < actual.width; x++) {
          if (projected.some(sample => Math.hypot(x - sample.x, y - sample.y) <
            sample.radius * 1.15)) continue;
          const offset = (y * actual.width + x) * 4;
          cloudPixels += baseline.data[offset] > 140 && baseline.data[offset + 1] > 150;
          let delta = 0;
          for (let channel = 0; channel < 3; channel++)
            delta += Math.abs(actual.data[offset + channel] - baseline.data[offset + channel]);
          delta /= 3;
          count++; sum += delta; changed += delta > 12;
        }
        view.samples.push({frameCount, image, count, cloudPixels,
          mean: sum / count, changedFraction: changed / count});
      }
      console.log(JSON.stringify({camera, samples: view.samples.map(({image, ...metrics}) => metrics)}));
    }
    report.gpuErrors = await page.evaluate(() => cloudErrors);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.gpuErrors, []);
    assert(report.views.every(view => view.samples.every(sample =>
      sample.count > 1000 && sample.cloudPixels > 1000 &&
      sample.mean < 3 && sample.changedFraction < 0.03)),
    'Opaque spheres must not erase clouds in the surrounding sky');
    report.cloudBackgroundVerified = true;
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-${tag}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
