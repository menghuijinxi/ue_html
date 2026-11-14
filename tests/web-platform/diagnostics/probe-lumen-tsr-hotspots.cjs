'use strict';
const {assertProjectOutputTree, initializeProjectOutput} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), {audit} = require('../content-file-metadata.cjs');
const transform = require('./lumen-tsr-hotspot-transforms.cjs');
const option = key => process.argv.find(a => a.startsWith('--' + key + '='))?.slice(key.length + 3);
const mode = Number(option('mode') || 0), tag = option('tag');
assert(Number.isInteger(mode) && mode >= 0 && mode <= 15 && /^[a-z0-9-]+$/.test(tag));
const base = path.resolve(__dirname, '..'), folder = option('folder') || 'villa-vsm-pages-final-20261112';
const tsrTiles = option('tsr-tiles');
const limitInvocations = option('limit-invocations') === undefined ? null : Number(option('limit-invocations'));
const limitX = option('limit-x') === undefined ? null : Number(option('limit-x'));
const limitStorage = option('limit-storage') === undefined ? null : Number(option('limit-storage'));
const maskedDevice = limitInvocations !== null || limitX !== null || limitStorage !== null;
assert(/^[a-z0-9-]+$/.test(folder));
assert(tsrTiles === undefined || ['0', '1'].includes(tsrTiles));
assert(limitInvocations === null || [256, 1024].includes(limitInvocations));
assert(limitX === null || [256, 1024].includes(limitX));
assert(limitStorage === null || [16384, 32768].includes(limitStorage));
const directory = assertProjectOutputTree(path.join(base, 'results', tag));
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const snapshot = path.join(directory, 'probe-source.cjs');
fs.copyFileSync(__filename, snapshot);
const report = {pass: false, date: new Date().toISOString(), folder, mode, tsrTiles, limitInvocations,
  limitX, limitStorage, errors: [], phases: [],
  source: audit(snapshot), transform: audit(path.join(__dirname, 'lumen-tsr-hotspot-transforms.cjs')),
  package: audit(path.join(base, 'build', folder, 'asset-versions.json')),
  boundary: 'Experimental WGSL transforms and optional TSR startup override in browser memory only. Masked tests alter the capability report consumed by RHI; the physical device retains its normal limits because other existing scene shaders require 1024 threads. They prove TSR selection only. GPU timing splits compute passes and is not an FPS comparison.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function install(mode, transform, observer, limits) {
  const actualLimits = Object.getOwnPropertyDescriptor(GPUDevice.prototype, 'limits').get;
  if (Object.keys(limits).length) {
    const views = new WeakMap();
    Object.defineProperty(GPUDevice.prototype, 'limits', {configurable: true, get() {
      if (!views.has(this)) views.set(this, new Proxy(actualLimits.call(this), {get(target, key) {
        return key in limits ? limits[key] : Reflect.get(target, key, target);
      }}));
      return views.get(this);
    }});
  }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    const device = await requestDevice.call(this, descriptor);
    const physical = actualLimits.call(device);
    globalThis.__hotspotDeviceLimits = {invocations: device.limits.maxComputeInvocationsPerWorkgroup,
      x: device.limits.maxComputeWorkgroupSizeX, sharedBytes: device.limits.maxComputeWorkgroupStorageSize,
      physical: {invocations: physical.maxComputeInvocationsPerWorkgroup,
        x: physical.maxComputeWorkgroupSizeX, sharedBytes: physical.maxComputeWorkgroupStorageSize}};
    return device;
  };
  const create = GPUDevice.prototype.createShaderModule, modules = new WeakMap();
  const catalog = globalThis.__hotspotCatalog = {}, facts = globalThis.__hotspotFacts = [];
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const result = transform(descriptor.code, mode, this.features.has('subgroups'));
    if (Object.values(result.facts).some(n => n > 0)) facts.push(result.facts);
    const module = create.call(this, {...descriptor, code: result.source});
    modules.set(module, result.source); return module;
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
    const createPipeline = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      const entry = descriptor.compute.entryPoint;
      catalog[entry] = modules.get(descriptor.compute.module);
      const result = createPipeline.call(this, descriptor);
      const label = pipeline => {pipeline.label = entry; return pipeline;};
      return result?.then ? result.then(label) : label(result);
    };
  }
  observer();
}
let context, log;
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/vsm-adaptive-production-20261112'));
    context = await chromium.launchPersistentContext(profile,
      {channel: 'msedge', headless: false, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    const observer = require('../web-performance-capture-observer.cjs');
    if (maskedDevice) await context.route('**/index.html', async route => {
      const response = await route.fetch(), body = await response.text();
      const match = body.match(/const localRuntimeAssets = (\{[^\n]+\});/); assert(match);
      const assets = JSON.parse(match[1]); delete assets.pipelinePrewarm;
      // Capability fallback is a diagnostic run; the recorded high-limit device is not replayed.
      await route.fulfill({response, body: body.replace(match[0],
        'const localRuntimeAssets = ' + JSON.stringify(assets) + ';')});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch(), marker = "        removeRunDependency('worker-content');";
      const source = await response.text(); assert.equal(source.split(marker).length, 2);
      const body = source.replace(marker, `
        const path = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(path, FS.readFile(path, {encoding:'utf8'})+
          ${JSON.stringify('\n[SystemSettings]\nr.WebGPU.ReuseComputePass=0\n' +
            (tsrTiles === undefined ? '' : 'r.WebGPU.TSRLargeTiles=' + tsrTiles + '\n'))});
${marker}`);
      const limits = {...(limitInvocations === null ? {} : {maxComputeInvocationsPerWorkgroup: limitInvocations}),
        ...(limitX === null ? {} : {maxComputeWorkgroupSizeX: limitX}),
        ...(limitStorage === null ? {} : {maxComputeWorkgroupStorageSize: limitStorage})};
      await route.fulfill({response, body: '(' + install.toString() + ')(' + mode + ',' + transform.toString() +
        ',' + observer.toString() + ',' + JSON.stringify(limits) + ');\n' + body});
    });
    const page = await context.newPage();
    for (const previous of context.pages()) if (previous !== page) await previous.close();
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 90 && document.getElementById('loading')?.hidden, null, {timeout: 240000});
    const failure = await page.evaluate(() => globalThis.__webEngineFailure);
    assert(!failure, JSON.stringify(failure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    const state = () => owner.evaluate(() => ({frames: __webRHIFrames, settings: __webProjectSettings,
      view: __webRenderView, prewarm: globalThis.__webPipelinePrewarm, limits: __hotspotDeviceLimits,
      camera: __webDefaultCamera, failure: globalThis.__webEngineFailure}));
    const motion = (duration, mode = 2) => page.evaluate(({duration, mode}) =>
      __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
    for (const mode of [2, 1]) {
      const serial = await motion(15, mode);
      await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial && __webMotionBenchmark.completed,
        serial, {timeout: 45000});
    }
    for (const name of ['standing', 'turning']) {
      await motion(0); await page.waitForTimeout(2000);
      const phase = {name, before: await state(), gpuFrames: []}; report.phases.push(phase);
      if (name === 'turning') await motion(60);
      for (let i = 0; i < 8; ++i) {
        await page.waitForTimeout(1000);
        phase.gpuFrames.push(await owner.evaluate(() => __webCaptureGPUFrame()));
      }
      phase.after = await state(); assert(phase.after.frames > phase.before.frames);
      if (!maskedDevice) {
        assert(phase.after.prewarm.ready && phase.after.prewarm.adopted);
        assert.equal(phase.before.prewarm.counts.misses, phase.after.prewarm.counts.misses);
      } else {
        if (limitInvocations !== null) assert.equal(phase.after.limits.invocations, limitInvocations);
        if (limitX !== null) assert.equal(phase.after.limits.x, limitX);
        if (limitStorage !== null) assert.equal(phase.after.limits.sharedBytes, limitStorage);
        assert.equal(phase.after.prewarm, undefined);
      }
      assert(!phase.after.failure); assert.deepEqual(report.errors, []);
      if (name === 'standing') await page.screenshot({path: path.join(directory, 'standing.png')});
      save();
    }
    report.facts = await owner.evaluate(() => __hotspotFacts);
    report.gpuErrors = await owner.evaluate(() => __webPerformanceCapture.errors);
    assert.deepEqual(report.gpuErrors, []);
    const catalog = await owner.evaluate(() => __hotspotCatalog);
    fs.writeFileSync(path.join(directory, 'compute-shaders.json'), JSON.stringify(catalog));
    if (tsrTiles !== undefined) {
      const limits = report.phases[0].after.limits;
      const large = tsrTiles === '1' && limits.invocations >= 1024 && limits.x >= 1024 && limits.sharedBytes >= 16416;
      report.tsrDispatches = [...new Set(report.phases.flatMap(p => p.gpuFrames.flatMap(f =>
        f.entries.filter(e => catalog[e.pipeline]?.includes('WebTSRAnyThreadResult')).map(e => e.pipeline))))]
        .map(entry => ({entry, workgroup: catalog[entry].match(/@workgroup_size\(([^)]+)\)/)?.[1]}));
      assert(report.tsrDispatches.length > 0, 'The convolution shader must actually dispatch');
      assert(report.tsrDispatches.every(s => s.workgroup === (large ? '1024u, 1u, 1u' : '256u, 1u, 1u')),
        JSON.stringify(report.tsrDispatches));
    }
    assert.equal(audit(report.package.file).sha256, report.package.sha256);
    report.pass = true;
    console.log(JSON.stringify({pass: true, mode, facts: report.facts}));
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
