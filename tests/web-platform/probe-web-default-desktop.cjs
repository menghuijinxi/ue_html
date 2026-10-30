const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const published = process.argv.includes('--published');
const folder = published ? 'ue-default-template' : 'ue-default-template-desktop';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const fixtureFile = path.join(directory, 'default-shadow-native-desktop.json');
const comparisonView = {x: -1000, y: -70, z: 230, pitch: -8, yaw: 65, fov: 75};
const soakSeconds = Number(process.argv.find(value => value.startsWith('--seconds='))?.slice(10) ?? 60);
assert(Number.isFinite(soakSeconds) && soakSeconds >= 0);
const report = {date: new Date().toISOString(), pass: false, renderer: 'desktop-deferred',
  completeUEScene: false, published, soakSeconds, runs: [], sourceFiles: [__filename,
    path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};

(async () => {
  let browser;
  try {
    const packageFile = path.join(directory, 'web-default-template-desktop-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.renderer === report.renderer &&
      packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.packageReport = audit(packageFile);
    if (published) {
      const file = path.join(directory, 'web-default-desktop-publish-results.json');
      const release = read(file);
      assert(release.pass && release.renderer === report.renderer && release.products.every(valid) &&
        release.packageReport.sha256 === report.packageReport.sha256);
      report.publishReport = audit(file);
    }
    const cook = read(read(packaged.stageReport.file).cookReport.file);
    const conversion = path.join(cook.output, 'ShaderConversion');
    const entries = {};
    const validationFile = path.join(directory, 'web-desktop-shader-modules-results.json');
    if (fs.existsSync(validationFile)) {
      const validation = read(validationFile);
      assert(validation.pass && validation.sourceFiles.every(valid));
      for (const shader of validation.shaders) {
        assert(valid(shader.artifact));
        const input = read(path.join(path.dirname(shader.artifact.file), 'input.json'));
        if (input.metadata?.webEntry) entries[input.metadata.webEntry] = input.shaderName;
      }
      report.shaderModuleReport = audit(validationFile);
    }
    for (const name of fs.existsSync(conversion) ? fs.readdirSync(conversion) : []) {
      const inputFile = path.join(conversion, name, 'input.json');
      if (!fs.existsSync(inputFile)) continue;
      const input = read(inputFile);
      if (input.metadata?.webEntry) entries[input.metadata.webEntry] = input.shaderName;
    }
    const selected = process.argv.includes('--edge') ?
      [['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']] :
      [['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe']];
    for (const [name, executablePath] of selected) {
      const run = {browser: name, pass: false, errors: [], log: [], images: {}};
      report.runs.push(run);
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1280, height: 720}});
      page.on('pageerror', error => run.errors.push(error.stack || error.message));
      page.on('console', message => {
        const text = message.text();
        run.log.push(text);
        if (run.log.length > 300) run.log.shift();
        if (text.startsWith('P3_MATERIAL_POLICY ')) run.materialPolicy = JSON.parse(text.slice(19));
        if (text.includes('GPU validation:')) run.errors.push(text);
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.addInitScript(entries => {
        const pipelines = new WeakMap(), bound = new WeakMap();
        const state = globalThis.desktopPasses = {draws: {}, dispatches: {}, textures: []};
        const createTexture = GPUDevice.prototype.createTexture;
        GPUDevice.prototype.createTexture = function(descriptor) {
          const texture = createTexture.call(this, descriptor);
          if (/GBuffer|SceneColor|Velocity/.test(texture.label))
            state.textures.push({label: texture.label, format: texture.format,
              width: texture.width, height: texture.height});
          return texture;
        };
        for (const [method, stage] of [['createRenderPipeline', 'fragment'],
          ['createComputePipeline', 'compute']]) {
          const original = GPUDevice.prototype[method];
          GPUDevice.prototype[method] = function(descriptor) {
            const pipeline = original.call(this, descriptor);
            pipelines.set(pipeline, entries[descriptor[stage]?.entryPoint] ||
              descriptor[stage]?.entryPoint || 'unknown');
            return pipeline;
          };
        }
        for (const [prototype, methods, counter] of [
          [GPURenderPassEncoder.prototype, ['draw', 'drawIndexed'], 'draws'],
          [GPUComputePassEncoder.prototype, ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect'], 'dispatches']
        ]) {
          const setPipeline = prototype.setPipeline;
          prototype.setPipeline = function(pipeline) {
            bound.set(this, pipelines.get(pipeline));
            return setPipeline.call(this, pipeline);
          };
          for (const method of methods) {
            const original = prototype[method];
            prototype[method] = function(...args) {
              const name = bound.get(this) || 'unknown';
              state[counter][name] = (state[counter][name] || 0) + 1;
              return original.apply(this, args);
            };
          }
        }
      }, entries);
      await page.route(`**/${folder}/index.html`, async route => {
        const response = await route.fetch(), html = await response.text();
        const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
        assert(html.includes(original));
        await route.fulfill({response, body: html.replace(original,
          "arguments: ['-webgpu', '-WebDefaultTemplate', '-WebVisualTestClock'],")});
      });
      await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`,
        {waitUntil: 'commit'});
      const frames = async count => {
        const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
        await page.waitForFunction(frame => globalThis.__webEngineFailure ||
          globalThis.__webEngineFrames >= frame, first + count, {timeout: 180000});
        run.failure = await page.evaluate(() => globalThis.__webEngineFailure || null);
        assert.equal(run.failure, null);
        assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      };
      const shot = async tag => {
        const file = path.join(directory,
          `default-desktop${published ? '-published' : ''}-${name.toLowerCase()}-${tag}.png`);
        await page.locator('canvas').screenshot({path: file});
        run.images[tag] = audit(file);
        const image = PNG.sync.read(fs.readFileSync(file));
        let nonBlack = 0, sum = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          const value = image.data[i] + image.data[i + 1] + image.data[i + 2];
          nonBlack += value > 30;
          sum += value / 3;
        }
        return {nonBlack: nonBlack / (image.width * image.height),
          mean: sum / (image.width * image.height)};
      };
      await frames(180);
      run.ready = await page.evaluate(() => globalThis.__webEngineReady);
      assert.equal(run.ready.shaderPlatform, 47);
      assert.equal(run.ready.featureLevel, 3);
      assert.equal(run.materialPolicy.mobile, false);
      assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(0)), 1);
      await frames(120);
      run.originalPixels = await shot('original');
      assert(run.originalPixels.nonBlack > 0.9 && run.originalPixels.mean > 30);
      assert.equal(await page.evaluate(() => Module._WebDefaultSamplesVisibility(1)), 1);
      await frames(120);
      run.samples = await page.evaluate(() => globalThis.__webDefaultSamples);
      assert.equal(run.samples.count, 8);
      assert(run.samples.sceneUnchanged);
      await shot('samples');
      await page.setViewportSize({width: 1600, height: 1000});
      const reference = comparisonView;
      assert.equal(await page.evaluate(v =>
        Module._WebProjectViewTest(v.x, v.y, v.z, v.pitch, v.yaw), reference), 1);
      await frames(240);
      assert.equal(await page.evaluate(() => Module._WebDefaultShadowControl(4, 0)), 1);
      run.comparisonCamera = await page.evaluate(() => globalThis.__webDefaultShadowCamera);
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw', 'fov'])
        assert(Math.abs(run.comparisonCamera[key] - reference[key]) < 0.001);
      await shot('native-camera');
      if (!published) {
        fs.writeFileSync(fixtureFile, JSON.stringify({
          output: path.join(directory, 'default-shadow-native-desktop'), samples: run.samples.samples,
          views: [{...reference, name: 'baseline', dense: true, bias: 0.5, slope: 0.5, cast: true}]
        }, null, 2));
        run.nativeComparisonInput = audit(fixtureFile);
      }
      await page.setViewportSize({width: 390, height: 844});
      await frames(60);
      await shot('portrait');
      await page.setViewportSize({width: 1280, height: 720});
      await frames(60);
      await shot('restored');
      // The comparison export installs a fixed CameraActor; reload to test the normal player view.
      await page.reload({waitUntil: 'commit'});
      await frames(180);
      const bounds = await page.locator('canvas').boundingBox();
      const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
      await page.mouse.click(center.x, center.y);
      await frames(15);
      const camera = () => page.evaluate(() => globalThis.__webDefaultCamera);
      const distance = (a, b) => Math.hypot(...['x', 'y', 'z'].map(key => a[key] - b[key]));
      const beforeMove = await camera();
      await page.keyboard.down('w');
      try { await frames(45); }
      finally { await page.keyboard.up('w'); }
      await frames(30);
      run.interaction = {forwardDistance: distance(await camera(), beforeMove)};
      assert(run.interaction.forwardDistance > 30, 'The actual UE pawn must move');
      const beforeLook = await camera();
      await page.mouse.down({button: 'right'});
      await page.mouse.move(center.x + 90, center.y + 30, {steps: 10});
      await page.mouse.up({button: 'right'});
      await frames(30);
      const afterLook = await camera();
      const angle = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
      run.interaction.yaw = angle(afterLook.yaw, beforeLook.yaw);
      run.interaction.pitch = angle(afterLook.pitch, beforeLook.pitch);
      assert(run.interaction.yaw > 1 && run.interaction.pitch > 1, 'Mouse input must rotate the UE view');
      await page.keyboard.down('w');
      await frames(15);
      await page.evaluate(() => {
        document.exitPointerLock();
        document.querySelector('canvas').blur();
        window.dispatchEvent(new Event('blur'));
      });
      await page.keyboard.up('w');
      await frames(60);
      const blurred = await camera();
      await frames(60);
      run.interaction.blurDrift = distance(await camera(), blurred);
      assert(run.interaction.blurDrift < 1, 'Focus loss must release movement keys');
      await page.mouse.click(center.x, center.y);
      const started = Date.now();
      run.soak = [];
      while (Date.now() - started < soakSeconds * 1000) {
        await frames(60);
        const state = await page.evaluate(() => ({
          elapsedFrames: globalThis.__webEngineFrames, runtime: globalThis.__webEngineRuntime,
          errors: globalThis.__webCanvas.gpuErrors
        }));
        assert.equal(state.errors.length, 0);
        assert(state.runtime.statsHistoryFrames < 64 &&
          state.runtime.gameFrame - state.runtime.endOfPipeFrame < 10);
        run.soak.push({elapsedSeconds: (Date.now() - started) / 1000, ...state});
        await page.evaluate(() => {
          for (const key of ['acquisitions', 'debugMarkers', 'depthTextures', 'depthViews', 'depthPasses'])
            globalThis.__webCanvas[key].splice(0);
        });
      }
      if (soakSeconds >= 60) {
        const heaps = run.soak.filter(item => item.elapsedSeconds >= soakSeconds / 2)
          .map(item => item.runtime.heapBytes);
        run.heapGrowthBytes = Math.max(...heaps) - Math.min(...heaps);
        assert(run.heapGrowthBytes < 64 * 1024 * 1024, 'Linear memory must stabilize after warmup');
      }
      const beforeFinalMove = await camera();
      await page.keyboard.down('s');
      try { await frames(15); }
      finally { await page.keyboard.up('s'); }
      run.interaction.finalDistance = distance(await camera(), beforeFinalMove);
      assert(run.interaction.finalDistance > 10, 'Movement must still work after the soak');
      run.frames = await page.evaluate(() => globalThis.__webEngineFrames);
      run.gpu = await page.evaluate(() => globalThis.__webCanvas);
      run.passes = await page.evaluate(() => globalThis.desktopPasses);
      assert.equal(run.errors.length, 0);
      assert.equal(run.gpu.gpuErrors.length, 0);
      assert(run.gpu.drawCalls > 0 && run.gpu.dispatchCalls > 0);
      for (const name of ['FDeferredLightPS', 'FReflectionEnvironmentSkyLightingPS', 'FTonemapPS'])
        assert(run.passes.draws[name] > 0, `${name} must execute on the GPU`);
      assert(run.passes.textures.some(texture => /^GBuffer/.test(texture.label)));
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.completeUEScene = true;
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    try {
      report.failureState = await browser?.contexts()[0]?.pages()[0]?.evaluate(() => ({
        ready: globalThis.__webEngineReady, frames: globalThis.__webEngineFrames,
        startup: globalThis.__webStartupDiagnostics,
        gpuErrors: globalThis.__webCanvas?.gpuErrors, passes: globalThis.desktopPasses,
        debugMarkers: globalThis.__webCanvas?.debugMarkers?.slice(-15)
      }));
      const page = browser?.contexts()[0]?.pages()[0];
      if (page) {
        const file = path.join(directory, `default-desktop-failure${process.argv.includes('--edge') ? '-edge' : ''}.png`);
        await page.locator('canvas').screenshot({path: file, timeout: 10000});
        report.failureImage = audit(file);
      }
    } catch {}
  } finally {
    if (browser) await browser.close();
    const suffix = (published ? '-published' : '') + (process.argv.includes('--edge') ? '-edge' : '');
    fs.writeFileSync(path.join(directory, `web-default-desktop${suffix}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, completeUEScene: report.completeUEScene,
      runs: report.runs.map(run => ({browser: run.browser, ready: run.ready, frames: run.frames,
        failure: run.failure, errors: run.errors.slice(0, 4)})), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
