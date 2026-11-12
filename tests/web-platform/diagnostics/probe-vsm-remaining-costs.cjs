'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag'), kind = option('kind');
const pageMode = option('page-mode');
assert(pageMode === undefined || /^[0-3]$/.test(pageMode));
const profile = option('profile') || 'villa-shadow-page-20261111';
assert(/^[a-z0-9-]+$/.test(profile));
assert([folder, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(['gpu', 'cpu'].includes(kind));
const cpuPhase = option('phase') || 'turning';
assert(['standing', 'turning'].includes(cpuPhase));
const base = path.resolve(__dirname, '..'), directory = path.join(base, 'results', tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
process.env.TEMP = process.env.TMP = path.join(base, 'build/test-tmp');
const report = {date: new Date().toISOString(), pass: false, folder, kind, source: audit(__filename),
  package: audit(path.join(base, 'build', folder, 'asset-versions.json')), errors: [], phases: [],
  overrides: {...(kind === 'gpu' ? {'r.WebGPU.ReuseComputePass': 0} : {}),
    ...(pageMode === undefined ? {} : {'r.WebGPU.VSMPageOptimization': Number(pageMode)})},
  boundary: 'Diagnostic only, not an FPS benchmark. GPU mode splits compute dispatches for attribution; pass/driver overhead changes. CPU mode preserves packaged settings. No package files are modified.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function namePipelines() {
  const modules = new WeakMap(), catalog = globalThis.__vsmShaderCatalog = {};
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    const module = createModule.call(this, descriptor);
    modules.set(module, descriptor.code); return module;
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync']) {
    const create = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      const entry = descriptor.compute.entryPoint;
      catalog[entry] = modules.get(descriptor.compute.module);
      const result = create.call(this, descriptor);
      const label = pipeline => {pipeline.label = entry; return pipeline;};
      return result?.then ? result.then(label) : label(result);
    };
  }
}
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(base, 'build/browser-profiles',
      profile), {channel: 'msedge', headless: false,
      viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    report.browser = context.browser().version();
    if (kind === 'gpu') {
      const observer = require('../web-performance-capture-observer.cjs');
      report.observer = audit(path.join(base, 'web-performance-capture-observer.cjs'));
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        let body = await response.text();
        const marker = "        removeRunDependency('worker-content');";
        assert.equal(body.split(marker).length, 2);
        body = body.replace(marker, `
        const diagnosticsIni = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(diagnosticsIni, FS.readFile(diagnosticsIni, {encoding:'utf8'}) +
          '\\n[SystemSettings]\\nr.WebGPU.ReuseComputePass=0\\n${pageMode === undefined ? '' : 'r.WebGPU.VSMPageOptimization=' + pageMode + '\\n'}');
${marker}`);
        await route.fulfill({response, body: '(' + namePipelines.toString() + ')();\n(' +
          observer.toString() + ')();\n' + body});
      });
    }
    const page = await context.newPage();
    report.restoredPagesClosed = context.pages().length - 1;
    for (const previous of context.pages()) if (previous !== page) await previous.close();
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 60 && __webPSOPrecacheReady && document.getElementById('loading')?.hidden,
    null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
    const state = () => owner.evaluate(() => ({frames: __webRHIFrames, camera: __webDefaultCamera,
      view: __webRenderView, settings: __webProjectSettings, stages: __webThreadStages,
      occlusion: __webOcclusionRHI, streaming: __webTextureStreaming,
      prewarm: __webPipelinePrewarm, motion: globalThis.__webMotionBenchmark,
      failure: globalThis.__webEngineFailure}));
    const motion = (duration, mode = 2) => page.evaluate(({duration, mode}) =>
      __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
    for (const mode of [2, 1]) {
      const serial = await motion(15, mode); assert(serial > 0);
      await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
        __webMotionBenchmark.completed, serial, {timeout: 45000});
    }
    report.initial = await state();
    assert(report.initial.prewarm.ready && report.initial.prewarm.adopted);
    assert.equal(report.initial.occlusion.reuseComputePass, kind !== 'gpu');
    // Start a fresh browser for each CPU phase; repeated worker-profiler attachment can stall.
    for (const name of kind === 'cpu' ? [cpuPhase] : ['standing', 'turning']) {
      await motion(0); await page.waitForTimeout(2000);
      const phase = {name, before: await state(), gpuFrames: []};
      report.phases.push(phase); save();
      if (name === 'turning') {
        phase.motionSerial = await motion(60); assert(phase.motionSerial > 0);
        await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
          !__webMotionBenchmark.completed, phase.motionSerial, {timeout: 15000});
      }
      if (kind === 'cpu') {
        let timer;
        try {
          phase.profiles = await Promise.race([
            require('../web-worker-cpu-profiler.cjs')(context, path.join(directory, name), 8),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(Error('Worker CPU profiler exceeded 45 seconds')), 45000);
            })
          ]);
        } finally {clearTimeout(timer);}
        assert.equal(new Set(phase.profiles.map(p => p.target.parentFrameId)).size, 1,
          'CPU workers must belong to one scene page');
      } else {
        for (let sample = 0; sample < 6; ++sample) {
          await page.waitForTimeout(1000);
          phase.gpuFrames.push({state: await state(),
            capture: await owner.evaluate(() => __webCaptureGPUFrame())});
        }
      }
      phase.after = await state();
      assert(!phase.after.failure && !report.errors.length, JSON.stringify(report.errors));
      assert(phase.after.frames > phase.before.frames);
      assert.deepEqual(phase.before.settings, phase.after.settings);
      for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
        assert.equal(phase.before.view[key], phase.after.view[key], key);
      assert.equal(phase.after.prewarm.counts.misses, phase.before.prewarm.counts.misses);
      if (name === 'turning') {
        assert.equal(phase.after.motion.serial, phase.motionSerial);
        assert(!phase.after.motion.completed, 'Capture must finish inside the turning route');
      }
      save(); console.log(JSON.stringify({kind, name, frames: phase.after.frames - phase.before.frames,
        gpuSamples: phase.gpuFrames.length, cpuWorkers: phase.profiles?.length}));
    }
    if (kind === 'gpu') {
      report.gpuValidationErrors = await owner.evaluate(() => __webPerformanceCapture.errors);
      assert.equal(report.gpuValidationErrors.length, 0);
      report.adapter = await owner.evaluate(() => __webPerformanceCapture.adapter);
      report.capabilities = await owner.evaluate(() => ({
        indirectBundles: typeof GPURenderBundleEncoder.prototype.drawIndexedIndirect === 'function',
        multiDrawIndexedIndirect: typeof GPURenderPassEncoder.prototype.multiDrawIndexedIndirect === 'function'}));
      const catalog = await owner.evaluate(() => __vsmShaderCatalog);
      fs.writeFileSync(path.join(directory, 'compute-shaders.json'), JSON.stringify(catalog));
      report.catalog = audit(path.join(directory, 'compute-shaders.json'));
    }
    assert.equal(audit(report.package.file).sha256, report.package.sha256);
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
