const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, completeUEScene: false,
  fullNormalUBTBuildVerified: false, browserRuns: [], sources: [
    __filename, path.join(__dirname, 'web-engine.html'), path.join(__dirname, 'capture-web-canvas.cjs'),
    path.resolve(__dirname, '../ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp'),
    path.resolve(__dirname, '../ue-web-smoke/Source/UEWebEngine/Private/WebRenderScene.h')
  ].map(audit)};

(async () => {
  let browser;
  try {
    for (const name of ['web-engine-webgpu-link-results.json',
      'web-engine-webgpu-es31-default-stage-results.json']) {
      const file = path.join(directory, name);
      const evidence = read(file);
      assert(evidence.pass && evidence.sourceFiles.every(valid));
      assert((evidence.products || [evidence.pack, evidence.manifest, evidence.configBundle]).every(valid));
      report[name.includes('link') ? 'buildReport' : 'stageReport'] = audit(file);
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1100, height: 760}});
      const run = {browser: name, version: browser.version(), pass: false, errors: [], log: []};
      report.browserRuns.push(run);
      page.on('console', message => {
        run.log.push(message.text());
        if (/WebGPU validation|GPUValidationError|\[Invalid /.test(message.text()))
          run.errors.push(message.text());
      });
      page.on('pageerror', error => run.errors.push(error.stack || error.message));
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.goto('http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=1&cook=default',
        {waitUntil: 'commit'});
      try {
        await page.waitForFunction(() => globalThis.__webEngineFailure ||
          globalThis.__webEngineFrames >= 60, null, {timeout: 60000});
      } catch (error) { run.waitFailure = error.message; }
      Object.assign(run, await page.evaluate(() => ({
        frames: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure || null,
        ready: globalThis.__webEngineReady || null, world: globalThis.__webEngineWorld || null,
        scene: globalThis.__webRenderScene || null
      })));
      run.queue = await page.evaluate(() => globalThis.__webCanvasWaitIdle());
      const screenshot = path.join(directory, `web-default-scene-${name.toLowerCase()}.png`);
      await page.locator('canvas').screenshot({path: screenshot});
      run.canvas = await page.evaluate(() => globalThis.__webCanvas);
      run.screenshot = audit(screenshot);
      const image = PNG.sync.read(fs.readFileSync(screenshot));
      let nonBlack = 0, blueSky = 0;
      const colors = new Set();
      for (let offset = 0; offset < image.data.length; offset += 4) {
        const [r, g, b] = image.data.subarray(offset, offset + 3);
        if (r + g + b > 30) ++nonBlack;
        if (b > r * 1.1 && b > 40 && g > 30) ++blueSky;
        colors.add((r << 16) | (g << 8) | b);
      }
      run.pixels = {width: image.width, height: image.height, nonBlack, blueSky, colors: colors.size};
      run.pass = run.frames >= 60 && !run.failure && !run.waitFailure && !run.errors.length &&
        run.world?.package === '/Engine/Maps/Templates/Template_Default' &&
        run.scene?.litMeshes >= 1 && run.scene.skySpheres === 1 &&
        run.scene.directionalLights >= 1 && run.scene.skyLights >= 1 && run.queue.pass &&
        !run.canvas.gpuErrors.length && run.canvas.drawCalls > 2;
      await browser.close();
      browser = null;
      if (!run.pass) break;
    }
    assert(report.browserRuns.length === 2 && report.browserRuns.every(run => run.pass),
      'The original default map must complete 60 consecutive frames in both browsers.');
    report.pass = true;
    report.boundary = 'Runtime smoke check only; lighting and sky still require visual and differential verification.';
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, 'web-default-scene-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, runs: report.browserRuns.map(run => ({
      browser: run.browser, frames: run.frames, failure: run.failure, errors: run.errors.slice(-3),
      lastLog: run.log.slice(-8), pixels: run.pixels
    })), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
