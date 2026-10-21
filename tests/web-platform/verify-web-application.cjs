const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64', browserRuns: [],
  launchRuntimeVerified: false, completeBrowserUERuntime: false};
const nextFrames = page => page.evaluate(() => new Promise(resolve => {
  let count = 0;
  function tick() { if (++count === 4) resolve(); else requestAnimationFrame(tick); }
  requestAnimationFrame(tick);
}));
(async () => {
  let browser;
  let activePage;
  try {
    const target = JSON.parse(fs.readFileSync(path.join(__dirname, 'results/web-application-target-results.json'), 'utf8'));
    assert(target.pass && target.buildSucceeded);
    const staged = path.join(__dirname, 'build/web-application');
    fs.mkdirSync(staged, {recursive: true});
    for (const [file, hash] of [[target.jsFile, target.jsSha256], [target.wasmFile, target.wasmSha256]]) {
      assert.equal(sha(file), hash);
      fs.copyFileSync(file, path.join(staged, path.basename(file)));
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      for (const [profile, viewport, deviceScaleFactor] of [
        ['desktop', {width: 1280, height: 800}, 1],
        ['narrow', {width: 390, height: 844}, 2]]) {
        const context = await browser.newContext({viewport, deviceScaleFactor});
        const page = await context.newPage();
        activePage = page;
        report.currentRun = {browser: name, profile};
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const checks = [];
        const check = (condition, label) => { assert(condition, label); checks.push(label); };
        await page.goto('http://127.0.0.1:8765/web-application.html');
        await page.waitForFunction(() => globalThis.__webApplicationFailure ||
          (globalThis.__webApplicationReady && globalThis.__webApplicationFrames >= 3), null, {timeout: 30000});
        assert.equal(await page.evaluate(() => globalThis.__webApplicationFailure || null), null);
        assert.deepEqual(await page.evaluate(() => globalThis.__webApplicationReady),
          {pointerBytes: 8, mainLoop: 'requestAnimationFrame', windowIdentity: true, windowed: true});
        const first = await page.evaluate(() => globalThis.__webApplicationFrames);
        await nextFrames(page);
        check(await page.evaluate(n => globalThis.__webApplicationFrames > n, first), 'browser-frames-advance');
        const display = await page.evaluate(() => globalThis.__webApplicationDisplayInfo);
        const css = await page.locator('#canvas').boundingBox();
        check(display.x === 0 && display.y === 0 && display.width === Math.round(css.width * deviceScaleFactor) &&
          display.height === Math.round(css.height * deviceScaleFactor) && display.scale === deviceScaleFactor,
        'canvas-display-bounds-match-device-pixels');
        await page.locator('#canvas').click({position: {x: 40, y: 50}});
        await page.keyboard.down('Shift');
        await page.keyboard.down('KeyW');
        await page.keyboard.down('KeyW');
        await page.keyboard.up('KeyW');
        await page.keyboard.up('Shift');
        const box = await page.locator('#canvas').boundingBox();
        await page.mouse.move(box.x + 80, box.y + 90);
        await page.locator('#canvas').evaluate(canvas => canvas.addEventListener('wheel', event => {
          globalThis.__webApplicationDOMWheel = {deltaY: event.deltaY, deltaMode: event.deltaMode};
        }, {passive: true}));
        await page.mouse.wheel(0, 100);
        await page.waitForFunction(() => globalThis.__webApplicationEvents.some(e => e.type === 'wheel'));
        await page.mouse.down();
        await page.mouse.move(8, box.y + box.height + 12);
        await page.mouse.up();
        await page.keyboard.down('Shift');
        await page.keyboard.down('KeyA');
        await page.locator('#html-ui').click();
        await nextFrames(page);
        await page.keyboard.up('KeyA');
        await page.keyboard.up('Shift');
        const events = await page.evaluate(() => globalThis.__webApplicationEvents);
        check(events.some(e => e.type === 'keyDown' && e.key === 87 && e.shift && !e.repeat), 'ue-key-down-with-shift');
        check(events.some(e => e.type === 'keyDown' && e.key === 87 && e.repeat), 'ue-key-repeat');
        check(events.some(e => e.type === 'keyUp' && e.key === 87), 'ue-key-up');
        check(events.some(e => e.type === 'char' && e.value === 87), 'ue-ascii-character');
        check(events.some(e => e.type === 'move' && e.x === 80 * deviceScaleFactor &&
          e.y === 90 * deviceScaleFactor), 'ue-canvas-mouse-position');
        check(events.filter(e => e.type === 'mouseDown' && e.button === 0).length === 2 &&
          events.filter(e => e.type === 'mouseUp' && e.button === 0).length === 2 &&
          events.some(e => e.type === 'mouseUp' && e.x === Math.round((8 - box.x) * deviceScaleFactor) &&
            e.y === Math.round((box.height + 12) * deviceScaleFactor)),
        'mouse-release-outside-canvas');
        const domWheel = await page.evaluate(() => globalThis.__webApplicationDOMWheel);
        check(domWheel.deltaMode === 0 && domWheel.deltaY > 0 &&
          events.some(e => e.type === 'wheel' && e.delta === -domWheel.deltaY / 100), 'ue-wheel-direction');
        check(events.some(e => e.type === 'focus' && e.active) &&
          events.some(e => e.type === 'focus' && !e.active) &&
          events.some(e => e.type === 'keyUp' && e.key === 65), 'blur-releases-held-key');
        const keysBefore = events.filter(e => e.type === 'keyDown').length;
        await page.locator('#html-ui').pressSequentially('html-ui');
        await nextFrames(page);
        check(await page.locator('#html-ui').inputValue() === 'html-ui' &&
          await page.evaluate(() => globalThis.__webApplicationEvents.filter(e => e.type === 'keyDown').length) === keysBefore,
        'html-ui-keeps-keyboard-input');
        await page.locator('#canvas').evaluate(canvas => { canvas.style.width = '320px'; canvas.style.height = '180px'; });
        await page.waitForFunction(scale => globalThis.__webApplicationEvents.some(e =>
          e.type === 'resize' && e.width === 320 * scale && e.height === 180 * scale), deviceScaleFactor);
        const size = await page.locator('#canvas').evaluate(canvas => ({width: canvas.width, height: canvas.height}));
        check(size.width === 320 * deviceScaleFactor && size.height === 180 * deviceScaleFactor, 'canvas-resize-and-dpi');
        await nextFrames(page);
        const resizedDisplay = await page.evaluate(() => globalThis.__webApplicationDisplayInfo);
        check(resizedDisplay.x === 0 && resizedDisplay.y === 0 && resizedDisplay.width === 320 * deviceScaleFactor &&
          resizedDisplay.height === 180 * deviceScaleFactor && resizedDisplay.scale === deviceScaleFactor,
        'resized-display-bounds-match-device-pixels');
        await page.locator('#stop').click();
        const stopped = await page.evaluate(() => globalThis.__webApplicationStopped);
        check(stopped && stopped.frames > first, 'ue-stop-and-destroy');
        const eventsAfterStop = await page.evaluate(() => globalThis.__webApplicationEvents.length);
        await page.locator('#canvas').click();
        await page.keyboard.press('KeyD');
        await nextFrames(page);
        check(await page.evaluate(() => globalThis.__webApplicationFrames) === stopped.frames, 'main-loop-stays-stopped');
        check(await page.evaluate(() => globalThis.__webApplicationEvents.length) === eventsAfterStop, 'destroy-removes-input-callbacks');
        check(await page.evaluate(() => Module._WebApplicationStop()) === stopped.frames, 'stop-is-idempotent');
        assert.deepEqual(errors, []);
        report.browserRuns.push({browser: name, version: browser.version(), profile, viewport,
          deviceScaleFactor, ready: true, stopped, checks, domWheel,
          display, resizedDisplay,
          events: await page.evaluate(() => globalThis.__webApplicationEvents),
          errors, pass: true});
        await context.close();
        activePage = null;
      }
      await browser.close();
      browser = null;
    }
    const stagedFiles = [target.jsFile, target.wasmFile].map(file => {
      const copied = path.join(staged, path.basename(file));
      assert.equal(sha(copied), sha(file));
      return {file: copied, sha256: sha(copied)};
    });
    Object.assign(report, {pass: true, browserMainLoopVerified: true, applicationCoreInputVerified: true,
      targetReportSha256: sha(path.join(__dirname, 'results/web-application-target-results.json')),
      jsFile: target.jsFile, jsSha256: sha(target.jsFile), wasmFile: target.wasmFile, wasmSha256: sha(target.wasmFile),
      stagedFiles, sourceFiles: ['web-application.html', 'verify-web-application.cjs'].map(name => {
        const file = path.join(__dirname, name);
        return {file, sha256: sha(file)};
      }),
      boundary: 'Normal wasm64 ApplicationCore Program, with requestAnimationFrame driving a supplied UE callback and the real GenericApplicationMessageHandler receiving queued canvas keyboard/mouse/wheel/focus/resize events. Desktop and narrow desktop-browser viewports at DPR 1/2 are tested; these are not mobile-device tests. One canvas, legacy DOM key codes and ASCII character input only. No Launch/FEngineLoop, Engine, Renderer, scene, IME, touch, gamepad, pointer lock, browser fullscreen or native cursor shapes are verified.'});
    delete report.currentRun;
  } catch (error) {
    report.failure = error.stack;
    if (activePage && !activePage.isClosed())
      report.failureState = await activePage.evaluate(() => ({
        events: globalThis.__webApplicationEvents, frames: globalThis.__webApplicationFrames,
        failure: globalThis.__webApplicationFailure || null
      })).catch(() => null);
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-application-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, runs: report.browserRuns.map(run =>
      ({browser: run.browser, profile: run.profile, checks: run.checks.length, pass: run.pass})),
      failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
