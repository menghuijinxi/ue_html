const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const crypto = require('node:crypto');
const results = path.join(__dirname, 'results');
const edge = process.argv.includes('--edge');
const suffix = edge ? '-edge' : '';
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {pass: false, browser: edge ? 'Edge' : 'Chrome', images: {}, errors: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};
const view = {x: -1000, y: -70, z: 230, pitch: -8, yaw: 65};
const variants = [
  {name: 'baseline', bias: 0.5, slope: 0.5, cast: true, dense: true},
  {name: 'coarse', bias: 0.5, slope: 0.5, cast: true, dense: false},
  {name: 'shadows-off', bias: 0.5, slope: 0.5, cast: false, dense: true},
  {name: 'bias1', bias: 1, slope: 0.5, cast: true},
  {name: 'bias2', bias: 2, slope: 0.5, cast: true},
  {name: 'slope1', bias: 0.5, slope: 1, cast: true},
  {name: 'slope2', bias: 0.5, slope: 2, cast: true}
].map(item => ({...view, dense: true, ...item}));
function metric(file, reference) {
  const a = PNG.sync.read(fs.readFileSync(file)), b = PNG.sync.read(fs.readFileSync(reference));
  assert.equal(a.width, 1600); assert.equal(a.height, 900);
  const delta = (x, y) => {
    const offset = (y * a.width + x) * 4;
    return (b.data[offset] + b.data[offset + 1] + b.data[offset + 2] -
      a.data[offset] - a.data[offset + 1] - a.data[offset + 2]) / 3;
  };
  const bright = [];
  // Remove exposure drift using a lit patch on the same sphere.
  for (let y = 340; y < 470; ++y)
    for (let x = 850; x < 970; ++x) bright.push(delta(x, y));
  bright.sort((x, y) => x - y);
  const exposure = bright[Math.floor(bright.length / 2)];
  let total = 0, changed = 0, count = 0;
  // Exclude silhouette and ground: measure excess self-shadow inside the sphere.
  for (let y = 300; y < 750; ++y)
    for (let x = 580; x < 1030; ++x) {
      if (Math.hypot(x - 800, y - 525) > 220) continue;
      const excess = delta(x, y) - exposure;
      total += Math.max(0, excess); changed += excess > 6 ? 1 : 0; ++count;
    }
  const ground = (x0, y0, width, height) => {
    let sum = 0;
    for (let y = y0; y < y0 + height; ++y)
      for (let x = x0; x < x0 + width; ++x) sum += delta(x, y) - exposure;
    return sum / (width * height);
  };
  return {exposure, mean: total / count, changedFraction: changed / count,
    groundShadow: ground(450, 750, 100, 30), contactShadow: ground(790, 775, 20, 10)};
}
(async () => {
  let browser;
  try {
    browser = await chromium.launch({executablePath: edge ?
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: true});
    const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
    page.on('pageerror', error => report.errors.push(error.message));
    await page.addInitScript(require('./capture-web-canvas.cjs'));
    await page.addInitScript(() => {
      const views = new WeakMap(), records = [];
      const createView = GPUTexture.prototype.createView;
      GPUTexture.prototype.createView = function(descriptor) {
        const result = createView.call(this, descriptor);
        if (this.format === 'depth32float')
          views.set(result, {width: this.width, height: this.height, label: this.label});
        return result;
      };
      const begin = GPUCommandEncoder.prototype.beginRenderPass;
      GPUCommandEncoder.prototype.beginRenderPass = function(descriptor) {
        const pass = begin.call(this, descriptor);
        const texture = views.get(descriptor.depthStencilAttachment?.view);
        if (texture?.width === 8192 && texture.height === 8192 && records.length < 16) {
          const record = {texture, tiles: []};
          records.push(record);
          const viewport = pass.setViewport.bind(pass), draw = pass.drawIndexed.bind(pass);
          let tile;
          pass.setViewport = (x, y, width, height, ...rest) => {
            tile = {x, y, width, height, draws: 0};
            record.tiles.push(tile);
            viewport(x, y, width, height, ...rest);
          };
          pass.drawIndexed = (...args) => { if (tile) ++tile.draws; draw(...args); };
        }
        return pass;
      };
      globalThis.__webShadowAtlas = records;
    });
    await page.route('**/ue-default-template/index.html', async route => {
      const response = await route.fetch(), html = await response.text();
      const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
      assert(html.includes(original));
      await route.fulfill({response, body: html.replace(original,
        "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
    });
    await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 120, null, {timeout: 90000});
    assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    assert.equal(await page.evaluate(v =>
      Module._WebProjectViewTest(v.x, v.y, v.z, v.pitch, v.yaw), view), 1);
    const cameraFrame = await page.evaluate(() => globalThis.__webEngineFrames);
    await page.waitForFunction(frame => globalThis.__webEngineFrames >= frame + 120, cameraFrame);
    assert.equal(await page.evaluate(() => Module._WebDefaultShadowControl(4, 0)), 1);
    const fixture = await page.evaluate(() => globalThis.__webDefaultSamples);
    report.camera = await page.evaluate(() => globalThis.__webDefaultShadowCamera);
    for (const mode of edge ? [] : ['desktop', 'mobile'])
      fs.writeFileSync(path.join(results, `default-shadow-native-${mode}.json`), JSON.stringify({
        output: path.join(results, `default-shadow-native-${mode}`), samples: fixture.samples,
        views: variants.map(item => ({...item, fov: report.camera.fov}))
      }, null, 2));
    for (const item of variants) {
      assert.equal(await page.evaluate(v => Module._WebDefaultShadowControl(3, v.dense ? 1 : 0), item), 1);
      assert.equal(await page.evaluate(v => Module._WebDefaultShadowControl(0, v.cast ? 1 : 0), item), 1);
      assert.equal(await page.evaluate(v => Module._WebDefaultShadowControl(1, v.bias), item), 1);
      assert.equal(await page.evaluate(v => Module._WebDefaultShadowControl(2, v.slope), item), 1);
      const frame = await page.evaluate(() => globalThis.__webEngineFrames);
      await page.waitForFunction(frame => globalThis.__webEngineFrames >= frame + 120, frame);
      assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      const file = path.join(results, `default-shadow-web${suffix}-${item.name}.png`);
      await page.locator('canvas').screenshot({path: file});
      report.images[item.name] = {...audit(file), settings: item};
    }
    for (const item of variants)
      report.images[item.name].difference = metric(report.images[item.name].file, report.images['shadows-off'].file);
    report.gpuErrors = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
    report.atlas = await page.evaluate(() => globalThis.__webShadowAtlas);
    assert.equal(report.errors.length + report.gpuErrors.length, 0);
    const tiles = new Set(report.atlas.flatMap(pass => pass.tiles)
      .filter(tile => tile.width === 4096 && tile.height === 4096 && tile.draws > 0)
      .map(tile => `${tile.x},${tile.y}`));
    assert.equal(tiles.size, 4, 'All four 4096 CSM tiles must contain indexed draws');
    assert(report.images.baseline.difference.changedFraction < 0.02,
      'The rough sphere contains excessive faceted self-shadow');
    assert(report.images.baseline.difference.mean < 1,
      'The rough sphere self-shadow error exceeds one intensity level');
    assert(report.images.coarse.difference.changedFraction < 0.02,
      'Receiver-plane compensation must also improve the original coarse sphere');
    assert(report.images.baseline.difference.groundShadow > 20 &&
      report.images.baseline.difference.contactShadow > 20,
    'The fix must preserve projected and contact shadows');
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, `web-default-shadow-artifacts${suffix}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browser: report.browser, camera: report.camera,
      baseline: report.images.baseline?.difference, coarse: report.images.coarse?.difference,
      gpuErrors: report.gpuErrors, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
