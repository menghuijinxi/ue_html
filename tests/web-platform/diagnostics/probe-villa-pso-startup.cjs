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
const modes = (option('modes') || Object.keys(suite.variants).join(',')).split(',');
assert(modes.every(mode => suite.variants[mode]));
const routeFile = option('route');
const route = routeFile ? JSON.parse(fs.readFileSync(path.resolve(routeFile))) : null;
const contexts = route?.records?.[0]?.contexts;
assert(!route || contexts?.length, 'The route must contain exported manual camera contexts');
const routeStep = Number(option('route-step') || 15);
assert(Number.isInteger(routeStep) && routeStep > 0);
const routePoses = contexts && contexts.filter((_, index) => index % routeStep === 0 || index === contexts.length - 1)
  .map(context => context.camera);
const output = assertProjectOutput(path.join(base, 'results', tag + '.json'));
assert(!fs.existsSync(output), 'Preserve prior results');
const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/villa-pso-startup-20261113'));
const report = {date: new Date().toISOString(), suite: audit(path.join(base, 'build', suiteName, 'suite.json')),
  modes, routeStep, routePoseCount: routePoses?.length || 0, runs: [], pass: false,
  boundary: 'Functional startup and first-use coverage diagnostic. Sparse pipeline API hooks only; no FPS ranking, per-draw hooks, tracing, quality overrides or pre-tour camera warmup. Browser/driver caches retained; the first content download is reported separately.'};
function observe() {
  const result = globalThis.__psoStartupCheck = {calls: [], pending: 0, errors: [], collectors: []};
  const post = globalThis.postMessage.bind(globalThis);
  globalThis.postMessage = function(message, ...args) {
    if (message.type === 'log' && message.text?.includes('WEB_GLOBAL_PSO:'))
      result.collectors.push(message.text);
    return post(message, ...args);
  };
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
      if (descriptor.vertex) call.state = {primitive: descriptor.primitive, depthStencil: descriptor.depthStencil,
        multisample: descriptor.multisample, targets: descriptor.fragment?.targets, buffers: descriptor.vertex.buffers};
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
async function failureSnapshot(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Failure snapshot timed out')), 5000);
    })]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
(async () => {
  try {
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--enable-logging', '--log-file=' + assertProjectOutput(path.join(base, 'results', tag + '-browser.log')),
        '--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]});
    await browser.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + observe.toString() + ')();\n' + await response.text()});
    });
    report.restoredPages = browser.pages().map(page => page.url());
    for (const restored of browser.pages()) await restored.close();
    const page = await browser.newPage();
    let active;
    page.on('pageerror', error => active?.errors.push(error.message));
    browser.on('request', request => {
      if (request.url().includes('/pipeline-prewarm.json')) active?.recordedRequests.push(request.url());
    });
    page.on('console', message => {
      if (message.text().includes('WEB_GLOBAL_PSO:')) active?.collectorLog.push(message.text());
      if (active) {
        active.logs ||= [];
        active.logs.push(message.text().slice(0, 2000));
        if (active.logs.length > 100) active.logs.shift();
      }
    });
    for (const mode of modes) {
      active = {mode, errors: [], recordedRequests: [], collectorLog: [],
        pass: false, package: suite.variants[mode].files};
      const captureFree = !!suite.variants[mode].captureFree;
      report.runs.push(active);
      console.log(JSON.stringify({mode, stage: 'starting'}));
      try {
        await page.goto('http://127.0.0.1:8765/build/' + suite.variants[mode].folder + '/index.html');
        await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webPSOPrecacheReady &&
          __webEngineFrames >= 60 && document.getElementById('loading')?.hidden, null, {timeout: 180000});
        active.startup = await page.evaluate(() => ({ms: performance.now(), failure: globalThis.__webEngineFailure,
          prewarm: globalThis.__webPipelinePrewarm, pso: globalThis.__webPSOPrecache, rhi: globalThis.__webOptimizationRHI,
          view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings, camera: globalThis.__webDefaultCamera}));
        assert.equal(browser.pages().length, 1, 'Restored engine tabs must not compete with the measured scene');
        assert(!active.startup.failure, JSON.stringify(active.startup.failure));
        const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
        assert(owner);
        active.before = await owner.evaluate(() => ({capture: structuredClone(__psoStartupCheck), io: __webContentIO.stats,
          gpuLifetime: {sameGPU: navigator.gpu === globalThis.__webGPUKeepAlive?.gpu,
            adapters: globalThis.__webGPUKeepAlive?.adapters.length}}));
        if (captureFree) {
          assert(!fs.existsSync(path.join(base, 'build', suite.variants[mode].folder, 'pipeline-prewarm.json')));
          assert(!active.startup.prewarm?.adopted, 'Capture-free mode must not adopt a replay device');
          assert.deepEqual(active.recordedRequests, []);
        } else assert(active.startup.prewarm.ready && active.startup.prewarm.adopted);
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
            frames: __webEngineFrames, prewarm: globalThis.__webPipelinePrewarm, rhi: __webOptimizationRHI,
            failure: globalThis.__webEngineFailure})));
          assert(!active.turns.at(-1).failure);
        }
        active.after = await owner.evaluate(() => ({capture: __psoStartupCheck, io: __webContentIO.stats}));
        active.newCalls = active.after.capture.calls.slice(active.before.capture.calls.length);
        if (process.argv.includes('--expect-zero'))
          assert.deepEqual(active.newCalls, [], 'The first route visit must not create pipelines or shader modules');
        active.failedPipelines = active.after.capture.calls.filter(call => call.error);
        assert.deepEqual(active.after.capture.errors, []);
        assert.equal(active.after.capture.pending, 0);
        assert.deepEqual(active.errors, []);
        await page.screenshot({path: assertProjectOutput(path.join(base, 'results', tag + '-' + mode + '.png'))});
        active.pass = active.failedPipelines.length === 0;
        console.log(JSON.stringify({mode, pass: active.pass, startupMs: active.startup.ms,
          counts: active.startup.prewarm?.counts, automatic: active.startup.rhi.asyncPrecacheRequested,
          automaticFailed: active.startup.rhi.asyncPrecacheFailed, failed: active.failedPipelines.length,
          startupCalls: active.before.capture.calls.length, turnCalls: active.newCalls.map(call => ({name: call.name, label: call.label})),
          downloaded: active.before.io.downloadedBytes}));
      } catch (error) {
        active.errors.push(error.stack);
        active.failureState = await failureSnapshot(page.evaluate(() => ({
          failure: globalThis.__webEngineFailure, pso: globalThis.__webPSOPrecache,
          rhi: globalThis.__webOptimizationRHI, frames: globalThis.__webEngineFrames,
          log: globalThis.__webEngineLog?.slice(-20),
        })));
        const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
        if (owner) active.failedCapture = await failureSnapshot(owner.evaluate(() => __psoStartupCheck));
        console.error(JSON.stringify({mode, error: error.message}));
      } finally {
        fs.writeFileSync(output, JSON.stringify(report, null, 2));
        if (!page.isClosed()) await page.goto('about:blank').catch(() => {});
      }
    }
    report.pass = report.runs.every(run => run.pass);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await browser?.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
