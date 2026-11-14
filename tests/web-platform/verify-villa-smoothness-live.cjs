'use strict';
const {initializeProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), sharp = require('sharp');
const {audit} = require('./content-file-metadata.cjs');
const tag = process.argv[2]; assert(tag && /^[a-z0-9-]+$/.test(tag));
const modes = (process.argv.find(arg => arg.startsWith('--modes='))?.slice(8) ||
  'off,plain,large,old,small,off').split(',');
assert(modes.length >= 2 && modes.every(mode => ['old', 'large', 'small', 'off', 'plain'].includes(mode)));
const directory = assertProjectOutputTree(path.join(__dirname, 'results', tag));
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const report = {date: new Date().toISOString(), pass: false, modes, errors: [], checks: [], states: [],
  source: audit(__filename), startupFailures: [],
  boundary: 'Functional verification of real player controls, preserved poses, shader dispatch, metrics and sizing. ' +
    'No performance claim; shader dispatch observation is diagnostic instrumentation.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function observeTiles() {
  const modules = new WeakMap(), pipelines = new WeakMap(), passes = new WeakMap();
  const counts = globalThis.__smoothnessTSRGroups = {};
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const result = createModule.call(this, descriptor); modules.set(result, descriptor.code); return result;
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      const entry = descriptor.compute.entryPoint, source = modules.get(descriptor.compute.module);
      const result = original.call(this, descriptor);
      const record = pipeline => {
        if (/^main_000146(bc|cc)_/.test(entry)) {
          assertSource(source);
          pipelines.set(pipeline, {entry, size: Number(source.match(/@workgroup_size\((\d+)/)[1])});
        }
        return pipeline;
      };
      return result?.then ? result.then(record) : record(result);
    };
  }
  function assertSource(source) {
    if (!source?.match(/@workgroup_size\((256|1024)u?(?:,|\))/)) throw Error('Unknown TSR convolution workgroup');
  }
  const set = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    passes.set(this, pipelines.get(pipeline)); return set.call(this, pipeline);
  };
  for (const name of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    const original = GPUComputePassEncoder.prototype[name];
    GPUComputePassEncoder.prototype[name] = function(...args) {
      const selected = passes.get(this);
      if (selected) counts[selected.size] = (counts[selected.size] || 0) + 1;
      return original.apply(this, args);
    };
  }
}
let context, log;
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(__dirname, 'build/browser-profiles/villa-regression-20261112'));
    context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + observeTiles.toString() + ')();\n' + await response.text()});
    });
    const page = context.pages()[0] || await context.newPage();
    for (const other of context.pages()) if (other !== page) await other.close();
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    const snapshot = () => page.evaluate(() => {
      const child = document.querySelector('iframe').contentWindow;
      return {page: __villaSmoothnessLive, camera: child.__webDefaultCamera, player: child.__webPlayerView,
        view: child.__webRenderView, settings: child.__webProjectSettings, prewarm: child.__webPipelinePrewarm,
        rhi: child.__webOcclusionRHI, canvas: [child.document.getElementById('canvas').width,
          child.document.getElementById('canvas').height]};
    });
    const ready = async mode => {
      for (let attempt = 0; ; ++attempt) {
        await page.waitForFunction(mode => globalThis.__villaSmoothnessLive?.error ||
          __villaSmoothnessLive?.ready && !__villaSmoothnessLive.busy && __villaSmoothnessLive.mode === mode,
        mode, {timeout: 240000});
        const state = await snapshot();
        if (/external Instance reference|E_OUTOFMEMORY/.test(state.page.error || '') && attempt < 2) {
          report.startupFailures.push({mode, error: state.page.error}); save();
          await page.locator('#retry').click(); continue;
        }
        assert(!state.page.error, state.page.error); assert(state.player.active);
        assert(state.prewarm.ready && state.prewarm.adopted);
        assert.deepEqual([state.view.width, state.view.height, state.view.outputWidth,
          state.view.outputHeight, state.view.antiAliasing, ...state.canvas], [1400, 788, 1920, 1080, 4, 1920, 1080]);
        assert.equal(await page.locator('iframe').count(), 1);
        assert.equal(page.workers().filter(worker => worker.url().includes('/web-engine-worker.js?')).length, 1);
        if (mode !== 'old') {
          const owner = page.workers().find(worker => worker.url().includes('/web-engine-worker.js?'));
          const groups = await owner.evaluate(() => __smoothnessTSRGroups);
          const expected = mode === 'large' ? 1024 : 256;
          assert(Object.keys(groups).length && groups[expected] > 0);
          assert(!groups[expected === 256 ? 1024 : 256], 'Only the selected TSR tile may be dispatched');
          state.tsrGroups = groups;
          if (['off', 'plain'].includes(mode)) {
            assert.equal(state.rhi.indirectDrawReuse, 0);
            assert.equal(state.rhi.vsmPageOptimization, 0);
            state.isolation = await owner.evaluate(() => __villaOptimizationIsolation);
            assert.equal(state.isolation.mode, mode); assert(state.isolation.diagnosticOnly);
            if (mode === 'plain') assert.equal(state.rhi.reuseComputePass, false);
          }
        }
        report.states.push(state); save(); console.log(JSON.stringify({mode, ready: true, groups: state.tsrGroups}));
        return state;
      }
    };
    const input = async mode => {
      await page.locator('#viewpoint').selectOption('interior');
      await page.waitForFunction(() => !__villaSmoothnessLive.busy);
      await page.waitForTimeout(1000);
      const canvas = page.frameLocator('iframe').locator('#canvas'), box = await canvas.boundingBox();
      await canvas.click(); const before = await snapshot();
      let distance = 0, moved;
      for (const key of ['w', 's', 'a', 'd']) {
        try {await page.keyboard.down(key); await page.waitForTimeout(700);}
        finally {await page.keyboard.up(key);}
        await page.waitForTimeout(300); moved = await snapshot();
        distance = Math.hypot(...['x', 'y', 'z'].map(axis => moved.camera[axis] - before.camera[axis]));
        if (distance > 10) break;
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
      report.checks.push({mode, distance, yaw}); save();
      assert(distance > 10 && yaw > 5, 'Real keyboard and mouse must move the visible player camera');
    };
    const preserved = (a, b) => {
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw'])
        assert(Math.abs(a.camera[key] - b.camera[key]) < .1, 'Switch changed camera ' + key);
      for (const key of ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'controlPitch', 'controlYaw', 'controlRoll'])
        assert(Math.abs(a.player[key] - b.player[key]) < .1, 'Switch changed player ' + key);
    };
    const layout = async name => {
      const bounds = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
        nodes: [...document.querySelectorAll('h1,.modes,button,select,.metrics,iframe')].filter(node =>
          !node.hidden && node.getBoundingClientRect().height).map(node => ({id: node.id || node.tagName,
          left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
          width: node.clientWidth, scroll: node.scrollWidth}))}));
      assert(bounds.scroll <= bounds.width + 1);
      for (const node of bounds.nodes) {
        assert(node.left >= -1 && node.right <= bounds.width + 1, 'Outside viewport: ' + node.id);
        assert(node.scroll <= node.width + 1, 'Text overflow: ' + node.id);
      }
      const box = await page.locator('iframe').boundingBox();
      const pixels = await page.screenshot({clip: {x: box.x + box.width * .55, y: box.y + box.height * .4,
        width: box.width * .3, height: box.height * .2}});
      assert((await sharp(pixels).stats()).channels.slice(0, 3).every(channel => channel.mean > 3 && channel.stdev > 5));
      await page.screenshot({path: path.join(directory, name + '.png')});
      report.checks.push({name, bounds}); save();
    };
    await page.goto('http://127.0.0.1:8765/villa-smoothness-live.html#' + modes[0]);
    const spawn = await ready(modes[0]);
    await input(modes[0]);
    await page.locator('#viewpoint').selectOption('kitchen');
    await page.waitForFunction(() => !__villaSmoothnessLive.busy);
    await page.waitForTimeout(1000); await layout('desktop-small');
    for (const mode of modes.slice(1)) {
      const held = await snapshot();
      await page.locator('.modes label').filter({has: page.locator('[value=' + mode + ']')}).click();
      preserved(held, await ready(mode)); await input(mode);
    }
    const last = modes.at(-1);
    await page.waitForFunction(mode => Number.isFinite(__villaSmoothnessLive.observations[mode].metrics?.low) &&
      Number.isFinite(__villaSmoothnessLive.observations[mode].metrics?.p99Ms), last, {timeout: 20000});
    assert.match(await page.locator('#p99').textContent(), /^\d+\.\d ms$/);
    assert.match(await page.locator('#long-frames').textContent(), /^\d+$/);
    await page.setViewportSize({width: 390, height: 844}); await page.waitForTimeout(1200);
    await ready(last); await layout('mobile-isolation');
    const download = page.waitForEvent('download'); await page.locator('#export').click();
    await (await download).saveAs(path.join(directory, 'ui-export.json'));
    const exported = JSON.parse(fs.readFileSync(path.join(directory, 'ui-export.json')));
    assert(modes.every(mode => exported.observations[mode]));
    await page.setViewportSize({width: 1600, height: 1000});
    await page.locator('#reset').click(); await page.waitForFunction(() => !__villaSmoothnessLive.busy);
    await page.waitForTimeout(600); preserved(spawn, await snapshot());
    await layout('desktop-reset');
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
