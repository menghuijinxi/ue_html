const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const results = path.join(__dirname, 'results');
const baselineOnly = process.argv.includes('--baseline');
const baselineFile = path.join(results, 'web-default-samples-baseline.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, baselineOnly, runs: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};
function difference(aFile, bFile, circle) {
  const a = PNG.sync.read(fs.readFileSync(aFile)), b = PNG.sync.read(fs.readFileSync(bFile));
  assert(a.width === b.width && a.height === b.height);
  let sum = 0, count = 0;
  for (let y = 0; y < a.height; ++y)
    for (let x = 0; x < a.width; ++x) {
      if (circle && Math.hypot(x - circle.x, y - circle.y) > circle.radius) continue;
      const offset = (y * a.width + x) * 4;
      for (let c = 0; c < 3; ++c) sum += Math.abs(a.data[offset + c] - b.data[offset + c]);
      ++count;
    }
  assert(count > 0);
  return sum / (count * 3);
}
async function settle(page) {
  const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(frame => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame + 180, frame, {timeout: 60000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
}
(async () => {
  let browser;
  try {
    const packageFile = path.join(results, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.packageReport = audit(packageFile);
    const config = packaged.products.find(item => path.basename(item.file) === 'config-files.json');
    report.configHash = config.sha256;
    const baseline = !baselineOnly && !process.argv.includes('--no-baseline') &&
      fs.existsSync(baselineFile) ? read(baselineFile) : null;
    if (baseline) {
      assert(baseline.pass && baseline.runs[0].images.original && valid(baseline.runs[0].images.original));
      assert.equal(report.configHash, baseline.configHash, 'All original runtime config files must remain byte-identical');
      report.baseline = audit(baselineFile);
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ...(!baselineOnly ? [['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']] : [])
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1280, height: 900}});
      const run = {browser: name, errors: [], images: {}};
      report.runs.push(run);
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text())) run.errors.push(message.text());
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
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
      await settle(page);
      const shot = async tag => {
        await settle(page);
        const file = path.join(results, `default-samples-${name.toLowerCase()}-${tag}.png`);
        await page.locator('canvas').screenshot({path: file});
        run.images[tag] = audit(file);
        return file;
      };
      run.camera = await page.evaluate(() => globalThis.__webDefaultCamera);
      if (baselineOnly) {
        assert.equal(await page.evaluate(() => globalThis.__webDefaultSamples || null), null);
        await shot('original');
      } else {
        assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(1)), 1);
        run.samples = await page.evaluate(() => globalThis.__webDefaultSamples);
        assert.equal(run.samples.count, 8);
        assert(run.samples.visible && run.samples.sceneUnchanged);
        assert.equal(run.samples.camera.fov, 75);
        for (const sample of run.samples.samples) {
          assert.equal(sample.metallic, sample.row);
          assert.equal(sample.roughness, [0.05, 0.25, 0.6, 1][sample.column]);
          assert.equal(sample.specular, 0.5);
        }
        const visible = await shot('visible');
        assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(-1)), 0);
        assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(0)), 1);
        const hidden = await shot('hidden');
        run.visibilityDifference = difference(visible, hidden);
        assert(run.visibilityDifference > 1);
        const image = PNG.sync.read(fs.readFileSync(visible));
        run.spherePixels = run.samples.samples.map(sample => {
          const circle = {x: sample.screen.x * image.width / run.samples.viewport.width,
            y: sample.screen.y * image.height / run.samples.viewport.height,
            radius: sample.screen.radius * image.width / run.samples.viewport.width * 0.65};
          assert(circle.x - circle.radius > 0 && circle.x + circle.radius < image.width &&
            circle.y - circle.radius > 0 && circle.y + circle.radius < image.height, 'Each sphere must fit the original camera');
          const mean = difference(visible, hidden, circle);
          assert(mean > 8, 'Each expected sphere must change actual canvas pixels: ' + JSON.stringify({sample, circle, mean}));
          return {row: sample.row, column: sample.column, circle, mean};
        });
        if (baseline) {
          assert.deepEqual(run.camera, baseline.runs[0].camera, 'Original camera must remain unchanged');
          run.originalDifference = difference(hidden, baseline.runs[0].images.original.file);
          assert(run.originalDifference < 5, 'Hiding only new spheres must reproduce the original scene');
        }
        assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(1)), 1);
        const restored = await shot('restored');
        run.restoredDifference = difference(visible, restored);
        assert(run.restoredDifference < 5);
        assert((await page.evaluate(() => globalThis.__webDefaultSamples)).sceneUnchanged);
      }
      run.frames = await page.evaluate(() => globalThis.__webEngineFrames);
      run.gpuErrors = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
      assert.equal(run.errors.length + run.gpuErrors.length, 0);
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(baselineOnly ? baselineFile : path.join(results, 'web-default-samples-results.json'),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
