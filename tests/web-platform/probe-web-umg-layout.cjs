'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {readPage} = require('./web-pipeline-prewarm-package.cjs');
const {audit} = require('./content-file-metadata.cjs');
const {PNG} = require('pngjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder');
const tag = option('report') || 'umg-layout';
const adaptive = process.argv.includes('--adaptive');
const gpuLayout = process.argv.includes('--gpu-layout');
const cabinet = process.argv.includes('--cabinet');
const rapidConfirm = process.argv.includes('--rapid-confirm');
const dpr = Number(option('dpr') || 1.5);
assert(typeof folder === 'string' && /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(folder),
  'Specify --folder=<package directory relative to build/>');
assert(/^[a-z0-9-]+$/.test(tag));
assert([1, 1.25, 1.5, 2].includes(dpr));
const output = assertProjectOutput(path.join(__dirname, 'results', tag + '.json'));
const profile = assertProjectOutputTree(path.join(__dirname, 'build/browser-profiles', tag));
const source = readPage(path.join(__dirname, 'build', folder));
const report = {date: new Date().toISOString(), pass: false, folder, adaptive, cabinet, rapidConfirm, dpr,
  sources: [__filename, 'diagnostics/web-slate-layout-observer.js', 'web-engine-worker.js',
    'web-engine-host.js', 'web-default-template.html',
    '../ue-web-smoke/Source/UEWebEngine/Private/UEWebEngine.cpp',
    '../ue-web-smoke/Source/UEWebEngine/Private/WebViewportLayout.h',
    '../../reference-engine/Engine/Platforms/Web/Source/Runtime/ApplicationCore/Private/Web/WebApplication.cpp',
    '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp']
    .map(file => audit(path.resolve(__dirname, file))),
  runtimeVersions: source.assets.versions, samples: [], errors: [],
  boundary: 'Explicit CPU layout and optional direct Slate draw diagnostic against an existing Cook. ' +
    'Screenshots require visual review; font rendering and other widgets are not certified. No package is published.'};
let context, server, log, page;
const watchdog = setTimeout(() => {
  report.failure = 'Layout diagnostic exceeded five minutes';
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  context?.close().catch(() => {});
  setTimeout(() => process.exit(1), 5000);
}, 300000);

(async () => {
  try {
    server = require('./serve.cjs');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: {width: 1280, height: 800}, deviceScaleFactor: dpr,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]
    });
    page = await context.newPage();
    console.log(JSON.stringify({phase: 'browser-ready', folder, dpr}));
    log = fs.createWriteStream(assertProjectOutput(path.join(__dirname, 'results', tag + '.log')));
    let layout, widgets = [], sliders = [], interactions = [], input;
    page.on('console', message => {
      const text = message.text();
      log.write(text + '\n');
      if (text.startsWith('P3_UI_LAYOUT ')) layout = JSON.parse(text.slice(13));
      if (text.startsWith('P3_UI_WIDGET ')) widgets.push(JSON.parse(text.slice(13)));
      if (text.startsWith('P3_UI_INTERACTION ')) interactions.push(JSON.parse(text.slice(18)));
      if (text.startsWith('P3_UI_INPUT ')) input = JSON.parse(text.slice(12));
      if (text.startsWith('P3_UI_SLIDER ')) sliders.push(JSON.parse(text.slice(13)));
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('requestfailed', request => report.errors.push(request.url() + ': ' + request.failure()?.errorText));
    page.on('worker', worker => {
      if (/web-engine-worker\.js/.test(worker.url()))
        console.log(JSON.stringify({phase: 'worker', url: worker.url()}));
    });
    const pageData = {...source, assets: structuredClone(source.assets), args: [...source.args]};
    if (adaptive) {
      delete pageData.assets.fixedRenderSize;
      delete pageData.assets.renderSizing;
      delete pageData.assets.pipelinePrewarm;
      pageData.args = pageData.args.filter(arg => !/^-ForceRes$|^-Res[XY]=/i.test(arg));
    }
    if (gpuLayout) {
      // Limit this explicit GPU diagnostic to pipelines needed by the sampled frames.
      delete pageData.assets.pipelinePrewarm;
      pageData.args = pageData.args.filter(arg => !/^-WebPSOPrecache$/i.test(arg));
    }
    report.arguments = pageData.args;
    if (adaptive || gpuLayout) {
      await context.route('**/index.html', route => route.fulfill({contentType: 'text/html',
        headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
        body: source.html.replace(source.assetsMatch[0], 'const localRuntimeAssets = ' +
          JSON.stringify(pageData.assets) + ';').replace(source.argsMatch[0],
          'arguments: ' + JSON.stringify(pageData.args) + ',')
      }));
    }
    if (gpuLayout) {
      const observer = fs.readFileSync(path.join(__dirname, 'diagnostics/web-slate-layout-observer.js'), 'utf8');
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        await route.fulfill({response, body: observer + '\n' + await response.text()});
      });
    }
    await page.goto(origin + '/build/' + folder + '/index.html');
    console.log(JSON.stringify({phase: 'page-loaded'}));
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 60 && document.getElementById('loading')?.hidden,
    null, {timeout: 180000});
    assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
    const capture = async label => {
      layout = null; widgets = []; sliders = []; interactions = []; input = null;
      assert(await page.evaluate(cabinet => __webEngineRPC('WebViewportLayoutTest', cabinet ? 1 : 0), cabinet));
      for (let attempt = 0; !layout && attempt < 50; ++attempt) await page.waitForTimeout(20);
      assert(layout, 'Missing native layout diagnostic');
      const browser = await page.evaluate(() => {
        const canvas = document.getElementById('canvas'), rect = canvas.getBoundingClientRect();
        return {css: [rect.x, rect.y, rect.width, rect.height], canvas: [canvas.width, canvas.height],
          surface: globalThis.__webEngineSurface, view: globalThis.__webRenderView, dpr: devicePixelRatio,
          cursor: getComputedStyle(canvas).cursor, cursorState: globalThis.__webCursorState,
          pointerLocked: document.pointerLockElement === canvas,
          camera: globalThis.__webDefaultCamera, player: globalThis.__webPlayerView};
      });
      const screenshot = assertProjectOutput(path.join(__dirname, 'results', tag + '-' + label + '.png'));
      await page.screenshot({path: screenshot});
      const sample = {label, browser, layout, input, widgets, sliders, ...(cabinet ? {interactions} : {}),
        screenshot: audit(screenshot)};
      report.samples.push(sample);
      console.log(JSON.stringify({label, canvas: browser.canvas, cursor: browser.cursorState,
        pointerLocked: browser.pointerLocked, input, widgetCount: widgets.length,
        sliders: sliders.map(({name, value}) => ({name, value}))}));
      return sample;
    };
    await capture('startup');
    const owner = page.workers().find(worker => /web-engine-worker\.js/.test(worker.url()));
    if (gpuLayout)
      await owner.evaluate(() => {__webSlateLayoutProbe.enabled = true;});
    const advance = async () => {
      const frame = await page.evaluate(() => __webEngineFrames);
      await page.waitForFunction(frame => __webEngineFrames >= frame + 10, frame, {timeout: 30000});
    };
    let restorePlayer, kitchenPose, interactionPose;
    if (cabinet) {
      const restore = async (mode, values) => {
        const serial = await page.evaluate(({mode, values}) =>
          __webEngineRPC('WebPlayerViewControl', mode, ...values), {mode, values});
        assert(serial > 0, 'Player controller unavailable');
        await page.waitForFunction(serial => globalThis.__webPlayerView?.serial === serial && __webPlayerView.active,
          serial, {timeout: 10000});
        await advance();
      };
      await restore(0, Array(9).fill(0));
      const offset = await page.evaluate(() => __webDefaultCamera.z - __webPlayerView.z);
      restorePlayer = restore;
      kitchenPose = [-175, -80, 160 - offset, 0, 230, 0, -5, 230, 0];
      await restore(1, kitchenPose);
      const before = await capture('cabinet-before');
      const target = before.interactions.filter(item => item.class === 'BP_CupboardDoor_C').sort((a, b) =>
        Math.hypot(a.center[0] + 175, a.center[1] + 80) -
        Math.hypot(b.center[0] + 175, b.center[1] + 80))[0];
      assert(target, 'Missing real color interaction volume');
      interactionPose = [target.center[0], target.center[1], 160 - offset, 0, 230, 0, -5, 230, 0];
      await restore(1, interactionPose);
      await capture('interaction-before');
      const box = await page.locator('#canvas').boundingBox();
      await page.mouse.move(box.x + box.width * .443, box.y + box.height * .45);
      await advance();
      await page.mouse.click(box.x + box.width * .443, box.y + box.height * .45);
    } else {
      assert(await page.evaluate(() => __webEngineRPC('WebProjectWidgetTest', 1)));
    }
    await advance();
    const opened = await capture('widget');
    if (cabinet) assert(opened.widgets.some(widget => widget.owner === 'W_RGBSlider_C'),
      'Cabinet click did not open the actual RGB panel');
    if (cabinet) {
      assert.equal(opened.browser.cursorState?.visible, true, 'Opening the RGB panel must show the cursor');
      assert.equal(opened.browser.pointerLocked, false, 'RGB panel must release pointer lock');
      const button = opened.widgets.find(widget => widget.class === 'Button' && widget.name === 'set');
      assert(button, 'Missing confirmation button');
      const [left, top, right, bottom] = button.rect, [width, height] = opened.browser.canvas;
      assert(left >= 0 && top >= 0 && right <= width && bottom <= height,
        'Confirmation button is outside the physical canvas');
      const box = await page.locator('#canvas').boundingBox(), x = (left + right) / 2, y = (top + bottom) / 2;
      await page.mouse.move(box.x + x * box.width / width, box.y + y * box.height / height);
      await advance();
      const hover = await capture('button-hover');
      assert(Math.abs(hover.input.cursor[0] - x) <= 2 && Math.abs(hover.input.cursor[1] - y) <= 2,
        'Visible UI cursor must receive absolute mouse movement while raw input remains enabled');
      // Locate the rendered hue strip and exercise the original Cooked widget.
      const image = PNG.sync.read(fs.readFileSync(hover.screenshot.file));
      const border = opened.widgets.find(widget => widget.class === 'Border').rect;
      const pixel = (image, x, y) => {
        const px = Math.round((box.x + x * box.width / width) * dpr);
        const py = Math.round((box.y + y * box.height / height) * dpr);
        return image.data.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 3);
      };
      let strip;
      for (let y = Math.ceil(border[1]); y < border[1] + (border[3] - border[1]) / 2; ++y) {
        const xs = [], colors = [0, 0, 0];
        for (let x = Math.ceil(border[0]); x < border[2]; ++x) {
          const rgb = [...pixel(image, x, y)], max = Math.max(...rgb), min = Math.min(...rgb);
          if (max > 200 && max - min > 160) {
            xs.push(x);
            colors[rgb.indexOf(max)]++;
          }
        }
        if (colors.every(count => count >= 20) && (!strip || xs.length > strip.count))
          strip = {y, left: xs[0], right: xs.at(-1), count: xs.length};
      }
      assert(strip && strip.count > 100, 'Missing rendered hue slider');
      report.hueStrip = strip;
      const point = value => ({x: box.x + (strip.left + (strip.right - strip.left) * value) * box.width / width,
        y: box.y + strip.y * box.height / height});
      await page.mouse.move(point(.15).x, point(.15).y);
      await page.mouse.down();
      let down, dragged;
      try {
        await advance();
        down = await capture('slider-down');
        await page.mouse.move(point(.8).x, point(.8).y, {steps: 8});
        await advance();
        dragged = await capture('slider-drag');
      } finally { await page.mouse.up(); }
      const downImage = PNG.sync.read(fs.readFileSync(down.screenshot.file));
      const dragImage = PNG.sync.read(fs.readFileSync(dragged.screenshot.file));
      let changed = 0;
      for (let y = strip.y - 15; y <= strip.y + 8; ++y)
        for (let x = strip.left; x <= strip.right; ++x) {
          const a = pixel(downImage, x, y), b = pixel(dragImage, x, y);
          if (a.some((value, index) => Math.abs(value - b[index]) > 64)) changed++;
        }
      report.sliderChangedPixels = changed;
      assert(changed > 100, 'Dragging must visibly move the original hue slider');
      const value = sample => sample.sliders.find(item => item.name === 'R')?.value;
      assert(Math.abs(value(dragged) - value(down)) > .3,
        'Dragging must change the actual UE hue value');
      assert.equal(dragged.browser.pointerLocked, false, 'Dragging UI must stay unlocked');
    }
    const captureGPU = async () => {
      if (!gpuLayout) return;
      report.gpuLayout = await owner.evaluate(() => __webSlateLayoutSnapshot());
      fs.writeFileSync(assertProjectOutput(path.join(__dirname, 'results', tag + '-gpu.json')),
        JSON.stringify(report.gpuLayout, null, 2));
      assert(report.gpuLayout.drawCount > 0, 'No direct Slate draws observed');
      assert.equal(report.gpuLayout.zeroInstances, 0, 'Slate submitted zero instances');
      const sample = report.samples.at(-1), draw = report.gpuLayout.lastDraw;
      sample.gpu = {drawCount: report.gpuLayout.drawCount, zeroInstances: report.gpuLayout.zeroInstances,
        lastDraw: draw};
      assert.deepEqual(draw.viewport?.slice(0, 4), [0, 0, ...sample.browser.canvas],
        sample.label + ': Slate GPU viewport differs from canvas');
    };
    await captureGPU();
    for (const size of [{width: 900, height: 700}, {width: 1600, height: 1000}]) {
      await page.setViewportSize(size);
      await advance();
      await capture('resize-' + size.width);
      await captureGPU();
    }
    if (cabinet) {
      const confirm = async label => {
        const sample = report.samples.at(-1);
        const button = sample.widgets.find(widget => widget.class === 'Button' && widget.name === 'set');
        assert(button, 'Confirmation button missing after resize');
        const [left, top, right, bottom] = button.rect, [width, height] = sample.browser.canvas;
        assert(left >= 0 && top >= 0 && right <= width && bottom <= height);
        const box = await page.locator('#canvas').boundingBox();
        if (!rapidConfirm) {
          await page.mouse.move(box.x + (left + right) / 2 * box.width / width,
            box.y + (top + bottom) / 2 * box.height / height);
          await advance();
          const hover = await capture(label + '-hover');
          assert(hover.input.hit.endsWith('/SButton/'), 'Confirmation must hit the actual Slate button');
        }
        await page.mouse.click(box.x + (left + right) / 2 * box.width / width,
          box.y + (top + bottom) / 2 * box.height / height);
        await advance();
        const closed = await capture(label);
        assert(!closed.widgets.some(widget => widget.owner === 'W_RGBSlider_C'),
          'Clicking the actual confirmation button must close the panel');
        assert.equal(closed.input.show, 0, 'Confirmation must restore the UE hidden cursor');
        assert.equal(closed.browser.cursorState?.visible, false, 'Confirmation must hide the browser cursor');
        assert.equal(closed.browser.cursor, closed.browser.cursorState?.css,
          'Browser cursor must follow the Slate cursor request');
        assert.equal(closed.browser.pointerLocked, false, 'UI click must not reacquire pointer lock');
      };
      await confirm('confirmed');
      let box;
      for (let cycle = 1; cycle <= 3; ++cycle) {
        const suffix = cycle === 1 ? '' : '-' + cycle;
        await restorePlayer(1, kitchenPose);
        box = await page.locator('#canvas').boundingBox();
        await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
        await advance();
        const game = await capture('game-focus' + suffix);
        assert.equal(game.browser.cursorState?.visible, false, 'Game focus must hide the browser cursor');
        await restorePlayer(1, interactionPose);
        box = await page.locator('#canvas').boundingBox();
        await page.mouse.click(box.x + box.width * .443, box.y + box.height * .45);
        await advance();
        const reopened = await capture('reopened' + suffix);
        assert(reopened.widgets.some(widget => widget.owner === 'W_RGBSlider_C'));
        assert.equal(reopened.browser.cursorState?.visible, true);
        assert.equal(reopened.browser.pointerLocked, false);
        await confirm('confirmed-again' + suffix);
      }
      await restorePlayer(1, kitchenPose);
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      await advance();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      await advance();
      const gameAgain = await capture('game-focus-again');
      assert.equal(gameAgain.browser.cursorState?.visible, false);
      assert.equal(gameAgain.browser.pointerLocked, true, 'Game input must regain pointer lock');
    }
    for (const sample of report.samples) {
      assert.deepEqual(sample.layout.window.slice(2), sample.browser.canvas, sample.label + ': Slate/canvas size');
      assert.deepEqual(sample.layout.viewport, sample.browser.canvas, sample.label + ': game viewport/canvas size');
      assert.deepEqual(sample.layout.native.slice(2), sample.browser.canvas, sample.label + ': native/canvas size');
      const [width, height, scale] = sample.layout.geometry;
      assert(Math.abs(width * scale - sample.browser.canvas[0]) <= 1 &&
        Math.abs(height * scale - sample.browser.canvas[1]) <= 1, sample.label + ': viewport geometry');
      if (cabinet) for (const widget of sample.widgets.filter(widget => widget.name === 'set')) {
        const [left, top, right, bottom] = widget.rect;
        assert(left >= 0 && top >= 0 && right <= sample.browser.canvas[0] &&
          bottom <= sample.browser.canvas[1], sample.label + ': confirmation button bounds');
      }
    }
    assert.deepEqual(report.errors, []);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    if (gpuLayout && page) {
      const owner = page.workers().find(worker => /web-engine-worker\.js/.test(worker.url()));
      report.gpuLayout = await owner?.evaluate(() => __webSlateLayoutSnapshot()).catch(() => null);
    }
    if (page && !page.isClosed()) report.failureState = await page.evaluate(() => ({
      failure: globalThis.__webEngineFailure, diagnostics: globalThis.__webStartupDiagnostics,
      log: globalThis.__webEngineLog?.slice(-25), workers: globalThis.__webEngineThreads,
      text: document.getElementById('diagnostic-report')?.textContent
    })).catch(snapshotError => ({error: snapshotError.message}));
    throw error;
  } finally {
    clearTimeout(watchdog);
    await context?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => log ? log.end(resolve) : resolve());
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
