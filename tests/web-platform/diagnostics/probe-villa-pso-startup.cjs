'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('../content-file-metadata.cjs');
const base = path.resolve(__dirname, '..');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const suiteName = option('suite') || 'villa-pso-startup-20261113', tag = option('tag');
assert(tag && [suiteName, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const suite = JSON.parse(fs.readFileSync(path.join(base, 'build', suiteName, 'suite.json')));
const modes = (option('modes') || 'recorded,overlap,components,automatic').split(',');
assert(modes.every(mode => suite.variants[mode]));
const routeFile = option('route');
const route = routeFile ? JSON.parse(fs.readFileSync(path.resolve(routeFile))) : null;
const contexts = route?.records?.[0]?.contexts;
assert(!route || contexts?.length, 'The route must contain exported manual camera contexts');
const routePoses = contexts && contexts.filter((_, index) => index % 15 === 0 || index === contexts.length - 1)
  .map(context => context.camera);
const output = assertProjectOutput(path.join(base, 'results', tag + '.json'));
assert(!fs.existsSync(output), 'Preserve prior results');
const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/villa-pso-startup-20261113'));
const report = {date: new Date().toISOString(), suite: audit(path.join(base, 'build', suiteName, 'suite.json')),
  modes, runs: [], pass: false,
  boundary: 'Functional startup and first-use coverage diagnostic. Sparse pipeline API hooks only; no FPS ranking, per-draw hooks, tracing, quality overrides or pre-tour camera warmup. Browser/driver caches retained; the first content download is reported separately.'};
function observe() {
  const result = globalThis.__psoStartupCheck = {calls: [], pending: 0, errors: []};
  const originalRequest = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await originalRequest.apply(this, args);
    device.addEventListener('uncapturederror', event => result.errors.push(event.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') result.errors.push('Device lost: ' + info.message);});
    return device;
  };
  for (const name of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline',
    'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      const call = {name, start: performance.now(), label: descriptor.label ||
        [descriptor.vertex?.entryPoint, descriptor.fragment?.entryPoint, descriptor.compute?.entryPoint].filter(Boolean).join(' / ')};
      result.calls.push(call);
      try {
        const created = original.call(this, descriptor);
        if (name.endsWith('Async')) {
          ++result.pending;
          created.then(() => {--result.pending; call.completed = performance.now();},
            error => {--result.pending; call.error = error.message;});
        }
        return created;
      } catch (error) {call.error = error.message; throw error;}
    };
  }
}
let browser;
(async () => {
  try {
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]});
    await browser.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + observe.toString() + ')();\n' + await response.text()});
    });
    const page = browser.pages()[0] || await browser.newPage();
    let active;
    page.on('pageerror', error => active?.errors.push(error.message));
    for (const mode of modes) {
      active = {mode, errors: [], pass: false, package: suite.variants[mode].files};
      report.runs.push(active);
      console.log(JSON.stringify({mode, stage: 'starting'}));
      try {
        await page.goto('http://127.0.0.1:8765/build/' + suite.variants[mode].folder + '/index.html');
        await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webPSOPrecacheReady &&
          __webEngineFrames >= 60 && document.getElementById('loading')?.hidden, null, {timeout: 180000});
        active.startup = await page.evaluate(() => ({ms: performance.now(), failure: globalThis.__webEngineFailure,
          prewarm: globalThis.__webPipelinePrewarm, pso: globalThis.__webPSOPrecache, rhi: globalThis.__webOptimizationRHI,
          view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings, camera: globalThis.__webDefaultCamera}));
        assert(!active.startup.failure, JSON.stringify(active.startup.failure));
        const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
        assert(owner);
        active.before = await owner.evaluate(() => ({capture: structuredClone(__psoStartupCheck), io: __webContentIO.stats}));
        assert(active.startup.prewarm.ready && active.startup.prewarm.adopted);
        assert.equal(!!active.startup.pso.enabled, !!suite.variants[mode].automatic);
        assert.equal(active.startup.view.width, 1400); assert.equal(active.startup.view.height, 788);
        assert.equal(active.startup.view.outputWidth, 1920); assert.equal(active.startup.view.outputHeight, 1080);
        for (const name of ['virtualShadows', 'gi', 'reflections', 'virtualTextures'])
          assert.equal(active.startup.settings[name], 1, name);
        active.turns = [];
        active.route = routeFile ? {source: audit(path.resolve(routeFile)), samples: routePoses.length} : 'spawn-yaw';
        const poses = routePoses || [90, 180, 270, 0].map(offset =>
          ({...active.startup.camera, yaw: active.startup.camera.yaw + offset}));
        for (const pose of poses) {
          assert.equal(await page.evaluate(pose => __webEngineRPC('WebProjectViewTest',
            pose.x, pose.y, pose.z, pose.pitch, pose.yaw), pose), 1);
          const before = await page.evaluate(() => __webEngineFrames);
          await page.waitForFunction(frame => globalThis.__webEngineFailure || __webEngineFrames >= frame + 30,
            before, {timeout: 30000});
          active.turns.push(await page.evaluate(() => ({camera: __webDefaultCamera,
            frames: __webEngineFrames, prewarm: __webPipelinePrewarm, rhi: __webOptimizationRHI,
            failure: globalThis.__webEngineFailure})));
          assert(!active.turns.at(-1).failure);
        }
        active.after = await owner.evaluate(() => ({capture: __psoStartupCheck, io: __webContentIO.stats}));
        active.newCalls = active.after.capture.calls.slice(active.before.capture.calls.length);
        active.failedPipelines = active.after.capture.calls.filter(call => call.error);
        assert.deepEqual(active.after.capture.errors, []);
        assert.equal(active.after.capture.pending, 0);
        assert.deepEqual(active.errors, []);
        await page.screenshot({path: assertProjectOutput(path.join(base, 'results', tag + '-' + mode + '.png'))});
        active.pass = active.failedPipelines.length === 0;
        console.log(JSON.stringify({mode, pass: active.pass, startupMs: active.startup.ms,
          counts: active.startup.prewarm.counts, automatic: active.startup.rhi.asyncPrecacheRequested,
          automaticFailed: active.startup.rhi.asyncPrecacheFailed, failed: active.failedPipelines.length,
          startupCalls: active.before.capture.calls.length, turnCalls: active.newCalls.map(call => ({name: call.name, label: call.label})),
          downloaded: active.before.io.downloadedBytes}));
      } catch (error) {
        active.errors.push(error.stack);
        console.error(JSON.stringify({mode, error: error.message}));
      } finally {
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        await page.goto('about:blank');
      }
    }
    report.pass = report.runs.every(run => run.pass);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser?.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
