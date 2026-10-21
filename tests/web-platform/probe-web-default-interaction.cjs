const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const name = option('browser') || 'Chrome';
const seconds = Number(option('seconds') ?? 600);
const denyPointerLock = option('pointer-lock') === 'denied';
assert(['Chrome', 'Edge'].includes(name) && Number.isFinite(seconds) && seconds >= 0);
const suffix = name.toLowerCase() + (denyPointerLock ? '-drag' : '');
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), browser: name, durationSeconds: seconds,
  denyPointerLock, pass: false,
  errors: [], samples: [], checks: [], sourceFiles: [__filename].map(audit)};
const reportFile = path.join(directory, `web-default-interaction-${suffix}-results.json`);
let browser;
let page;

async function frames(count) {
  const start = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= target, start + count, {timeout: 60000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
}

async function sample() {
  const result = await page.evaluate(() => ({
    frames: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure || null,
    camera: globalThis.__webDefaultCamera || null, runtime: globalThis.__webEngineRuntime || null,
    gpuErrors: globalThis.__webCanvas.gpuErrors
  }));
  assert(!result.failure && !result.gpuErrors.length && !report.errors.length);
  return result;
}

async function screenshot(label) {
  const file = path.join(directory, `web-default-interaction-${suffix}-${label}.png`);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
  await page.locator('canvas').screenshot({path: file});
  return audit(file);
}

function difference(first, second) {
  const a = PNG.sync.read(fs.readFileSync(first.file));
  const b = PNG.sync.read(fs.readFileSync(second.file));
  assert(a.width === b.width && a.height === b.height);
  let changed = 0, total = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) +
      Math.abs(a.data[i + 2] - b.data[i + 2]);
    total += delta / 3;
    if (delta > 30) ++changed;
  }
  return {mean: total / (a.width * a.height), changedFraction: changed / (a.width * a.height)};
}

async function hold(key, count = 45) {
  await page.keyboard.down(key);
  try { await frames(count); }
  finally { await page.keyboard.up(key); }
  await frames(30);
}

(async () => {
  try {
    const packageFile = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
      valid(packaged.buildReport) && valid(packaged.stageReport));
    report.packageReport = audit(packageFile);
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width: 1100, height: 760}});
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    page.on('console', message => {
      if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text()))
        report.errors.push(message.text());
    });
    if (denyPointerLock)
      await page.addInitScript(() => {
        HTMLElement.prototype.requestPointerLock = () =>
          Promise.reject(new DOMException('Pointer lock unavailable in this browser', 'UnknownError'));
      });
    await page.addInitScript(require('./capture-web-canvas.cjs'));
    await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
    await frames(120);
    const bounds = await page.locator('canvas').boundingBox();
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await frames(30);
    const initial = await sample();
    assert(initial.camera && Math.abs(initial.camera.pitch + 15) < 1 &&
      Math.abs(initial.camera.yaw - 120) < 1, 'The first click must not jump the camera.');
    report.before = await screenshot('before');
    await hold('w', 60);
    report.moved = await screenshot('moved');
    report.imageDifference = difference(report.before, report.moved);
    assert(report.imageDifference.mean > 1 && report.imageDifference.changedFraction > 0.05,
      'Holding W must move the rendered UE view; a ticking counter with a fixed camera is insufficient.');
    const moved = await sample();
    assert(initial.camera && moved.camera);
    const distance = Math.hypot(...['x', 'y', 'z'].map(key => moved.camera[key] - initial.camera[key]));
    assert(distance > 50, 'The actual UE pawn must move.');
    report.checks.push({name: 'forward', distance, pass: true});
    await page.mouse.move(550, 380);
    await frames(5);
    const beforeLook = await sample();
    if (denyPointerLock) await page.mouse.down({button: 'right'});
    await page.mouse.move(650, 410, {steps: 10});
    if (denyPointerLock) await page.mouse.up({button: 'right'});
    await frames(30);
    const looked = await sample();
    const angleDifference = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
    const yaw = angleDifference(looked.camera.yaw, beforeLook.camera.yaw);
    const pitch = angleDifference(looked.camera.pitch, beforeLook.camera.pitch);
    assert(yaw > 1 && pitch > 1, 'Real mouse movement must rotate the UE view.');
    report.looked = await screenshot('looked');
    report.checks.push({name: 'mouse-look', yaw, pitch, pass: true});
    const beforeSide = await sample();
    await hold('d');
    const side = await sample();
    assert(Math.hypot(side.camera.x - beforeSide.camera.x, side.camera.y - beforeSide.camera.y) > 30);
    report.checks.push({name: 'strafe', pass: true});
    const beforeUp = await sample();
    await hold('e');
    const up = await sample();
    assert(up.camera.z > beforeUp.camera.z + 30);
    await hold('q');
    const down = await sample();
    assert(down.camera.z < up.camera.z - 30);
    report.checks.push({name: 'up-and-down', pass: true});
    await page.keyboard.down('w');
    await frames(15);
    await page.evaluate(() => {
      document.exitPointerLock();
      document.querySelector('canvas').blur();
      window.dispatchEvent(new Event('blur'));
    });
    await page.keyboard.up('w');
    await frames(60);
    const blurred = await sample();
    await frames(90);
    const idle = await sample();
    assert(Math.hypot(...['x', 'y', 'z'].map(key => idle.camera[key] - blurred.camera[key])) < 1,
      'Losing focus while moving must release keys.');
    report.checks.push({name: 'blur-releases-input', pass: true});
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const refocused = await sample();
    await hold('s', 15);
    const recovered = await sample();
    assert(Math.hypot(...['x', 'y', 'z'].map(key => recovered.camera[key] - refocused.camera[key])) > 10,
      'Clicking the canvas again must restore movement after focus loss.');
    report.checks.push({name: 'focus-recovery', pass: true});
    const locked = await page.evaluate(() => document.pointerLockElement?.id === 'canvas');
    assert.equal(locked, !denyPointerLock, 'Clicking again must restore the expected mouse capture mode.');
    const started = Date.now();
    let reportedAt = -30;
    let previous = await sample();
    console.log(JSON.stringify({phase: 'interaction-passed', browser: name, denyPointerLock}));
    while (Date.now() - started < seconds * 1000) {
      await frames(120);
      const current = await sample();
      assert(current.frames > previous.frames && current.runtime,
        'The engine must continue ticking and publishing memory/statistics diagnostics.');
      assert(current.runtime.statsHistoryFrames < 64 &&
        current.runtime.gameFrame - current.runtime.endOfPipeFrame < 10,
        'Completed statistics frames must retire instead of accumulating until out of memory.');
      report.samples.push({...current, elapsedSeconds: (Date.now() - started) / 1000});
      const elapsedSeconds = (Date.now() - started) / 1000;
      if (elapsedSeconds >= reportedAt + 30) {
        reportedAt = elapsedSeconds;
        console.log(JSON.stringify({phase: 'soak', browser: name, elapsedSeconds, frames: current.frames,
          ...current.runtime}));
      }
      previous = current;
      // Keep the test's own GPU observations bounded during the soak.
      await page.evaluate(() => {
        for (const key of ['acquisitions', 'debugMarkers', 'depthTextures', 'depthViews', 'depthPasses'])
          globalThis.__webCanvas[key].splice(0);
      });
    }
    if (seconds >= 60) {
      const warm = report.samples.filter(item => item.elapsedSeconds >= Math.min(60, seconds / 2));
      const heaps = warm.map(item => item.runtime.heapBytes);
      report.heapGrowthBytes = Math.max(...heaps) - Math.min(...heaps);
      assert(report.heapGrowthBytes < 64 * 1024 * 1024, 'Linear memory must stabilize after warmup.');
    }
    const beforeFinalInput = await sample();
    await hold('a', 15);
    const afterFinalInput = await sample();
    assert(Math.hypot(...['x', 'y', 'z'].map(key =>
      afterFinalInput.camera[key] - beforeFinalInput.camera[key])) > 10,
    'Movement must still work after the soak.');
    report.checks.push({name: 'movement-after-soak', pass: true});
    report.after = await screenshot('after');
    report.final = await sample();
    report.actualDurationSeconds = (Date.now() - started) / 1000;
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (page && !report.pass) {
      try { report.failureState = await sample(); } catch {}
    }
    if (browser) await browser.close();
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browser: name, checks: report.checks,
      frames: report.final?.frames, seconds: report.actualDurationSeconds,
      heapGrowthBytes: report.heapGrowthBytes, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
