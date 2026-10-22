const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, errors: [], fixedVisualClock: true,
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};
let browser;
let page;

async function capture(mode, name) {
  assert.equal(await page.evaluate(mode => Module._WebDefaultCloudTracingTestMode(mode), mode), 1);
  const first = await page.evaluate(() => globalThis.__webEngineFrames);
  await page.waitForFunction(frame => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame + 240, first, {timeout: 90000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
  const file = path.join(directory, `web-cloud-reconstruction-quality-${name}.png`);
  const image = PNG.sync.read(await page.locator('canvas').screenshot({path: file}));
  report[name] = audit(file);
  return image;
}

function difference(a, b, minY, maxY) {
  assert(a.width === b.width && a.height === b.height);
  let total = 0, changed = 0, count = 0;
  for (let y = Math.ceil(a.height * minY); y < a.height * maxY; ++y)
  for (let x = 2; x < a.width - 2; ++x) {
    const offset = (y * a.width + x) * 4;
    let delta = 0;
    for (let channel = 0; channel < 3; ++channel)
      delta += Math.abs(a.data[offset + channel] - b.data[offset + channel]);
    total += delta / 3;
    changed += delta > 30;
    ++count;
  }
  return {mean: total / count, changedFraction: changed / count};
}

(async () => {
  try {
    const file = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(file);
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
      valid(packaged.buildReport) && valid(packaged.stageReport));
    report.packageReport = audit(file);
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width: 1100, height: 760}});
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    await page.addInitScript(require('./capture-web-canvas.cjs'));
    const root = 'http://127.0.0.1:8765/build/ue-default-template/';
    await page.route(root + 'index.html', async route => {
      const response = await route.fetch();
      const html = await response.text();
      const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
      assert(html.includes(original));
      await route.fulfill({response, body: html.replace(original,
        "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
    });
    await page.goto(root + 'index.html', {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 240, null, {timeout: 90000});
    report.clock = await page.evaluate(() => globalThis.__webVisualTestClock);
    assert(report.clock?.renderTimeFrozen && report.clock.deltaSeconds > 0.00001);
    const before = await capture(1, 'full-resolution');
    const optimized = await capture(0, 'reconstructed');
    const restored = await capture(1, 'restored');
    report.sky = difference(before, optimized, 0.01, 0.35);
    report.floor = difference(before, optimized, 0.65, 0.95);
    report.restore = difference(before, restored, 0.01, 0.95);
    report.gpuErrors = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
    assert(report.sky.mean < 3 && report.sky.changedFraction < 0.1 &&
      report.floor.mean < 1 && report.restore.mean < 1,
    'Cloud reconstruction must stay close to the original while preserving the floor and repeatability.');
    assert(!report.errors.length && !report.gpuErrors.length);
    report.pass = true;
  } catch (error) { report.failure = error.stack || String(error); }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, 'web-cloud-reconstruction-quality-results.json'),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
})();
