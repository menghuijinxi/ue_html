'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const {chromium} = require('playwright'), sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2]; assert(tag && /^[a-z0-9-]+$/.test(tag));
const modes = (process.argv.find(arg => arg.startsWith('--modes='))?.slice(8) ||
  'old,adaptive,indirect,pages,large,small').split(',');
const profile = process.argv.find(arg => arg.startsWith('--profile='))?.slice(10) || 'git-history-manual-verification';
assert(/^[a-z0-9-]+$/.test(profile));
assert(modes.every(mode => ['old', 'adaptive', 'indirect', 'pages', 'large', 'small'].includes(mode)));
const directory = assertProjectOutputTree(path.join(__dirname, 'results', tag));
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const report = {date: new Date().toISOString(), pass: false, modes, errors: [], states: [], checks: [],
  source: audit(__filename),
  boundary: 'Functional historical-package checks only: startup, prewarm, scene pixels, native movement/turning, pose preservation and physical sizing. No Low-FPS regression measurement or performance claim.'};
const save = () => fs.writeFileSync(assertProjectOutput(path.join(directory, 'result.json')), JSON.stringify(report, null, 2));
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(assertProjectOutputTree(path.join(__dirname,
      'build/browser-profiles', profile)), {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    const page = context.pages()[0] || await context.newPage();
    log = fs.createWriteStream(assertProjectOutput(path.join(directory, 'page.log')));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(text))
        report.errors.push(text);
    });
    const snapshot = () => page.evaluate(() => {
      const child = document.querySelector('iframe')?.contentWindow;
      return {state: globalThis.__villaGitHistory, camera: child?.__webDefaultCamera,
        player: child?.__webPlayerView, view: child?.__webRenderView, settings: child?.__webProjectSettings,
        prewarm: child?.__webPipelinePrewarm, rhi: child?.__webOcclusionRHI,
        canvas: child?.document.getElementById('canvas') &&
          [child.document.getElementById('canvas').width, child.document.getElementById('canvas').height]};
    });
    async function ready(mode) {
      await page.waitForFunction(mode => __villaGitHistory?.error ||
        __villaGitHistory?.ready && !__villaGitHistory.busy && __villaGitHistory.mode === mode,
      mode, {timeout: 240000});
      const state = await snapshot(); assert(!state.state.error, state.state.error);
      assert(state.prewarm?.ready && state.prewarm.adopted);
      assert.deepEqual([state.view.width, state.view.height, state.view.outputWidth,
        state.view.outputHeight, state.view.antiAliasing, ...state.canvas], [1400, 788, 1920, 1080, 4, 1920, 1080]);
      assert.equal(state.settings.gi, 1); assert.equal(state.settings.reflections, 1);
      assert.equal(state.settings.virtualTextures, 1); assert.equal(state.settings.virtualShadows, 1);
      assert.equal(await page.locator('iframe').count(), 1);
      report.states.push({mode, ...state}); save(); console.log(JSON.stringify({mode, ready: true}));
      return state;
    }
    async function input(mode) {
      await page.locator('#viewpoint').selectOption('interior');
      await page.waitForFunction(() => !__villaGitHistory.busy);
      await page.waitForTimeout(1000);
      const canvas = page.frameLocator('iframe').locator('#canvas'), box = await canvas.boundingBox();
      await canvas.click();
      const before = await snapshot(); let moved, distance = 0;
      for (const key of ['w', 's', 'a', 'd']) {
        try {await page.keyboard.down(key); await page.waitForTimeout(700);}
        finally {await page.keyboard.up(key);}
        await page.waitForTimeout(400); moved = await snapshot();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        if (distance > 10) break;
      }
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      try {
        await page.mouse.down({button: 'right'});
        for (let step = 1; step <= 20; step++) {
          await page.mouse.move(box.x + box.width * (.5 + step * .007), box.y + box.height * .5);
          await page.waitForTimeout(30);
        }
      } finally {await page.mouse.up({button: 'right'});}
      await page.waitForTimeout(600);
      const turned = await snapshot(), yaw = Math.abs((turned.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
      report.checks.push({mode, nativeMovementCm: distance, nativeTurnDegrees: yaw}); save();
      assert(distance > 10 && yaw > 5, 'Native player must respond to keyboard and mouse');
    }
    async function screenshot(name) {
      const layout = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
        items: [...document.querySelectorAll('h1,.modes,button,select,.metrics,iframe')].filter(node =>
          !node.hidden && node.getBoundingClientRect().height).map(node => {
          const rect = node.getBoundingClientRect();
          return {id: node.id || node.tagName, left: rect.left, right: rect.right,
            width: node.clientWidth, scroll: node.scrollWidth};
        })}));
      assert(layout.scroll <= layout.width + 1);
      for (const item of layout.items) {
        assert(item.left >= -1 && item.right <= layout.width + 1, item.id);
        assert(item.scroll <= item.width + 1, 'Overflow: ' + item.id);
      }
      const box = await page.locator('iframe').boundingBox();
      const bytes = await page.screenshot({clip: {x: box.x + box.width * .3, y: box.y + box.height * .3,
        width: box.width * .5, height: box.height * .4}});
      assert((await sharp(bytes).stats()).channels.slice(0, 3).every(channel => channel.mean > 3 && channel.stdev > 5));
      await page.screenshot({path: assertProjectOutput(path.join(directory, name + '.png'))});
      report.checks.push({name, nonblank: true, layout}); save();
    }
    await page.goto('http://127.0.0.1:8765/villa-git-history-live.html#' + modes[0]);
    let previous;
    for (const mode of modes) {
      if (previous) {
        await page.locator('.modes label').filter({has: page.locator('[value=' + mode + ']')}).click();
      }
      const state = await ready(mode);
      if (previous) for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
        assert(Math.abs(previous.camera[key] - state.camera[key]) < .1, 'Switch changed camera ' + key);
      await input(mode); await screenshot(mode + '-desktop');
      previous = await snapshot();
    }
    await page.waitForFunction(() => Number.isFinite(__villaGitHistory.observations[__villaGitHistory.mode]?.metrics?.low),
      null, {timeout: 20000});
    await page.setViewportSize({width: 390, height: 844});
    await page.waitForTimeout(1000); await ready(modes.at(-1)); await screenshot('mobile');
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
