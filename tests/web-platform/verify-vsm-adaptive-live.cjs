'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2];
assert(tag && /^[a-z0-9-]+$/.test(tag));
const directory = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
process.env.TEMP = process.env.TMP = path.join(__dirname, 'build/test-tmp');
const report = {date: new Date().toISOString(), pass: false, errors: [], checks: [], states: [],
  startupFailures: [], sources: ['vsm-adaptive-live.html', 'vsm-adaptive-live.js',
    'diagnostics/package-vsm-adaptive-live.cjs', 'verify-vsm-adaptive-live.cjs'].map(name => audit(path.join(__dirname, name))),
  boundary: 'Functional live scene, actual shader selection, native player input and sizing verification. Not a performance benchmark.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/villa-shadow-page-20261111'), {
      channel: 'msedge', headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    const page = context.pages()[0] || await context.newPage();
    for (const previous of context.pages()) if (previous !== page) await previous.close();
    await page.goto('about:blank');
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    const snapshot = () => page.evaluate(() => {
      const child = document.querySelector('iframe').contentWindow, canvas = child.document.getElementById('canvas');
      return {page: __vsmAdaptiveLive, camera: child.__webDefaultCamera, player: child.__webPlayerView,
        view: child.__webRenderView, settings: child.__webProjectSettings, prewarm: child.__webPipelinePrewarm,
        probe: child.__webVSMAdaptiveProbe, canvas: {width: canvas?.width, height: canvas?.height},
        frames: child.__webEngineFrames};
    });
    const ready = async mode => {
      for (let attempt = 0; ; ++attempt) {
        await page.waitForFunction(mode => globalThis.__vsmAdaptiveLive?.error ||
          __vsmAdaptiveLive?.ready && !__vsmAdaptiveLive.busy && __vsmAdaptiveLive.mode === mode, mode, {timeout: 240000});
        const state = await snapshot();
        if (state.page.error?.includes('A valid external Instance reference no longer exists.') && attempt < 2) {
          report.startupFailures.push({mode, error: state.page.error}); save();
          console.log(JSON.stringify({mode, retry: attempt + 1, error: state.page.error}));
          await page.locator('#retry').click(); continue;
        }
        assert(!state.page.error, state.page.error);
        assert.equal(state.page.mode, mode); assert(state.player.active);
        for (const key of ['gi', 'reflections', 'virtualTextures', 'virtualShadows'])
          assert.equal(state.settings[key], 1);
        assert(state.settings.virtualShadowPathActive && state.settings.virtualTexturePathActive);
        assert(state.prewarm.ready && state.prewarm.adopted);
        assert.deepEqual([state.view.width, state.view.height, state.view.outputWidth, state.view.outputHeight,
          state.view.antiAliasing, state.canvas.width, state.canvas.height], [1400, 788, 1920, 1080, 4, 1920, 1080]);
        assert.equal(state.probe.enabled, mode === 'adaptive'); assert.deepEqual(state.probe.errors, []);
        for (const entry of ['main_0000be1c_baae4d21', 'main_000126b4_bf84489e']) {
          assert(state.probe.matched[entry] > 0); assert.equal(!!state.probe.replaced[entry], mode === 'adaptive');
        }
        assert.equal(await page.locator('iframe').count(), 1);
        assert.equal(page.workers().filter(w => w.url().includes('/web-engine-worker.js?')).length, 1);
        report.states.push(state); save();
        console.log(JSON.stringify({mode, ready: true, frames: state.frames, probe: state.probe}));
        return state;
      }
    };
    const input = async name => {
      const box = await page.frameLocator('iframe').locator('#canvas').boundingBox();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      const before = await snapshot(), moves = [];
      let moved, distance;
      for (const key of ['w', 's', 'a', 'd']) {
        try {await page.keyboard.down(key); await page.waitForTimeout(700);}
        finally {await page.keyboard.up(key);}
        await page.waitForTimeout(500); moved = await snapshot();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        moves.push({key, distance}); if (distance > 10) break;
      }
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      try {
        await page.mouse.down({button: 'right'});
        for (let step = 1; step <= 20; ++step) {
          await page.mouse.move(box.x + box.width * (.5 + step * .007), box.y + box.height * .5);
          await page.waitForTimeout(30);
        }
      } finally {await page.mouse.up({button: 'right'});}
      await page.waitForTimeout(600);
      const turned = await snapshot(), yaw = Math.abs((turned.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
      report.checks.push({name, before: before.camera, moved: moved.camera, turned: turned.camera, moves, yaw}); save();
      assert(distance > 10, name + ': WASD must move the visible camera');
      assert(yaw > 5, name + ': mouse drag must rotate the visible camera');
    };
    const layout = async name => {
      const bounds = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
        nodes: [...document.querySelectorAll('h1,.modes,button,select,.metrics,iframe')].filter(n =>
          !n.hidden && n.getBoundingClientRect().height).map(n => ({id: n.id || n.tagName,
          left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right,
          width: n.clientWidth, scroll: n.scrollWidth}))}));
      assert(bounds.scroll <= bounds.width + 1);
      for (const node of bounds.nodes) {
        assert(node.left >= -1 && node.right <= bounds.width + 1, name + ': outside viewport: ' + node.id);
        assert(node.scroll <= node.width + 1, name + ': text overflow: ' + node.id);
      }
      const box = await page.locator('iframe').boundingBox(), image = await page.screenshot({clip: {
        x: box.x + box.width * .55, y: box.y + box.height * .4, width: box.width * .3, height: box.height * .2}});
      const stats = (await sharp(image).stats()).channels.slice(0, 3);
      assert(stats.every(c => c.mean > 3 && c.stdev > 5), name + ': blank scene');
      await page.screenshot({path: path.join(directory, name + '.png')});
      report.checks.push({name, ...bounds, pixels: stats}); save();
    };
    const pose = async name => {
      await page.locator('#viewpoint').selectOption(name);
      await page.waitForFunction(() => __vsmAdaptiveLive.ready && !__vsmAdaptiveLive.busy);
      await page.waitForTimeout(1200);
      const current = await snapshot(); assert(current.player.active);
      report.checks.push({name: 'preset-' + name, camera: current.camera, player: current.player}); save();
      return current;
    };
    const preserved = (a, b, name) => {
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
        assert(Math.abs(a.camera[key] - b.camera[key]) < .1, name + ': camera changed: ' + key);
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'controlPitch', 'controlYaw', 'controlRoll'])
        assert(Math.abs(a.player[key] - b.player[key]) < .1, name + ': player changed: ' + key);
    };
    await page.goto('http://127.0.0.1:8765/vsm-adaptive-live.html');
    const initial = await ready('adaptive');
    await input('adaptive-free-roam');
    await pose('kitchen'); await layout('desktop-adaptive-kitchen');
    await input('adaptive-kitchen-free-roam');
    const held = await snapshot();
    await page.locator('.modes label:first-child').click();
    preserved(held, await ready('baseline'), 'adaptive-to-baseline');
    await layout('desktop-baseline');
    await input('baseline-free-roam');
    await pose('interior'); await pose('living'); await input('baseline-living-free-roam');
    await page.locator('#reset').click();
    await page.waitForFunction(() => __vsmAdaptiveLive.ready && !__vsmAdaptiveLive.busy);
    await page.waitForTimeout(500);
    preserved(initial, await snapshot(), 'reset');
    const heldBaseline = await snapshot();
    await page.locator('.modes label:last-child').click();
    preserved(heldBaseline, await ready('adaptive'), 'baseline-to-adaptive');
    await input('adaptive-after-switch');
    await page.waitForFunction(() => Number.isFinite(__vsmAdaptiveLive.observations.adaptive.metrics?.low),
      null, {timeout: 20000});
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(1200);
    await ready('adaptive'); await layout('mobile-adaptive');
    const downloaded = page.waitForEvent('download'); await page.locator('#export').click();
    const exportedPath = path.join(directory, 'ui-export.json'); await (await downloaded).saveAs(exportedPath);
    const exported = JSON.parse(fs.readFileSync(exportedPath));
    assert(exported.diagnosticOnly && exported.observations.baseline && exported.observations.adaptive);
    await page.setViewportSize({width: 1600, height: 1000}); await pose('kitchen');
    await layout('desktop-final-kitchen');
    assert.deepEqual(report.errors, []);
    const owner = page.workers().find(w => w.url().includes('/web-engine-worker.js?'));
    await owner.evaluate(() => {__webVSMAdaptiveProbe.enabled = false;});
    await page.waitForFunction(() => __vsmAdaptiveLive.error?.includes('实际采样模式'));
    assert(await page.locator('#retry').isVisible());
    report.checks.push({name: 'mismatched-probe-rejected', error: (await snapshot()).page.error});
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
