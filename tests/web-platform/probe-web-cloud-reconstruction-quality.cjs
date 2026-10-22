const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const budget = option('cloud-budget') === undefined ? null : Number(option('cloud-budget'));
const diagnosticRuntime = process.argv.includes('--diagnostic-runtime');
const checkMotion = process.argv.includes('--motion');
const browserName = option('browser') || 'Chrome';
const views = (option('views') || 'default').split(',');
const directions = {default: [-15, 120], cloudbank: [20, 120], cloudback: [20, 300],
  horizon: [0, 120], sky: [70, 120]};
const suffix = option('report') || '';
assert((budget === null || Number.isInteger(budget) && budget >= 0 && budget <= 10) &&
  views.every(view => Object.hasOwn(directions, view)) && /^[a-z0-9-]*$/.test(suffix) &&
  ['Chrome', 'Edge'].includes(browserName));
const artifact = `web-cloud-reconstruction-quality${suffix ? '-' + suffix : ''}`;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, errors: [], fixedVisualClock: true,
  budget, views, diagnosticRuntime, checkMotion, browser: browserName, comparisons: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs'),
    path.join(__dirname, 'aim-web-default-camera.cjs')].map(audit)};
let browser;
let page;

async function frames(count) {
  const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= target, first + count, {timeout: 90000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
}

async function capture(mode, profile, name) {
  if (profile !== null)
    assert.equal(await page.evaluate(mode => Module._WebDefaultCloudBudgetTestMode(mode), profile), 1);
  assert.equal(await page.evaluate(() => Module._WebDefaultSceneTestMode(0)), 1);
  assert.equal(await page.evaluate(mode => Module._WebDefaultCloudTracingTestMode(mode), mode), 1);
  await frames(240);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
  const file = path.join(directory, `${artifact}-${name}.png`);
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
      (diagnosticRuntime || valid(packaged.buildReport)) && valid(packaged.stageReport));
    report.packageReport = audit(file);
    let runtime;
    if (diagnosticRuntime) {
      const file = path.join(directory, 'web-engine-full-build-results.json');
      runtime = read(file);
      assert(runtime.pass && runtime.fullLinkAttempted && runtime.sourceFiles.every(valid) &&
        runtime.products.every(valid));
      report.diagnosticBuildReport = audit(file);
    }
    browser = await chromium.launch({headless: true, executablePath: browserName === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width: 1100, height: 760}});
    if (runtime) for (const name of ['UEWebEngine.js', 'UEWebEngine.wasm']) {
      const product = runtime.products.find(item => path.basename(item.file) === name);
      assert(valid(product));
      const relative = `build/diagnostic-cloud-runtime/${report.diagnosticBuildReport.sha256.slice(0, 16)}/${name}`;
      const file = path.join(__dirname, relative);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.copyFileSync(product.file, file);
      assert.equal(audit(file).sha256, product.sha256);
      (report.diagnosticProducts ||= []).push(audit(file));
      await page.route('**/build/ue-default-template/' + name,
        route => route.continue({url: 'http://127.0.0.1:8765/' + relative}));
    }
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
    for (const view of views) {
      const [pitch, yaw] = directions[view];
      const camera = await page.evaluate(() => globalThis.__webDefaultCamera);
      if (Math.abs(camera.pitch - pitch) > 1 ||
          Math.abs(((yaw - camera.yaw + 540) % 360) - 180) > 1)
        await require('./aim-web-default-camera.cjs')(page, frames, pitch, yaw);
      const prefix = views.length > 1 ? view + '-' : '';
      const before = await capture(budget === null ? 1 : 0, budget === null ? null : 7,
        prefix + (budget === null ? 'full-resolution' : 'reference'));
      const optimized = await capture(0, budget, prefix + 'reconstructed');
      const restored = await capture(budget === null ? 1 : 0, budget === null ? null : 7, prefix + 'restored');
      const comparison = {view, sky: difference(before, optimized, 0.01, 0.35),
        floor: difference(before, optimized, 0.65, 0.95),
        restore: difference(before, restored, 0.01, 0.95)};
      report.comparisons.push(comparison);
      console.log(JSON.stringify(comparison));
    }
    if (checkMotion) {
      assert.equal(await page.evaluate(mode => Module._WebDefaultCloudBudgetTestMode(mode), budget ?? 0), 1);
      assert.equal(await page.evaluate(() => Module._WebDefaultCloudTracingTestMode(0)), 1);
      await frames(60);
      const camera = await page.evaluate(() => globalThis.__webDefaultCamera);
      await require('./aim-web-default-camera.cjs')(page, frames, 20, (camera.yaw + 60) % 360, true);
      assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      const file = path.join(directory, artifact + '-motion.png');
      const moved = PNG.sync.read(await page.locator('canvas').screenshot({path: file}));
      report.motionScreenshot = audit(file);
      const reference = await capture(0, 7, 'motion-reference');
      report.motion = difference(moved, reference, 0.01, 0.95);
      assert(report.motion.mean < 3 && report.motion.changedFraction < 0.1,
        'A visible-cloud turn must remain close to the settled reference at the same camera.');
    }
    report.gpuErrors = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
    assert(report.comparisons.every(item => item.sky.mean < 3 && item.sky.changedFraction < 0.1 &&
      (item.view !== 'default' || item.floor.mean < 1) && item.restore.mean < 1),
    'Cloud reconstruction must stay close to the original while preserving the floor and repeatability.');
    assert(!report.errors.length && !report.gpuErrors.length);
    report.pass = true;
  } catch (error) { report.failure = error.stack || String(error); }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, artifact + '-results.json'),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (!report.pass) process.exitCode = 1;
  }
})();
