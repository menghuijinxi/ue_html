const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {crc32} = require('node:zlib');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const url = 'http://127.0.0.1:8765/build/ue-default-template-threads/index.html';
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), runs: []};
let context;
const state = page => page.evaluate(() => ({
  failure: globalThis.__webEngineFailure || null, frames: globalThis.__webEngineFrames || 0,
  ready: globalThis.__webEngineReady, threads: globalThis.__webEngineThreads,
  runtime: globalThis.__webEngineRuntime, camera: globalThis.__webDefaultCamera,
  surface: globalThis.__webEngineSurface, view: globalThis.__webRenderView,
  local: globalThis.__webLocalContentStats, io: globalThis.__webThreadIOProbe,
  pool: globalThis.__webThreadPool,
  heartbeat: globalThis.testHeartbeat,
  uiHasHeap: typeof HEAPU8 !== 'undefined' || typeof Module._WebProjectViewTest === 'function',
  css: {width: Module.canvas.getBoundingClientRect().width,
    height: Module.canvas.getBoundingClientRect().height, dpr: devicePixelRatio}
}));
async function advance(page, frames = 60) {
  const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(frame => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame, first + frames, {timeout: 180000});
  const result = await state(page);
  assert.equal(result.failure, null);
  return result;
}
async function image(page, name) {
  const file = path.join(directory, `web-engine-threads-${name}.png`);
  const session = await page.context().newCDPSession(page);
  try {
    const box = await page.locator('canvas').boundingBox();
    const capture = await session.send('Page.captureScreenshot', {format: 'png', fromSurface: true,
      captureBeyondViewport: false, clip: {...box, scale: 1}});
    fs.writeFileSync(file, Buffer.from(capture.data, 'base64'));
  } finally { await session.detach(); }
  const png = PNG.sync.read(fs.readFileSync(file));
  let lit = 0, min = 255, max = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const luminance = (png.data[index] + png.data[index + 1] + png.data[index + 2]) / 3;
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    if (luminance > 10) ++lit;
  }
  assert(lit / (png.width * png.height) > 0.9 && max - min > 80, 'Scene must be rendered and nonuniform');
  return {...audit(file), width: png.width, height: png.height, litFraction: lit / (png.width * png.height)};
}
async function visualParity(context, name) {
  const result = {errors: [], images: []};
  for (const threaded of [false, true]) {
    const page = await context.newPage();
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('console', message => {
      if (/GPU validation:|Fatal error:|Assertion failed|DeviceLost/.test(message.text()))
        result.errors.push(message.text());
    });
    await page.route('**/index.html', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: (await response.text()).replace(
        "arguments: ['-webgpu', '-WebDefaultTemplate'],",
        "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
    });
    await page.goto(threaded ? url : url.replace('-threads/', '/'), {waitUntil: 'commit'});
    await advance(page, 180);
    assert.equal(await page.evaluate(() => __webVisualTestClock.renderTimeFrozen), true);
    await page.evaluate(async threaded => {
      if (threaded) await __webEngineRPC('WebProjectViewTest', 650, -400, 10, 15, 110);
      else Module._WebProjectViewTest(650, -400, 10, 15, 110);
    }, threaded);
    await advance(page, 120);
    result.images.push(await image(page, name.toLowerCase() + (threaded ? '-parity-thread' : '-parity-single')));
    await page.close();
  }
  const [baseline, actual] = result.images.map(item => PNG.sync.read(fs.readFileSync(item.file)));
  assert.equal(baseline.width, actual.width);
  assert.equal(baseline.height, actual.height);
  let total = 0, changed = 0;
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; ++channel)
      delta += Math.abs(baseline.data[offset + channel] - actual.data[offset + channel]);
    total += delta;
    if (delta / 3 > 12) ++changed;
  }
  const pixels = baseline.width * baseline.height;
  result.meanDifference = total / (pixels * 3);
  result.changedFraction = changed / pixels;
  assert(result.meanDifference < 3 && result.changedFraction < 0.03,
    'Thread migration must preserve the default scene appearance');
  assert.deepEqual(result.errors, []);
  return result;
}
(async () => {
  try {
    const packageFile = path.join(directory, 'web-default-template-threads-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.threads && packaged.products.every(valid) &&
      packaged.sourceFiles.every(valid) && valid(packaged.buildReport) && valid(packaged.stageReport));
    report.package = audit(packageFile);
    const manifest = read(path.join(packaged.output, 'content-files.json'));
    const bulk = manifest.files.find(file =>
      file.path === '/Engine/Content/EditorMaterials/ParticleSystems/PSysThumbnail_NoImage.ubulk');
    assert(bulk);
    const bytes = Buffer.alloc(32768), descriptor = fs.openSync(path.join(packaged.output, 'content.bin'), 'r');
    try { assert.equal(fs.readSync(descriptor, bytes, 0, bytes.length, bulk.offset + 17), bytes.length); }
    finally { fs.closeSync(descriptor); }
    report.expectedIOCRC = crc32(bytes);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      if (option('browser') && name !== option('browser')) continue;
      const profile = fs.mkdtempSync(path.join(directory, 'engine-threads-' + name.toLowerCase() + '-'));
      context = await chromium.launchPersistentContext(profile, {executablePath, headless: true,
        viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      await context.addInitScript(() => {
        globalThis.testHeartbeat = {count: 0, maximum: 0};
        globalThis.testPointerLock = [];
        for (const name of ['pointerlockchange', 'pointerlockerror'])
          document.addEventListener(name, () =>
            testPointerLock.push({type: name, locked: !!document.pointerLockElement, time: performance.now()}));
        let previous = performance.now();
        setInterval(() => {
          const now = performance.now();
          testHeartbeat.count++;
          testHeartbeat.maximum = Math.max(testHeartbeat.maximum, now - previous);
          previous = now;
        }, 10);
      });
      // Chrome's initial persistent-profile tab rejects pointer lock even on a plain canvas.
      const initialPages = context.pages();
      const page = await context.newPage();
      for (const initial of initialPages) await initial.close();
      const run = {browser: name, version: context.browser()?.version(), pass: false,
        errors: [], log: [], requests: [], views: []};
      report.runs.push(run);
      page.on('pageerror', error => run.errors.push(error.stack));
      page.on('console', message => {
        const text = message.text();
        run.log.push(text);
        if (run.log.length > 100) run.log.shift();
        if (/GPU validation:|Fatal error:|Assertion failed|Local bulk IO failed|DeviceLost/.test(text))
          run.errors.push(text);
      });
      context.on('request', request => {
        if (/\/(?:content\.bin|UEWebEngineThreads\.wasm)(?:\?|$)/.test(request.url()))
          run.requests.push({url: request.url(), method: request.method()});
      });
      await page.goto(url, {waitUntil: 'commit'});
      run.startup = await advance(page, 180);
      assert.equal(run.startup.ready.featureLevel, 3);
      assert.equal(run.startup.ready.shaderPlatform, 47);
      assert(run.startup.threads.sharedMemory && run.startup.threads.engineWorker &&
        run.startup.threads.gameThread !== run.startup.threads.taskThread);
      assert(!run.startup.threads.renderThread && !run.startup.threads.rhiThread);
      assert(!run.startup.uiHasHeap, 'The browser UI must not own an Engine WASM instance');
      assert.equal(run.startup.local.bulkMemfsBytes, 0);
      assert(run.startup.local.memoryBytes <= run.startup.local.memoryLimit);
      assert(run.startup.pool.active > 0 && run.startup.pool.active + run.startup.pool.available === 16);
      run.startup.image = await image(page, name.toLowerCase() + '-startup');

      const before = await state(page);
      const taskThread = await page.evaluate(() => __webEngineRPC('WebThreadTestControl', 1));
      const after = await state(page);
      run.blocking = {taskThread, uiTicks: after.heartbeat.count - before.heartbeat.count,
        maximum: after.heartbeat.maximum};
      assert(taskThread && taskThread !== before.threads.gameThread);
      assert(run.blocking.uiTicks >= 25, 'UI heartbeat must continue during Engine task wait');

      await context.setOffline(true);
      for (const mode of [2, 3, 2]) {
        assert.equal(await page.evaluate(mode => __webEngineRPC('WebThreadTestControl', mode), mode), 1);
        await advance(page, 60);
        const completed = await state(page);
        assert.equal(completed.io.result, mode);
        assert.notEqual(completed.io.worker, completed.threads.gameThread);
        assert.equal(completed.io.callback, completed.threads.gameThread);
        if (mode === 2) assert.equal(completed.io.crc, report.expectedIOCRC);
        (run.localIO ||= []).push(completed.io);
      }
      await context.setOffline(false);

      await page.locator('canvas').focus();
      const movementBefore = await state(page);
      await page.keyboard.down('KeyW');
      await advance(page, 30);
      await page.keyboard.up('KeyW');
      const movementAfter = await advance(page, 5);
      assert(Math.hypot(movementAfter.camera.x - movementBefore.camera.x,
        movementAfter.camera.y - movementBefore.camera.y,
        movementAfter.camera.z - movementBefore.camera.z) > 1);
      run.movement = {before: movementBefore.camera, after: movementAfter.camera};
      // Losing focus while a key is held must release it on the Engine Worker.
      await page.keyboard.down('KeyW');
      await advance(page, 10);
      await page.evaluate(() => Module.canvas.blur());
      await page.keyboard.up('KeyW');
      // Let the flying pawn's braking settle after input release.
      const blurred = await advance(page, 60);
      const stationary = await advance(page, 30);
      run.blur = {before: blurred.camera, after: stationary.camera};
      assert(Math.hypot(stationary.camera.x - blurred.camera.x, stationary.camera.y - blurred.camera.y,
        stationary.camera.z - blurred.camera.z) < 1);
      await page.locator('canvas').focus();
      const camera = await page.evaluate(() => __webDefaultCamera);
      await page.mouse.move(600, 400);
      await page.mouse.down({button: 'right'});
      await page.mouse.move(620, 405);
      await page.mouse.move(700, 440, {steps: 8});
      await page.mouse.up({button: 'right'});
      await advance(page, 15);
      const rotated = await page.evaluate(() => __webDefaultCamera);
      assert(Math.abs(rotated.yaw - camera.yaw) + Math.abs(rotated.pitch - camera.pitch) > 0.1);
      run.mouse = {before: camera, after: rotated};
      await page.mouse.click(600, 400);
      try {
        await page.waitForFunction(() => document.pointerLockElement === Module.canvas, null, {timeout: 10000});
      } catch (error) {
        run.pointerLockEvents = await page.evaluate(() => testPointerLock);
        throw error;
      }
      const locked = await advance(page, 5);
      await page.mouse.move(700, 400);
      await page.mouse.move(720, 440, {steps: 8});
      await advance(page, 10);
      const lockedMove = await state(page);
      run.pointerLock = {before: locked.camera, after: lockedMove.camera,
        events: await page.evaluate(() => testPointerLock)};
      assert(Math.abs(lockedMove.camera.yaw - locked.camera.yaw) +
        Math.abs(lockedMove.camera.pitch - locked.camera.pitch) > 0.1);
      await page.evaluate(() => document.exitPointerLock());
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: true});
      const touchBefore = await state(page);
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: 600, y: 400, id: 1}]});
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 620, y: 405, id: 1}]});
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: 700, y: 440, id: 1}]});
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
      const touchAfter = await advance(page, 15);
      assert(Math.abs(touchAfter.camera.yaw - touchBefore.camera.yaw) +
        Math.abs(touchAfter.camera.pitch - touchBefore.camera.pitch) > 0.1);
      run.touch = {before: touchBefore.camera, after: touchAfter.camera};
      await cdp.send('Emulation.setTouchEmulationEnabled', {enabled: false});

      for (const viewport of [{width: 800, height: 600}, {width: 1920, height: 1080},
        {width: 1280, height: 720}]) {
        await page.setViewportSize(viewport);
        const view = await advance(page, 30);
        assert.equal(view.surface.width, Math.round(view.css.width * view.css.dpr));
        assert.equal(view.surface.height, Math.round(view.css.height * view.css.dpr));
        assert.equal(view.view.width, view.view.outputWidth);
        assert.equal(view.view.height, view.view.outputHeight);
        assert.equal(view.view.antiAliasing, 2);
        run.views.push(view);
      }
      await cdp.send('Emulation.setDeviceMetricsOverride',
        {width: 1920, height: 1080, deviceScaleFactor: 2, mobile: false});
      const dpi = await advance(page, 60);
      assert.equal(dpi.css.dpr, 2);
      assert.deepEqual(dpi.surface, {width: 3840, height: 2160});
      assert.equal(dpi.view.width, 3840);
      assert.equal(dpi.view.height, 2160);
      run.dpi4k = dpi;
      run.dpi4k.image = await image(page, name.toLowerCase() + '-4k');
      await cdp.send('Emulation.setDeviceMetricsOverride',
        {width: 1280, height: 720, deviceScaleFactor: 1, mobile: false});
      await advance(page, 30);
      await cdp.detach();
      assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', 650, -400, 10, 15, 110)), 1);
      await advance(page, 90);
      run.lowView = await image(page, name.toLowerCase() + '-ground-close');
      await page.reload({waitUntil: 'commit'});
      run.reload = await advance(page, 120);
      assert.equal(run.reload.local.downloads, 0, 'Warm reload must reuse the local engine and content');
      assert(run.reload.local.persistentHits >= 2);
      run.sustained = await advance(page, 600);
      assert.deepEqual(run.errors, []);
      await page.close();
      run.parity = await visualParity(context, name);
      run.pass = true;
      console.log(JSON.stringify({browser: name, pass: true, frames: run.reload.frames,
        taskThread, uiTicks: run.blocking.uiTicks, io: run.localIO, downloads: run.reload.local.downloads}));
      await context.close();
      context = null;
    }
    report.pass = report.runs.length > 0 && report.runs.every(run => run.pass);
  } catch (error) { report.failure = error.stack; }
  finally {
    if (context) await context.close();
    const file = path.join(directory, `web-engine-threads${option('browser') ? '-' + option('browser').toLowerCase() : ''}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, runs: report.runs.length}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
