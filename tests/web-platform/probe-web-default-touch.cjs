const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const suffix = process.argv.find(value => value.startsWith('--report='))?.slice(9) || 'current';
assert(/^[a-z0-9-]+$/.test(suffix));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file &&
  crypto.createHash('sha256').update(fs.readFileSync(item.file)).digest('hex') === item.sha256;
const angle = (a, b) => ((a - b + 540) % 360) - 180;
const report = {date: new Date().toISOString(), pass: false, emulatedTouch: true,
  sources: [__filename, path.join(__dirname, 'web-default-template.html')].map(audit), runs: []};
let browser;
(async () => {
  try {
    const file = path.join(directory, 'web-default-template-package-results.json');
    const packaged = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.packageReport = audit(file);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({headless: true, executablePath});
      for (const viewport of [{width: 360, height: 626}, {width: 844, height: 390}]) {
        const run = {browser: name, version: browser.version(), viewport, dpr: 3,
          pass: false, errors: [], checks: []};
        report.runs.push(run);
        const context = await browser.newContext({viewport, deviceScaleFactor: 3,
          isMobile: true, hasTouch: true});
        const page = await context.newPage();
        page.on('pageerror', error => run.errors.push(error.stack || error.message));
        page.on('console', message => {
          if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text()))
            run.errors.push(message.text());
        });
        try {
          await page.addInitScript(() => {
            globalThis.__touchProbe = {mouse: [], pointerLockRequests: 0};
            HTMLElement.prototype.requestPointerLock = () => {
              ++globalThis.__touchProbe.pointerLockRequests;
              return Promise.reject(new Error('Touch must not request pointer lock'));
            };
            addEventListener('DOMContentLoaded', () => {
              const canvas = document.getElementById('canvas');
              for (const type of ['mousedown', 'mousemove', 'mouseup'])
                canvas.addEventListener(type, event => globalThis.__touchProbe.mouse.push({
                  type, button: event.button, buttons: event.buttons,
                  dx: event.movementX, dy: event.movementY
                }));
            });
          });
          await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html',
            {waitUntil: 'commit'});
          async function frames(count = 12) {
            const before = await page.evaluate(() => globalThis.__webEngineFrames || 0);
            await page.waitForFunction(target => globalThis.__webEngineFailure ||
              globalThis.__webEngineFrames >= target, before + count, {timeout: 120000});
            assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
            assert.equal(run.errors.length, 0);
          }
          async function camera() {
            await frames();
            return page.evaluate(() => ({...globalThis.__webDefaultCamera}));
          }
          function unchanged(a, b) {
            assert(Math.abs(angle(a.yaw, b.yaw)) < 0.05 && Math.abs(angle(a.pitch, b.pitch)) < 0.05,
              JSON.stringify({before: b, after: a}));
            assert(Math.hypot(...['x', 'y', 'z'].map(key => a[key] - b[key])) < 1);
          }
          await frames(120);
          const canvas = page.locator('canvas');
          const bounds = await canvas.boundingBox();
          const x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;
          const session = await context.newCDPSession(page);
          const point = (id, x, y) => ({id, x, y});
          const touch = (type, points) => session.send('Input.dispatchTouchEvent',
            {type, touchPoints: points});
          const initial = await camera();
          await touch('touchStart', [point(1, x, y)]);
          unchanged(await camera(), initial);
          await touch('touchMove', [point(1, x + 45, y + 20)]);
          const looked = await camera();
          const yaw = angle(looked.yaw, initial.yaw), pitch = angle(looked.pitch, initial.pitch);
          assert(yaw > 1 && yaw < 40 && pitch < -1 && pitch > -40,
            'Single-finger dragging must rotate the actual UE camera: ' + JSON.stringify({initial, looked}));
          assert(Math.hypot(...['x', 'y', 'z'].map(key => looked[key] - initial[key])) < 1);
          run.checks.push({name: 'single-finger-look', yaw, pitch, pass: true});
          await touch('touchEnd', []);
          unchanged(await camera(), looked);
          const idle = await camera();
          unchanged(await camera(), idle);
          run.checks.push({name: 'release-stops-look', pass: true});

          await touch('touchStart', [point(1, x - 40, y)]);
          unchanged(await camera(), idle);
          await touch('touchEnd', []);
          unchanged(await camera(), idle);
          run.checks.push({name: 'retouch-and-tap-do-not-jump', pass: true});

          await touch('touchStart', [point(1, x, y)]);
          await touch('touchStart', [point(1, x, y), point(2, x + 30, y + 20)]);
          await touch('touchMove', [point(1, x, y), point(2, x + 60, y + 35)]);
          unchanged(await camera(), idle);
          await touch('touchEnd', [point(2, x + 60, y + 35)]);
          await touch('touchMove', [point(2, x + 80, y + 45)]);
          unchanged(await camera(), idle);
          await touch('touchEnd', []);
          run.checks.push({name: 'second-finger-does-not-steal-look', pass: true});

          await touch('touchStart', [point(1, x, y)]);
          await touch('touchMove', [point(1, x - 30, y - 10)]);
          const beforeCancel = await camera();
          await touch('touchCancel', []);
          await page.mouse.move(x + 25, y + 30);
          unchanged(await camera(), beforeCancel);
          run.checks.push({name: 'cancel-releases-mouse', pass: true});

          await touch('touchStart', [point(1, x, y)]);
          await page.evaluate(() => dispatchEvent(new Event('blur')));
          await touch('touchMove', [point(1, x + 15, y + 15)]);
          unchanged(await camera(), beforeCancel);
          await touch('touchEnd', []);
          run.checks.push({name: 'blur-stops-drag', pass: true});

          await touch('touchStart', [point(1, x, y)]);
          await touch('touchMove', [point(1, x + 20, y)]);
          const recovered = await camera();
          assert(angle(recovered.yaw, beforeCancel.yaw) > 1);
          await touch('touchEnd', []);
          run.checks.push({name: 'new-drag-after-cancel', pass: true});
          const state = await page.evaluate(() => ({
            ...globalThis.__touchProbe, scrollX, scrollY,
            scale: visualViewport.scale, touchAction: getComputedStyle(Module.canvas).touchAction
          }));
          assert.equal(state.pointerLockRequests, 0);
          assert.equal(state.scrollX, 0);
          assert.equal(state.scrollY, 0);
          assert.equal(state.scale, 1);
          assert.equal(state.touchAction, 'none');
          assert(state.mouse.filter(item => item.type === 'mousedown').every(item => item.button === 2));
          assert.equal(state.mouse.filter(item => item.type === 'mousedown').length,
            state.mouse.filter(item => item.type === 'mouseup').length);
          run.checks.push({name: 'touch-has-no-scroll-zoom-or-pointer-lock', pass: true});
          run.state = state;
          const screenshot = path.join(directory,
            `web-default-touch-${name.toLowerCase()}-${viewport.width}-${suffix}.png`);
          await canvas.screenshot({path: screenshot});
          run.screenshot = audit(screenshot);
          const image = PNG.sync.read(fs.readFileSync(screenshot));
          let lit = 0;
          for (let offset = 0; offset < image.data.length; offset += 4)
            if (image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 30) ++lit;
          run.image = {width: image.width, height: image.height,
            nonBlackFraction: lit / (image.width * image.height)};
          assert(run.image.nonBlackFraction > 0.9);
          run.canvas = await canvas.evaluate(canvas => ({width: canvas.width, height: canvas.height}));
          assert.equal(run.canvas.width, Math.round(bounds.width * 3));
          assert.equal(run.canvas.height, Math.round(bounds.height * 3));
          // Locator screenshots round the clip to CSS pixels before applying DPR.
          assert(Math.abs(image.width - run.canvas.width) < 3);
          run.pass = true;
        } catch (error) { run.failure = error.stack || String(error); }
        finally { await context.close(); }
        console.log(JSON.stringify({browser: name, viewport, pass: run.pass,
          checks: run.checks, failure: run.failure}));
      }
      await browser.close();
      browser = null;
    }
    report.pass = report.runs.length === 4 && report.runs.every(run => run.pass);
  } finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-default-touch-${suffix}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file}));
    if (!report.pass) process.exitCode = 1;
  }
})();
