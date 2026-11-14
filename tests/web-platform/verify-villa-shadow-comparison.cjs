'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'); assert(tag && /^[a-z0-9-]+$/.test(tag));
const profile = option('profile') || tag; assert(/^[a-z0-9-]+$/.test(profile));
const directory = path.join(__dirname, 'results', tag); assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const report = {date: new Date().toISOString(), pass: false, errors: [], states: [], checks: [],
  sources: ['villa-shadow-comparison.html', 'villa-shadow-comparison.js', 'verify-villa-shadow-comparison.cjs']
    .map(name => audit(path.join(__dirname, name))),
  boundary: 'Functional UI and actual WebGPU rendering checks, not a new performance benchmark.'};
let context, log;
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', profile), {
      channel: 'msedge', headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    const page = context.pages()[0]; log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    const check = async mode => {
      await page.waitForFunction(mode => globalThis.__shadowComparison?.error ||
        globalThis.__shadowComparison?.ready && __shadowComparison.mode === mode, mode, {timeout: 180000});
      const state = await page.evaluate(() => {
        const child = document.querySelector('iframe').contentWindow;
        return {comparison: __shadowComparison, settings: child.__webProjectSettings, view: child.__webRenderView,
          camera: child.__webDefaultCamera, player: child.__webPlayerView, prewarm: child.__webPipelinePrewarm,
          canvas: {width: child.document.getElementById('canvas').width, height: child.document.getElementById('canvas').height},
          text: document.querySelector('.metrics').innerText, frames: child.__webEngineFrames};
      });
      assert(!state.comparison.error, state.comparison.error); assert.deepEqual(report.errors, []);
      assert.equal(state.settings.virtualShadows, Number(mode === 'on'));
      assert.equal(state.settings.virtualShadowPathActive, mode === 'on');
      for (const key of ['gi', 'reflections', 'virtualTextures']) assert.equal(state.settings[key], 1);
      assert(state.settings.virtualTexturePathActive && state.prewarm.ready && state.prewarm.adopted);
      assert(state.player?.active, 'The possessed player camera must be active');
      assert.deepEqual([state.view.width, state.view.height, state.view.outputWidth, state.view.outputHeight,
        state.view.antiAliasing, state.canvas.width, state.canvas.height], [1400, 788, 1920, 1080, 4, 1920, 1080]);
      assert.equal(await page.locator('iframe').count(), 1);
      assert.equal(page.workers().filter(worker => worker.url().includes('/web-engine-worker.js?')).length, 1);
      report.states.push(state); save();
      console.log(JSON.stringify({mode, ready: true, frames: state.frames, prewarm: state.prewarm.counts}));
      return state;
    };
    const childState = () => page.evaluate(() => {
      const child = document.querySelector('iframe').contentWindow;
      return {camera: child.__webDefaultCamera, player: child.__webPlayerView,
        motion: child.__webMotionBenchmark, frames: child.__webEngineFrames};
    });
    const playerInput = async name => {
      const canvas = page.frameLocator('iframe').locator('#canvas'), box = await canvas.boundingBox();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      const before = await childState();
      let moved, distance = 0;
      const keys = [];
      // Preserve the project's collisions; a restored player may face a wall.
      for (const key of ['w', 's', 'a', 'd']) {
        try {
          await page.keyboard.down(key);
          await page.waitForTimeout(700);
        } finally {await page.keyboard.up(key);}
        await page.waitForTimeout(500);
        moved = await childState();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        keys.push({key, distance});
        if (distance > 10) break;
      }
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      try {
        await page.mouse.down({button: 'right'});
        for (let i = 1; i <= 20; ++i) {
          await page.mouse.move(box.x + box.width * (.5 + i * .007), box.y + box.height * .5);
          await page.waitForTimeout(30);
        }
      } finally {await page.mouse.up({button: 'right'});}
      await page.waitForTimeout(600);
      const turned = await childState();
      const yaw = Math.abs((turned.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
      report.checks.push({name, before, moved, turned, keys, distance, yaw}); save();
      assert(distance > 10, name + ': movement keys must move the visible player camera');
      assert(yaw > 5, name + ': mouse drag must turn the visible player camera');
    };
    const playerReady = () => page.waitForFunction(() => !__shadowComparison.busy &&
      document.querySelector('iframe').contentWindow.__webPlayerView?.active &&
      document.getElementById('stop').disabled, null, {timeout: 45000});
    const layout = async name => {
      const checks = await page.evaluate(() => {
        const visible = [...document.querySelectorAll('header h1,.modes,button,select,.metrics,footer,iframe')]
          .filter(node => !node.hidden && node.getBoundingClientRect().height);
        return {width: innerWidth, scroll: document.documentElement.scrollWidth,
          bounds: visible.map(node => ({name: node.id || node.tagName, left: node.getBoundingClientRect().left,
            right: node.getBoundingClientRect().right, width: node.clientWidth, scroll: node.scrollWidth})),
          tableRows: document.querySelectorAll('#baseline tr').length};
      });
      assert(checks.scroll <= checks.width + 1, name + ': horizontal overflow');
      for (const bound of checks.bounds) {
        assert(bound.left >= -1 && bound.right <= checks.width + 1, name + ': out of viewport ' + bound.name);
        assert(bound.scroll <= bound.width + 1, name + ': text overflow ' + bound.name);
      }
      assert.equal(checks.tableRows, 3);
      const box = await page.locator('iframe').boundingBox();
      // Inspect the scene centre, excluding controls and the native HUD.
      const pixels = await page.screenshot({clip: {x: box.x + box.width * .55, y: box.y + box.height * .4,
        width: box.width * .3, height: box.height * .2}});
      const stats = await sharp(pixels).stats();
      assert(stats.channels.slice(0, 3).every(channel => channel.mean > 3 && channel.stdev > 5),
        name + ': scene must contain rendered detail');
      await page.screenshot({path: path.join(directory, name + '.png')});
      report.checks.push({name, ...checks, scenePixelStats: stats.channels.slice(0, 3)});
    };
    await page.goto('http://127.0.0.1:8765/villa-shadow-comparison.html');
    const initial = await check('on');
    await playerInput('initial-player-input');
    await page.waitForFunction(() => Number.isFinite(__shadowComparison.observations.on.metrics?.low), null, {timeout: 15000});
    await layout('desktop-on');
    await page.locator('#run').click();
    await page.waitForTimeout(2500);
    const turning = await childState();
    assert(turning.motion.active && turning.motion.mode === 2);
    assert(Math.abs(turning.camera.yaw - 50) > 10);
    await page.locator('#stop').click(); await playerReady();
    await playerInput('after-route-stop');
    const held = (await childState()).camera;
    await page.locator('.modes label:last-child').click();
    const off = await check('off');
    for (const key of ['x', 'y', 'z', 'pitch', 'yaw']) assert(Math.abs(off.camera[key] - held[key]) < .1, 'View not preserved: ' + key);
    await playerInput('after-shadow-switch-off');
    await page.waitForTimeout(4000); await layout('desktop-off');
    await page.locator('#reset').click(); await playerReady();
    await page.waitForTimeout(500);
    const reset = (await childState()).camera;
    for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
      assert(Math.abs(reset[key] - initial.camera[key]) < .1, 'Player spawn not restored: ' + key);
    await playerInput('after-player-reset');
    const beforeRoute = await childState();
    await page.locator('#route').selectOption('1'); await page.locator('#run').click();
    await page.waitForTimeout(2500);
    const moving = await childState();
    assert(moving.motion.active && moving.motion.mode === 1);
    assert(Math.hypot(moving.camera.x + 175, moving.camera.y + 80) > 50);
    await playerReady();
    const completed = await childState();
    assert(completed.motion.completed && !completed.motion.active);
    for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
      assert(Math.abs(completed.camera[key] - beforeRoute.camera[key]) < .1, 'Route must return to player: ' + key);
    await playerInput('after-route-completion');
    const downloaded = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloaded, exportPath = path.join(directory, 'ui-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath));
    assert(exported.observations.on && exported.observations.off);
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(1500); await check('off'); await layout('mobile-off');
    await page.locator('#reset').click(); await page.waitForTimeout(500);
    await page.locator('.modes label:first-child').click();
    await check('on'); await page.waitForTimeout(2500); await layout('mobile-on');
    await page.setViewportSize({width: 1600, height: 1000});
    await page.waitForTimeout(1000); await layout('desktop-return');
    await playerInput('after-shadow-switch-on');
    report.cameraChecks = {turning, held, reset, moving, completed};
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
