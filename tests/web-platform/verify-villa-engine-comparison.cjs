'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sharp = require('sharp');
const option = name => process.argv.find(v => v.startsWith('--' + name + '='))?.slice(name.length + 3);
const noLumen = option('lighting') === 'off';
const profile = require(noLumen ? './villa-engine-comparison-no-lumen.json' : './villa-engine-comparison.json');
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const tag = option('tag') || '20261109';
assert(/^[a-z0-9-]+$/.test(tag));
const selected = option('engine');
assert(!selected || ['ours', 'official'].includes(selected));
const affinity = Number(option('affinity') || 0);
assert(Number.isSafeInteger(affinity) && affinity >= 0);
const dpr = Number(option('dpr') || 1);
assert(Number.isFinite(dpr) && dpr > 0);
const browser = option('browser') || 'chrome';
assert(['chrome', 'msedge'].includes(browser) && (!affinity || browser === 'chrome'));
const browserProfile = path.join(__dirname, 'build/browser-profiles/comparison-' + tag);
const directory = path.join(__dirname, 'results/villa-engine-comparison-' + tag);
fs.mkdirSync(directory, {recursive: true});
const report = {date: new Date().toISOString(), profile, browser, dpr, affinity, affinityChecks: [], runs: [], pass: false};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(browserProfile, {
      channel: browser,
      headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: dpr,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--autoplay-policy=no-user-gesture-required']
    });
    if (affinity) report.affinityChecks.push(require('./comparison-browser-affinity.cjs')(browserProfile, affinity, true));
    await context.addInitScript(() => {
      globalThis.__comparisonTextures = [];
      globalThis.__comparisonPresents = 0;
      globalThis.__comparisonInputs = [];
      const send = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'inputs') {
          globalThis.__comparisonInputs.push(...message.events);
          if (globalThis.__comparisonInputs.length > 128) globalThis.__comparisonInputs.splice(0, 64);
        }
        return send.call(this, message, ...args);
      };
      if (typeof GPUDevice === 'undefined') return;
      const create = GPUDevice.prototype.createTexture;
      GPUDevice.prototype.createTexture = function(descriptor) {
        if (/SceneColor|SceneDepth|TemporalAA/i.test(descriptor.label || ''))
          globalThis.__comparisonTextures.push({label: descriptor.label, size: descriptor.size});
        return create.call(this, descriptor);
      };
      const get = GPUCanvasContext.prototype.getCurrentTexture;
      GPUCanvasContext.prototype.getCurrentTexture = function() {
        globalThis.__comparisonPresents++;
        return get.call(this);
      };
    });
    const page = context.pages()[0];
    let run, lines = [];
    page.on('console', message => {
      const text = message.text();
      lines.push(text);
      if (run) fs.appendFileSync(path.join(directory, run.engine + '-console.log'), text + '\n');
      if (/GPU validation:|GPUValidationError|WEBGPU (?:PIPELINE )?ERROR|UE_RUN ERROR|HARNESS ABORT|Fatal error:|Assertion failed:|DeviceLost/.test(text))
        run?.errors.push(text);
    });
    page.on('pageerror', error => run?.errors.push(error.message));
    page.on('crash', () => run?.errors.push('Browser renderer crashed'));
    for (const engine of selected ? [selected] : ['ours', 'official']) {
      run = {engine, errors: [], startup: []}; report.runs.push(run); lines = [];
      const start = Date.now();
      if (report.runs.length === 1)
        await page.goto('http://127.0.0.1:8766/villa-engine-comparison.html' +
          (noLumen ? '?lighting=off' : '') + '#' + engine);
      else
        await page.locator('[data-engine="' + engine + '"]').click();
      await page.waitForFunction(() => document.querySelector('iframe')?.src.includes('index.html'));
      assert.equal(await page.locator('iframe').count(), 1);
      const iframe = await page.locator('iframe').elementHandle();
      const frame = await iframe.contentFrame();
      await frame.waitForSelector('#canvas', {state: 'attached', timeout: 30000});
      const timer = setInterval(async () => {
        try {
          const state = await frame.evaluate(() => ({
            stage: globalThis.__webStartupDiagnostics?.stage,
            frames: globalThis.__webEngineFrames,
            presents: globalThis.__comparisonPresents,
            failure: globalThis.__webEngineFailure,
            timing: globalThis.__harness?.timings
          }));
          run.startup.push({seconds: (Date.now() - start) / 1000, ...state});
          save(); console.log(JSON.stringify({engine, ...run.startup.at(-1)}));
        } catch {}
      }, 15000);
      try {
        await frame.waitForFunction(engine => engine === 'ours'
          ? globalThis.__webEngineFailure || (globalThis.__webEngineFrames > 60 && globalThis.__webPSOPrecacheReady)
          : globalThis.__comparisonPresents > 120, engine, {timeout: 900000});
      } finally { clearInterval(timer); }
      run.readySeconds = (Date.now() - start) / 1000;
      await page.waitForTimeout(10000);
      run.state = await frame.evaluate(() => ({
        isolated: crossOriginIsolated,
        browser: {dpr: devicePixelRatio, width: innerWidth, height: innerHeight},
        canvas: {width: document.getElementById('canvas').width, height: document.getElementById('canvas').height},
        failure: globalThis.__webEngineFailure,
        view: globalThis.__webRenderView,
        camera: globalThis.__webDefaultCamera,
        settings: globalThis.__webProjectSettings,
        scheduler: globalThis.__webFrameScheduler,
        threads: globalThis.__webEngineThreads,
        performance: globalThis.__webLivePerformance,
        pso: globalThis.__webPSOPrecache,
        prewarm: globalThis.__webPipelinePrewarm,
        officialPerformance: globalThis.__ue59Performance,
        hud: document.querySelector('#web-performance-hud')?.textContent,
        textures: globalThis.__comparisonTextures,
        args: globalThis.Module?.arguments
      }));
      save();
      assert(run.state.isolated, 'Cross-origin isolation unavailable inside comparison frame');
      assert(!run.state.failure, JSON.stringify(run.state.failure));
      assert.deepEqual(run.state.canvas, {width: profile.width, height: profile.height});
      assert(run.state.hud?.includes('FPS'), 'Frame statistics HUD missing');
      assert(run.state.performance?.submitted?.fps > 0, 'HUD did not measure engine submissions');
      assert(run.state.performance?.submitted?.low > 0, 'HUD has no 1% Low sample');
      run.resolutionLabel = await page.locator('#render-status').textContent();
      assert(run.resolutionLabel.includes('渲染 1920×1080'), run.resolutionLabel);
      assert.equal(await page.locator('#render-status').getAttribute('data-state'), 'match');
      if (engine === 'ours') {
        assert.deepEqual({width: run.state.view.width, height: run.state.view.height},
          {width: profile.width, height: profile.height}, 'Our actual scene resolution differs from comparison profile');
        if (profile.startupBaseline) {
          assert(run.state.prewarm?.ready && run.state.prewarm.adopted, 'Recorded PSOs were not adopted');
          assert(run.state.prewarm.counts.ready > 0 && run.state.prewarm.counts.hits > 0);
          assert.equal(run.state.prewarm.counts.misses, 0, 'Startup pipeline missing from the recorded pack');
        } else assert(run.state.pso?.enabled, 'Our PSO precache is disabled');
        for (const [key, value] of Object.entries({antiAliasing: 2,
          gi: profile.settings['r.DynamicGlobalIlluminationMethod'],
          reflections: profile.settings['r.ReflectionMethod'],
          virtualShadows: 0, texturePoolMiB: 496, screenPercentage: 100}))
          assert.equal(run.state.settings[key], value, key);
        const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
        run.workerBrowser = await owner.evaluate(() => globalThis.__webBrowserState);
        assert.deepEqual(run.workerBrowser, {width: profile.width, height: profile.height, dpr: 1});
        const checkPoint = async () => {
          await frame.evaluate(() => {
            globalThis.__comparisonInputs = [];
            const canvas = document.getElementById('canvas'), rect = canvas.getBoundingClientRect();
            const point = {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true};
            canvas.dispatchEvent(new MouseEvent('mousemove', point));
            canvas.dispatchEvent(new WheelEvent('wheel', {...point, deltaY: 0}));
          });
          await frame.waitForFunction(() => [8, 9].every(type => globalThis.__comparisonInputs.some(event =>
            event[0] === type)), null, {timeout: 5000});
          const points = await frame.evaluate(() => globalThis.__comparisonInputs.filter(event => [8, 9].includes(event[0])));
          for (const point of points) assert.deepEqual(point.slice(3, 5), [profile.width / 2, profile.height / 2]);
          return points;
        };
        run.inputAtNativeSize = await checkPoint();
        await page.locator('iframe').evaluate(node => { node.width = 960; node.height = 540; });
        await page.waitForTimeout(1000);
        run.inputAtHalfSize = await checkPoint();
        assert.deepEqual(await owner.evaluate(() => globalThis.__webBrowserState), run.workerBrowser);
        assert.deepEqual(await frame.evaluate(() => ({
          width: __webRenderView.width, height: __webRenderView.height
        })), {width: profile.width, height: profile.height});
        await page.locator('iframe').evaluate(node => { node.width = 1920; node.height = 1080; });
        const cdp = await context.newCDPSession(page);
        const changedDpr = dpr + 0.5;
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1600, height: 1000, deviceScaleFactor: changedDpr, mobile: false
        });
        await frame.waitForFunction(expected => Math.abs(devicePixelRatio - expected) < 0.00001, changedDpr);
        await page.waitForTimeout(1000);
        run.dprChangedWhileRunning = await frame.evaluate(() => ({
          dpr: devicePixelRatio, width: __webRenderView.width, height: __webRenderView.height,
          canvasWidth: document.getElementById('canvas').width, canvasHeight: document.getElementById('canvas').height
        }));
        assert(Math.abs(run.dprChangedWhileRunning.dpr - changedDpr) < 0.00001);
        const {dpr: actualChangedDpr, ...changedSize} = run.dprChangedWhileRunning;
        assert.deepEqual(changedSize, {
          width: profile.width, height: profile.height,
          canvasWidth: profile.width, canvasHeight: profile.height
        });
        run.inputAfterDprChange = await checkPoint();
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 1600, height: 1000, deviceScaleFactor: dpr, mobile: false
        });
        await frame.waitForFunction(expected => Math.abs(devicePixelRatio - expected) < 0.00001, dpr);
        await page.waitForFunction(expected =>
          document.getElementById('render-status').textContent.endsWith('DPR ' + expected), dpr);
        await cdp.detach();
      } else {
        const metrics = run.state.officialPerformance;
        assert.deepEqual(metrics?.scene, {width: profile.width, height: profile.height});
        assert.equal(run.state.performance.source, 'final-canvas-submission-intervals');
        assert(metrics?.prewarm?.made?.pipelines_ready > 0, 'Official PSO pack did not warm pipelines');
        assert(metrics.prewarm.hits.render.hit + metrics.prewarm.hits.compute.hit > 0, 'No official PSO hits');
        assert.equal(metrics.prewarm.failures, 0, 'Official prewarm errors');
        await frame.evaluate(keys => {
          for (const key of keys) window.ueExec(key);
          window.ueExec('LogLoc');
          window.ueExec('FlushLog');
        }, Object.keys(profile.settings));
        await page.waitForTimeout(1500);
        const engineLog = await frame.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const logs = await root.getDirectoryHandle('logs');
          const file = await logs.getFileHandle((window.ueLogFile || 'triplexhousevilla.log').toLowerCase());
          return (await file.getFile()).text();
        });
        fs.writeFileSync(path.join(directory, engine + '-engine.log'), engineLog);
        run.actualSettings = {};
        for (const [key, expected] of Object.entries(profile.settings)) {
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const matches = [...engineLog.matchAll(new RegExp(escaped + '\\s*=\\s*"?(-?\\d+(?:\\.\\d+)?)', 'g'))];
          assert(matches.length, 'No engine value for ' + key);
          run.actualSettings[key] = Number(matches.at(-1)[1]);
          assert.equal(run.actualSettings[key], expected, key);
        }
      }
      await page.screenshot({path: path.join(directory, engine + '.png')});
      const stats = await sharp(path.join(directory, engine + '.png')).stats();
      run.image = {entropy: stats.entropy, standardDeviations: stats.channels.slice(0, 3).map(c => c.stdev)};
      assert(stats.entropy > 2, 'Scene image is unexpectedly blank');
      await frame.locator('canvas').focus();
      await page.keyboard.down('w'); await page.waitForTimeout(2000); await page.keyboard.up('w');
      await page.waitForTimeout(1000);
      await page.screenshot({path: path.join(directory, engine + '-moved.png')});
      run.afterMovement = await frame.evaluate(() => ({
        frames: globalThis.__webEngineFrames, presents: globalThis.__comparisonPresents,
        camera: globalThis.__webDefaultCamera, failure: globalThis.__webEngineFailure
      }));
      assert(!run.afterMovement.failure);
      if (engine === 'ours') {
        const before = run.state.camera, after = run.afterMovement.camera;
        run.movementDistance = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
        assert(run.movementDistance > 20, 'Keyboard movement did not reach the pawn');
      }
      await page.setViewportSize({width: 390, height: 844});
      await page.waitForTimeout(500);
      run.mobile = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        links: [...document.querySelectorAll('nav a')].map(a => {
          const rect = a.getBoundingClientRect();
          return {x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom};
        })
      }));
      assert(!run.mobile.overflow);
      await page.screenshot({path: path.join(directory, engine + '-mobile.png')});
      assert.deepEqual(await frame.evaluate(() => ({
        width: document.getElementById('canvas').width, height: document.getElementById('canvas').height
      })), {width: profile.width, height: profile.height});
      await page.setViewportSize({width: 1600, height: 1000});
      if (engine === 'official') {
        // Changing the iframe viewport exercises the official engine's resize path.
        await page.locator('iframe').evaluate(node => { node.width = 1280; node.height = 720; });
        await frame.waitForFunction(() => globalThis.__ue59Performance?.scene?.width === 1280 &&
          document.getElementById('canvas').height === 720, null, {timeout: 30000});
        run.engineResizeEvidence = await frame.evaluate(() => ({
          scene: globalThis.__ue59Performance.scene,
          canvas: {width: document.getElementById('canvas').width, height: document.getElementById('canvas').height}
        }));
        await page.locator('iframe').evaluate(node => { node.width = 1920; node.height = 1080; });
        await frame.waitForFunction(() => globalThis.__ue59Performance?.scene?.width === 1920 &&
          document.getElementById('canvas').height === 1080, null, {timeout: 30000});
      }
      assert.equal(run.errors.length, 0, run.errors.join('\n'));
      if (affinity) report.affinityChecks.push(require('./comparison-browser-affinity.cjs')(browserProfile, affinity, false));
      run.pass = true;
      fs.writeFileSync(path.join(directory, engine + '-console.log'), lines.join('\n'));
      save(); console.log(JSON.stringify({engine, pass: true, readySeconds: run.readySeconds, state: run.state}));
    }
    report.pass = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    console.error(error);
  } finally {
    save(); await context?.close();
  }
})();
