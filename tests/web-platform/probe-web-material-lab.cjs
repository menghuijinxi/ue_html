const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const results = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, runs: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit),
  boundary: 'Runtime and image controls for an isolated UE material scene. Measured differences are diagnostics, not proof of native visual parity, refraction, GI, or transparency shadows.'};
function pixels(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  const colors = new Set();
  let luma = 0, nonBlack = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const [r, g, b] = image.data.subarray(i, i + 3);
    luma += (r + g + b) / 3;
    nonBlack += r + g + b > 20 ? 1 : 0;
    colors.add((r << 16) | (g << 8) | b);
  }
  return {width: image.width, height: image.height, colors: colors.size,
    mean: luma / (image.width * image.height), nonBlackFraction: nonBlack / (image.width * image.height)};
}
function difference(first, second) {
  const a = PNG.sync.read(fs.readFileSync(first));
  const b = PNG.sync.read(fs.readFileSync(second));
  assert(a.width === b.width && a.height === b.height);
  let sum = 0, changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let delta = 0;
    for (let c = 0; c < 3; ++c) delta += Math.abs(a.data[i + c] - b.data[i + c]);
    sum += delta / 3;
    changed += delta > 30 ? 1 : 0;
  }
  return {mean: sum / (a.width * a.height), changedFraction: changed / (a.width * a.height)};
}
async function settle(page, count = 30) {
  const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(({frame, count}) => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame + count, {frame, count}, {timeout: 60000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
}
(async () => {
  let browser;
  try {
    const packageFile = path.join(results, 'web-project-material-lab-package-results.json');
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    assert.equal(packaged.layout.samples.length, 16);
    assert.equal(packaged.layout.sourceMap, '/Engine/Maps/Templates/Template_Default');
    report.packageReport = audit(packageFile);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1280, height: 900}});
      const run = {browser: name, version: browser.version(), pass: false, errors: [], log: [], images: {}};
      report.runs.push(run);
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        run.log.push(message.text());
        if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text())) run.errors.push(message.text());
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.route('**/material-lab/index.html', async route => {
        const response = await route.fetch();
        const html = await response.text();
        const original = "arguments: ['-webgpu', '-WebProjectMap=/Game/WebMaterialLab'],";
        assert(html.includes(original));
        await route.fulfill({response, body: html.replace(original,
          "arguments: ['-webgpu', '-WebProjectMap=/Game/WebMaterialLab', '-WebVisualTestClock'],")});
      });
      await page.goto('http://127.0.0.1:8765/build/material-lab/index.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= 60, null, {timeout: 90000});
      assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
      assert.equal(await page.evaluate(() => globalThis.__webEngineWorld?.package), '/Game/WebMaterialLab');
      await page.locator('#lab:not([hidden])').waitFor();
      const shot = async tag => {
        await settle(page);
        const file = path.join(results, `material-lab-${name.toLowerCase()}-${tag}.png`);
        await page.locator('canvas').screenshot({path: file});
        const stats = pixels(file);
        assert(stats.colors > 256 && stats.nonBlackFraction > 0.5 && stats.mean > 10,
          'Expected a nonblank material scene: ' + JSON.stringify(stats));
        run.images[tag] = {...audit(file), ...stats};
        return file;
      };
      for (const view of ['overview', 'roughness', 'metal', 'specular', 'opacity', 'shadows']) {
        await page.selectOption('#lab-view', view);
        assert.equal(await page.evaluate(() => globalThis.__materialLabView), view);
        assert.equal(await page.evaluate(() => globalThis.__webMaterialLab.visibleSamples),
          view === 'overview' ? 16 : view === 'shadows' ? 0 : 4);
        await shot(view);
      }
      run.effects = {};
      for (const [tag, view, mode] of [
        ['skyLightAndReflection', 'metal', '2'], ['sunSpecular', 'metal', '3'],
        ['sunLight', 'roughness', '1'], ['shadows', 'shadows', '4']
      ]) {
        await page.selectOption('#lab-view', view);
        await page.selectOption('#lab-light', '0');
        const baseline = await shot(tag + '-baseline');
        await page.selectOption('#lab-light', mode);
        const disabled = await shot(tag + '-disabled');
        run.effects[tag] = difference(baseline, disabled);
        await page.selectOption('#lab-light', '0');
        const restored = await shot(tag + '-restored');
        run.effects[tag].restore = difference(baseline, restored);
        assert(run.effects[tag].changedFraction > 0.001, tag + ' must visibly affect the scene');
        assert(run.effects[tag].mean > run.effects[tag].restore.mean * 2,
          tag + ' must exceed the restored-image variation');
      }
      await page.selectOption('#lab-view', 'overview');
      await page.setViewportSize({width: 390, height: 844});
      await shot('portrait');
      run.ui = await page.locator('#lab').evaluate(element => ({
        width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth,
        height: element.getBoundingClientRect().height
      }));
      assert(run.ui.scrollWidth <= run.ui.width + 1, 'The controls must fit a narrow viewport');
      await page.screenshot({path: path.join(results, `material-lab-${name.toLowerCase()}-portrait-page.png`)});
      await page.setViewportSize({width: 1440, height: 900});
      await shot('desktop-restored');
      await page.screenshot({path: path.join(results, `material-lab-${name.toLowerCase()}-page.png`)});
      run.runtime = await page.evaluate(() => ({
        frames: globalThis.__webEngineFrames, camera: globalThis.__webDefaultCamera,
        gpuErrors: globalThis.__webCanvas.gpuErrors, drawCalls: globalThis.__webCanvas.drawCalls,
        heap: globalThis.__webEngineRuntime?.heapBytes
      }));
      assert.deepEqual(run.errors, []);
      assert.deepEqual(run.runtime.gpuErrors, []);
      assert(run.runtime.drawCalls > 100);
      run.pass = true;
      await browser.close();
      browser = null;
      console.log(JSON.stringify({browser: name, pass: run.pass, effects: run.effects}));
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-material-lab-browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure}));
  }
})();
