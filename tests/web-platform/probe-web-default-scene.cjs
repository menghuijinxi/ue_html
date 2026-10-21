const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const packaged = process.argv.includes('--packaged');
const normalBuild = packaged || process.argv.includes('--normal-build');
const runtimeOnly = process.argv.includes('--runtime-only');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, completeUEScene: false,
  fullNormalUBTBuildVerified: false, runtimeOnly, packaged, browserRuns: [], negativeControls: [], sources: [
    __filename, path.join(__dirname, 'web-engine.html'), path.join(__dirname, 'capture-web-canvas.cjs'),
    path.resolve(__dirname, '../ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp'),
    path.resolve(__dirname, '../ue-web-smoke/Source/UEWebEngine/Private/WebRenderScene.h'),
    ...(packaged ? [path.join(__dirname, 'web-default-template.html'),
      path.join(__dirname, 'package-web-default-template.cjs')] : [])
  ].map(audit)};

function pixels(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  let nonBlack = 0, blueSky = 0, floorLuma = 0, floorSamples = 0;
  let floorMin = 255, floorMax = 0;
  const colors = new Set();
  for (let y = 0; y < image.height; ++y) {
    for (let x = 0; x < image.width; ++x) {
      const offset = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(offset, offset + 3);
      if (r + g + b > 30) ++nonBlack;
      if (y < image.height * 0.25 && b > r * 1.1 && b > 40 && g > 30) ++blueSky;
      colors.add((r << 16) | (g << 8) | b);
      if (y > image.height * 0.6 && y < image.height - 2 && x > 2 && x < image.width - 2) {
        const luma = (r + g + b) / 3;
        floorLuma += luma;
        ++floorSamples;
        floorMin = Math.min(floorMin, luma);
        floorMax = Math.max(floorMax, luma);
      }
    }
  }
  return {width: image.width, height: image.height, nonBlack, blueSky, colors: colors.size,
    floorMean: floorLuma / floorSamples, floorRange: floorMax - floorMin,
    pass: blueSky > image.width * image.height * 0.1 &&
      nonBlack > image.width * image.height * 0.9 &&
      floorLuma / floorSamples > 30 && floorMax - floorMin > 20 && colors.size > 256};
}

function difference(first, second, region) {
  const a = PNG.sync.read(fs.readFileSync(first));
  const b = PNG.sync.read(fs.readFileSync(second));
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let total = 0, changed = 0, samples = 0;
  for (let y = 2; y < a.height - 2; ++y) {
    if (region === 'sky' ? y >= a.height * 0.25 : y <= a.height * 0.6) continue;
    for (let x = 2; x < a.width - 2; ++x) {
      const offset = (y * a.width + x) * 4;
      let delta = 0;
      for (let channel = 0; channel < 3; ++channel)
        delta += Math.abs(a.data[offset + channel] - b.data[offset + channel]);
      total += delta / 3;
      if (delta > 30) ++changed;
      ++samples;
    }
  }
  return {mean: total / samples, changedFraction: changed / samples};
}

async function settle(page) {
  const first = await page.evaluate(() => globalThis.__webEngineFrames);
  await page.waitForFunction(frame => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame + 60, first, {timeout: 60000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
}

(async () => {
  let browser;
  try {
    const buildName = normalBuild ? 'web-engine-full-build-results.json' :
      'web-engine-webgpu-link-results.json';
    for (const name of [buildName, 'web-engine-webgpu-es31-default-stage-results.json']) {
      const file = path.join(directory, name);
      const evidence = read(file);
      assert(evidence.pass && evidence.sourceFiles.every(valid));
      assert((evidence.products || [evidence.pack, evidence.manifest, evidence.configBundle]).every(valid));
      report[name === buildName ? 'buildReport' : 'stageReport'] = audit(file);
      if (normalBuild && name === buildName) {
        assert(evidence.buildSucceeded && evidence.exitCode === 0 && evidence.fullLinkAttempted);
        for (const product of evidence.products.filter(item => /\.(js|wasm)$/.test(item.file)))
          fs.copyFileSync(product.file, path.join(__dirname, 'build/web-engine', path.basename(product.file)));
        report.fullNormalUBTBuildVerified = true;
      }
    }
    if (packaged) {
      const packageFile = path.join(directory, 'web-default-template-package-results.json');
      const evidence = read(packageFile);
      assert(evidence.pass && evidence.fullNormalUBTBuildVerified &&
        evidence.products.every(valid) && evidence.sourceFiles.every(valid) &&
        valid(evidence.buildReport) && valid(evidence.stageReport));
      assert.equal(evidence.buildReport.sha256, report.buildReport.sha256);
      assert.equal(evidence.stageReport.sha256, report.stageReport.sha256);
      report.packageReport = audit(packageFile);
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
      run.requests = [];
      page.on('request', request => run.requests.push(request.url()));
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      const packageRoot = 'http://127.0.0.1:8765/build/ue-default-template/';
      const url = packaged ? packageRoot + 'index.html' :
        `http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=${normalBuild ? 0 : 1}&cook=default`;
      await page.goto(url,
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
      run.pixels = pixels(screenshot);
      run.runtimePass = run.frames >= 60 && !run.failure && !run.waitFailure && !run.errors.length &&
        run.world?.package === '/Engine/Maps/Templates/Template_Default' &&
        run.scene?.litMeshes >= 1 && run.scene.skySpheres === 1 &&
        run.scene.directionalLights >= 1 && run.scene.skyLights >= 1 && run.queue.pass &&
        !run.canvas.gpuErrors.length && run.canvas.drawCalls > 2;
      run.controls = [];
      if (!runtimeOnly && run.runtimePass && run.pixels.pass) {
        for (const [mode, name, region] of [[1, 'sun-off', 'floor'], [2, 'sky-off', 'sky']]) {
          assert.equal(await page.evaluate(mode => Module._WebDefaultSceneTestMode(mode), mode), 1);
          await settle(page);
          const controlFile = path.join(directory, `web-default-scene-${name}-${run.browser.toLowerCase()}.png`);
          await page.locator('canvas').screenshot({path: controlFile});
          const controlPixels = pixels(controlFile);
          const delta = difference(screenshot, controlFile, region);
          const control = {name, screenshot: audit(controlFile), pixels: controlPixels, difference: delta,
            pass: delta.mean > 15 && delta.changedFraction > 0.5 &&
              (mode === 1 ? controlPixels.floorMean < run.pixels.floorMean - 15 :
                controlPixels.blueSky < run.pixels.blueSky * 0.1)};
          run.controls.push(control);
        }
        assert.equal(await page.evaluate(() => Module._WebDefaultSceneTestMode(0)), 1);
        await settle(page);
        const restored = path.join(directory, `web-default-scene-restored-${run.browser.toLowerCase()}.png`);
        await page.locator('canvas').screenshot({path: restored});
        run.restored = {screenshot: audit(restored), pixels: pixels(restored),
          skyDifference: difference(screenshot, restored, 'sky'),
          floorDifference: difference(screenshot, restored, 'floor')};
        run.restored.pass = run.restored.pixels.pass && run.restored.skyDifference.mean < 5 &&
          run.restored.floorDifference.mean < 5;
        if (packaged) {
          await page.setViewportSize({width: 390, height: 844});
          await settle(page);
          const portrait = path.join(directory, `web-default-scene-portrait-${run.browser.toLowerCase()}.png`);
          await page.locator('canvas').screenshot({path: portrait});
          run.portrait = {screenshot: audit(portrait), pixels: pixels(portrait),
            bounds: await page.locator('canvas').boundingBox()};
          run.portrait.pass = run.portrait.pixels.pass && run.portrait.bounds.width <= 390 &&
            run.portrait.bounds.x >= 0 && run.portrait.bounds.y >= 0 &&
            run.portrait.bounds.y + run.portrait.bounds.height <= 844;
          await page.setViewportSize({width: 1440, height: 900});
          await settle(page);
          const resized = path.join(directory, `web-default-scene-resized-${run.browser.toLowerCase()}.png`);
          await page.locator('canvas').screenshot({path: resized});
          run.resized = {screenshot: audit(resized), pixels: pixels(resized),
            bounds: await page.locator('canvas').boundingBox()};
          run.resized.pass = run.resized.pixels.pass && run.resized.bounds.width <= 1440 &&
            run.resized.bounds.x >= 0 && run.resized.bounds.y >= 0 &&
            run.resized.bounds.y + run.resized.bounds.height <= 900;
        }
        run.finalGPU = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
        run.finalFrames = await page.evaluate(() => globalThis.__webEngineFrames);
      }
      run.pass = run.runtimePass && (runtimeOnly || run.pixels.pass &&
        run.controls.length === 2 && run.controls.every(control => control.pass) &&
        run.restored?.pass && !run.finalGPU?.length && !run.errors.length) &&
        (!packaged || run.portrait?.pass && run.resized?.pass &&
          run.requests.every(request => request.startsWith(packageRoot)));
      if (packaged && name === 'Chrome' && run.pass) {
        for (const kind of ['pack-hash', 'config-hash']) {
          const control = await browser.newPage();
          const filename = kind === 'pack-hash' ? 'content-files.json' : 'config-files.json';
          const data = read(path.join(__dirname, 'build/ue-default-template', filename));
          if (kind === 'pack-hash') data.pack.sha256 = '0'.repeat(64);
          else data[0].sha256 = '0'.repeat(64);
          await control.route('**/' + filename, route =>
            route.fulfill({contentType: 'application/json', body: JSON.stringify(data)}));
          await control.goto(url, {waitUntil: 'commit'});
          await control.waitForFunction(() => globalThis.__webEngineFailure, null, {timeout: 60000});
          const state = await control.evaluate(() => ({
            failure: globalThis.__webEngineFailure, frames: globalThis.__webEngineFrames || 0,
            ready: globalThis.__webEngineReady || null
          }));
          const expected = kind === 'pack-hash' ? /pack hash mismatch/ : /Config hash mismatch/;
          report.negativeControls.push({kind, ...state,
            pass: expected.test(state.failure) && state.frames === 0 && !state.ready});
          await control.close();
        }
      }
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.length === 2 && report.browserRuns.every(run => run.pass),
      'Both browsers must render the original default map, its sky and lighting, with differential controls.');
    if (packaged)
      assert(report.negativeControls.length === 2 && report.negativeControls.every(control => control.pass),
        'An invalid package or config hash must stop startup before UE begins rendering.');
    report.pass = true;
    report.completeUEScene = !runtimeOnly;
    report.boundary = runtimeOnly ? 'Runtime smoke check only; no visual acceptance.' :
      'Original default map with mobile Lit lighting, sky sphere, SkyAtmosphere and SkyLight. Mobile volumetric clouds and optional contact shadows remain disabled.';
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
