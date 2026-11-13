'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), sharp = require('sharp');
const [suite, tag, initialMode = 'components'] = process.argv.slice(2);
assert([suite, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
const base = path.resolve(__dirname, '..');
const variants = JSON.parse(fs.readFileSync(path.join(base, 'build', suite, 'suite.json'))).variants;
assert(variants[initialMode]);
const output = assertProjectOutput(path.join(base, 'results', tag + '.json'));
assert(!fs.existsSync(output), 'Preserve prior verification results');
const report = {date: new Date().toISOString(), initialMode, pass: false,
  boundary: 'Live page operation, native input, mode switching and manual export only; no FPS comparison.'};
let browser, gcTimer;
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/villa-pso-startup-20261113'));
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--enable-logging', '--log-file=' + assertProjectOutput(path.join(base, 'results', tag + '-browser.log')),
        '--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]});
    const page = browser.pages()[0] || await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (process.argv.includes('--gc')) {
      report.forcedGC = 0;
      const session = await browser.newCDPSession(page);
      let pending = false;
      gcTimer = setInterval(async () => {
        if (pending) return;
        pending = true;
        try {await session.send('HeapProfiler.collectGarbage'); ++report.forcedGC;}
        catch (error) {report.gcError = error.message;}
        finally {pending = false;}
      }, 1000);
    }
    await page.goto('http://127.0.0.1:8765/build/' + suite + '/comparison.html#' + initialMode);
    const ready = async mode => {
      await page.waitForFunction(mode => __villaGitHistory.error ||
        __villaGitHistory.mode === mode && __villaGitHistory.ready, mode, {timeout: 120000});
      const error = await page.evaluate(() => __villaGitHistory.error);
      if (error) report.failure = await page.evaluate(() => {
        const scene = document.querySelector('iframe')?.contentWindow;
        return {error: __villaGitHistory.error, prewarm: scene?.__webPipelinePrewarm,
          log: scene?.__webEngineLog?.slice(-12),
          pso: scene?.__webPSOPrecache, rhi: scene?.__webOptimizationRHI};
      });
      assert.equal(error, null);
      assert.equal(await page.locator('iframe').count(), 1, 'Only one engine may run at a time');
    };
    const state = () => page.evaluate(() => {
      const scene = document.querySelector('iframe').contentWindow;
      return {player: scene.__webPlayerView, camera: scene.__webDefaultCamera,
        view: scene.__webRenderView, pso: scene.__webPSOPrecache, rhi: scene.__webOptimizationRHI,
        prewarm: scene.__webPipelinePrewarm, settings: scene.__webProjectSettings};
    });
    await ready(initialMode); report.initial = await state();
    assert.equal(report.initial.rhi.asyncPrecacheFailed, 0);
    assert.equal(report.initial.pso.active, 0);
    assert.equal(report.initial.rhi.asyncPrecacheRequested, report.initial.rhi.asyncPrecacheCompleted);
    assert.equal(report.initial.prewarm.counts.ready, 311);
    assert.deepEqual([report.initial.view.width, report.initial.view.height,
      report.initial.view.outputWidth, report.initial.view.outputHeight], [1400, 788, 1920, 1080]);
    for (const key of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
      assert.equal(report.initial.settings[key], 1);
    await page.locator('#record').click();
    const canvas = page.frameLocator('iframe').locator('#canvas'), box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    let moved, distance = 0;
    for (const key of ['w', 's', 'a', 'd']) {
      try {await page.keyboard.down(key); await page.waitForTimeout(700);}
      finally {await page.keyboard.up(key);}
      await page.waitForTimeout(200); moved = await state();
      distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - report.initial.camera[axis]));
      if (distance > 10) break;
    }
    assert(distance > 10, 'Native keyboard input must move the visible camera');
    try {
      await page.mouse.down({button: 'right'});
      for (let step = 1; step <= 16; ++step) {
        await page.mouse.move(box.x + box.width * (.5 + step * .008), box.y + box.height * .5);
        await page.waitForTimeout(30);
      }
    } finally {await page.mouse.up({button: 'right'});}
    await page.waitForTimeout(400); report.afterInput = await state();
    const yaw = Math.abs((report.afterInput.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
    assert(yaw > 5, 'Native mouse input must turn the visible camera');
    Object.assign(report, {distance, yaw});
    await page.locator('#record').click();
    await page.locator('#save-capture').click();
    await page.waitForFunction(() => document.getElementById('capture-file').hasAttribute('href'));
    report.exportURL = await page.locator('#capture-file').getAttribute('href');
    const exported = await (await page.request.get(new URL(report.exportURL, page.url()).href)).json();
    assert.equal(exported.kind, 'villa-manual-turn');
    assert.equal(exported.records[0].metadata.mode, initialMode);
    assert.equal(exported.records[0].metadata.arguments.includes('-WebPSOPrecacheTest'), !!variants[initialMode].automatic);
    assert(exported.records[0].frames.length > 1 && exported.records[0].contexts.length > 1);
    const beforeSwitch = await state();
    await page.locator('[name=mode][value=overlap]').check();
    await ready('overlap'); report.afterSwitch = await state();
    for (const axis of ['x', 'y', 'z', 'controlPitch', 'controlYaw'])
      assert(Math.abs(report.afterSwitch.player[axis] - beforeSwitch.player[axis]) < .1,
        'Player pose must survive a mode switch: ' + axis);
    assert.equal(report.afterSwitch.pso.enabled, false);
    await page.waitForFunction(() => __villaGitHistory.observations.overlap?.startupObserved);
    const firstTiming = await page.locator('#startup-ms').textContent();
    await page.waitForTimeout(1000);
    assert.equal(await page.locator('#startup-ms').textContent(), firstTiming, 'Startup timing must freeze');
    report.layouts = [];
    for (const viewport of [{width: 1600, height: 1000}, {width: 900, height: 700}]) {
      await page.setViewportSize(viewport); await page.waitForTimeout(500);
      const geometry = await page.evaluate(() => ({width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        stageHeight: document.getElementById('stage').getBoundingClientRect().height}));
      assert.equal(geometry.width, geometry.scrollWidth); assert(geometry.stageHeight > 300);
      const image = await canvas.screenshot(), pixels = (await sharp(image).stats()).channels.slice(0, 3);
      assert(pixels.every(channel => channel.mean > 3 && channel.stdev > 5), 'Scene canvas must contain rendered content');
      await page.screenshot({path: assertProjectOutput(path.join(base, 'results', tag + '-' + viewport.width + '.png'))});
      report.layouts.push({viewport, geometry, pixels});
    }
    assert.deepEqual(errors, []); report.pass = true;
    console.log(JSON.stringify({pass: true, distance, yaw, exportURL: report.exportURL, layouts: report.layouts.length}));
  } catch (error) {
    report.error = error.stack;
    throw error;
  } finally {
    clearInterval(gcTimer);
    await browser?.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
