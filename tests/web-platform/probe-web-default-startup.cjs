const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const repetitions = Number(option('runs') || 3);
assert(Number.isInteger(repetitions) && repetitions > 0);
const scales = option('scale') ? [Number(option('scale'))] : [1, 1.5, 2];
assert(scales.every(scale => Number.isFinite(scale) && scale > 0));
const startupOnly = process.argv.includes('--startup-only');
const reportSuffix = option('report') || '';
assert(/^[a-z0-9-]*$/.test(reportSuffix));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, gpuHooks: false, startupOnly, scales,
  browserRuns: [], source: audit(__filename)};

(async () => {
  let browser;
  try {
    const packageFile = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
      valid(packaged.buildReport) && valid(packaged.stageReport));
    report.package = audit(packageFile);
    report.products = packaged.products;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      if (option('browser') && option('browser') !== name) continue;
      browser = await chromium.launch({executablePath, headless: true});
      for (let index = 0; index < repetitions; ++index) {
        for (const scale of scales) {
          const context = await browser.newContext({viewport: {width: 1848, height: 1120}, deviceScaleFactor: scale});
          const page = await context.newPage();
          const run = {browser: name, version: browser.version(), index, scale, pass: false, errors: [], log: [], views: []};
          report.browserRuns.push(run);
          page.on('pageerror', error => run.errors.push(error.stack || error.message));
          page.on('console', message => {
            const text = message.text();
            run.log.push(text);
            if (run.log.length > 80) run.log.shift();
            if (/Fatal error|Assertion failed|GPU validation|GPUValidationError|\[Invalid |DXGI_ERROR_DEVICE|DeviceLost/.test(text))
              run.errors.push(text);
          });
          const started = Date.now();
          await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
          for (const viewport of startupOnly ? [null] :
            [null, {width: 390, height: 844}, {width: 1848, height: 1120}]) {
            if (viewport) await page.setViewportSize(viewport);
            const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
            await page.waitForFunction(frame => globalThis.__webEngineFailure ||
              globalThis.__webEngineFrames >= frame + 180, first, {timeout: 90000});
            const state = await page.evaluate(() => ({
              failure: globalThis.__webEngineFailure || null, frames: globalThis.__webEngineFrames,
              runtime: globalThis.__webEngineRuntime, camera: globalThis.__webDefaultCamera,
              visualTestClock: globalThis.__webVisualTestClock || null,
              canvas: {
                width: document.querySelector('canvas').width, height: document.querySelector('canvas').height,
                cssWidth: document.querySelector('canvas').getBoundingClientRect().width,
                cssHeight: document.querySelector('canvas').getBoundingClientRect().height,
                scale: devicePixelRatio
              }
            }));
            run.views.push(state);
            state.elapsedMilliseconds = Date.now() - started;
            assert.equal(state.failure, null);
            assert.equal(state.visualTestClock, null, 'The normal page must keep real-time material animation');
            assert.deepEqual(run.errors, []);
            assert(state.runtime && state.camera && state.runtime.statsHistoryFrames < 64);
            assert.equal(state.canvas.width, Math.round(state.canvas.cssWidth * scale));
            assert.equal(state.canvas.height, Math.round(state.canvas.cssHeight * scale));
            const bytes = await page.locator('canvas').screenshot();
            const image = PNG.sync.read(bytes);
            let lit = 0;
            for (let offset = 0; offset < image.data.length; offset += 4)
              if (image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 30) ++lit;
            assert(lit > image.width * image.height * 0.9, 'The normal page must keep rendering after resize');
            state.image = {width: image.width, height: image.height, nonBlackFraction: lit / (image.width * image.height)};
            if (index === 0 && viewport?.width === 1848) {
              const file = path.join(directory, `web-default-startup-${name.toLowerCase()}-dpr${scale}.png`);
              fs.writeFileSync(file, bytes);
              state.screenshot = audit(file);
            }
          }
          await page.locator('canvas').focus();
          const before = await page.evaluate(() => ({
            frames: globalThis.__webEngineFrames, camera: globalThis.__webDefaultCamera
          }));
          await page.keyboard.down('KeyW');
          try {
            await page.waitForFunction(frame => globalThis.__webEngineFailure ||
              globalThis.__webEngineFrames >= frame + 30, before.frames, {timeout: 60000});
          } finally { await page.keyboard.up('KeyW'); }
          const after = await page.evaluate(() => ({
            failure: globalThis.__webEngineFailure || null, camera: globalThis.__webDefaultCamera,
            frames: globalThis.__webEngineFrames
          }));
          run.movement = {before: before.camera, ...after};
          assert.equal(after.failure, null);
          assert(Math.hypot(after.camera.x - before.camera.x, after.camera.y - before.camera.y,
            after.camera.z - before.camera.z) > 1, 'The UE pawn must still move at the tested DPI');
          assert.deepEqual(run.errors, []);
          run.pass = true;
          console.log(JSON.stringify({browser: name, index, scale, pass: true, frames: run.views.at(-1).frames}));
          await context.close();
        }
      }
      await browser.close();
      browser = null;
    }
    report.pass = report.browserRuns.length > 0 && report.browserRuns.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-default-startup${reportSuffix ? '-' + reportSuffix : ''}-results.json`),
      JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, runs: report.browserRuns.length, failure: report.failure,
      failed: report.browserRuns.filter(run => !run.pass)}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
