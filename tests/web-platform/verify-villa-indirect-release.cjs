'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs'), {readPage} = require('./web-pipeline-prewarm-package.cjs');
const [folder, tag] = process.argv.slice(2);
assert([folder, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
const directory = path.join(__dirname, 'results', tag); assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
assert(readPage(path.join(__dirname, 'build', folder)).assets.pipelinePrewarm);
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), runs: [],
  package: audit(path.join(__dirname, 'build', folder, 'asset-versions.json'))};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
let context, log;
(async () => {
  try {
    process.env.TEMP = process.env.TMP = path.join(__dirname, 'build/test-tmp');
    for (const dpr of [1.5, 1]) {
      const run = {dpr, errors: [], states: []}; report.runs.push(run); save();
      context = await chromium.launchPersistentContext(path.join(__dirname,
        'build/browser-profiles/vsm-adaptive-production-20261112'), {channel: 'msedge', headless: false,
        viewport: {width: 1280, height: 800}, deviceScaleFactor: dpr,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
      const page = await context.newPage();
      for (const previous of context.pages()) if (previous !== page) await previous.close();
      log = fs.createWriteStream(path.join(directory, 'dpr-' + dpr + '.log'));
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
          run.errors.push(text);
      });
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90 &&
        document.getElementById('loading')?.hidden, null, {timeout: 240000});
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({frames: __webRHIFrames, view: __webRenderView,
        settings: __webProjectSettings, camera: __webDefaultCamera, rhi: __webOcclusionRHI,
        prewarm: __webPipelinePrewarm, sampling: __webVSMAdaptiveSampling,
        failure: globalThis.__webEngineFailure}));
      function check(value) {
        assert(!value.failure, value.failure); assert.deepEqual(run.errors, []);
        assert.equal(value.rhi.indirectDrawReuse, 2);
        assert(value.rhi.indirectTemplateHits > 0 && value.rhi.indirectBindingHits > 0);
        assert(value.prewarm.ready && value.prewarm.adopted && value.prewarm.counts.hits > 0);
        assert(value.sampling.enabled && value.sampling.supported);
        for (const key of ['gi', 'reflections', 'virtualTextures', 'virtualShadows']) assert.equal(value.settings[key], 1);
        assert(value.settings.virtualTexturePathActive && value.settings.virtualShadowPathActive);
        assert.deepEqual([value.view.width, value.view.height, value.view.outputWidth,
          value.view.outputHeight, value.view.antiAliasing], [1400, 788, 1920, 1080, 4]);
      }
      const initial = await state(); check(initial); run.states.push(initial);
      const box = await page.locator('#canvas').boundingBox();
      await page.mouse.click(box.x + box.width * .5, box.y + box.height * .5);
      const before = await state(); let moved, distance = 0;
      for (const key of ['w', 's', 'a', 'd']) {
        try {await page.keyboard.down(key); await page.waitForTimeout(900);}
        finally {await page.keyboard.up(key);}
        await page.waitForTimeout(300); moved = await state();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        if (distance > 10) break;
      }
      assert(distance > 10, 'Native keyboard input must move the visible camera');
      await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
      try {
        await page.mouse.down({button: 'right'});
        for (let step = 1; step <= 20; ++step) {
          await page.mouse.move(box.x + box.width * (.5 + step * .007), box.y + box.height * .5);
          await page.waitForTimeout(30);
        }
      } finally {await page.mouse.up({button: 'right'});}
      await page.waitForTimeout(500); const turned = await state(); check(turned); run.states.push(turned);
      const yaw = Math.abs((turned.camera.yaw - moved.camera.yaw + 540) % 360 - 180);
      assert(yaw > 5, 'Native mouse input must turn the visible camera'); Object.assign(run, {distance, yaw});
      for (const viewport of [{width: 900, height: 700}, {width: 1600, height: 1000}]) {
        await page.setViewportSize(viewport); await page.waitForTimeout(1500);
        const value = await state(); check(value); run.states.push(value);
        const canvas = await page.locator('#canvas').evaluate(canvas => [canvas.width, canvas.height]);
        assert.deepEqual(canvas, [1920, 1080]);
      }
      const final = await state(); check(final);
      assert(final.frames > initial.frames && final.rhi.indirectTemplateHits > initial.rhi.indirectTemplateHits);
      assert(final.rhi.indirectBindingHits > initial.rhi.indirectBindingHits);
      const pixels = await page.screenshot(); fs.writeFileSync(path.join(directory, 'dpr-' + dpr + '.png'), pixels);
      const channels = (await sharp(pixels).stats()).channels.slice(0, 3);
      assert(channels.every(value => value.mean > 3 && value.stdev > 5)); run.pixels = channels;
      run.states.push(final); run.pass = true; save();
      console.log(JSON.stringify({dpr, pass: true, distance, yaw,
        templates: final.rhi.indirectTemplateHits, bindings: final.rhi.indirectBindingHits}));
      log.end(); log = null; await context.close(); context = null;
    }
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
