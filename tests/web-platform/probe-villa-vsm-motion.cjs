'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder') || 'villa-lumen-vt-20261110-v6', tag = option('tag');
const gpu = process.argv.includes('--gpu'), cpu = process.argv.includes('--cpu');
const seconds = Number(option('seconds') || 15), warmup = Number(option('warmup') || 15);
assert([folder, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(seconds >= 5 && seconds <= 60 && warmup >= 0 && warmup <= 120);
const directory = path.join(__dirname, 'results', 'vsm-motion-' + tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const report = {date: new Date().toISOString(), pass: false, folder, gpu, cpu, seconds, warmup,
  source: audit(__filename), package: audit(path.join(__dirname, 'build', folder, 'asset-versions.json')),
  errors: [], phases: [], qualityOverrides: [],
  boundary: 'Same package and resolution; scripted game-frame camera rotation. Submission intervals are not display timings. GPU/CPU profiling runs are diagnostic, not baseline performance.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function install() {
  const capture = globalThis.__vsmMotion = {active: false, times: [], creations: []};
  let frame = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => frame, set(value) {
      if (capture.active && value > frame) capture.times.push(performance.now());
      frame = value;
    }});
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createShaderModule']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(...args) {
      const start = performance.now();
      try {return original.apply(this, args);}
      finally {
        if (capture.active) capture.creations.push({name, label: args[0]?.label,
          milliseconds: performance.now() - start});
      }
    };
  }
}
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/vsm-motion-' + tag), {
      channel: 'msedge', headless: false, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    const observer = gpu ? require('./web-performance-capture-observer.cjs') : install;
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + observer.toString() + ')();\n' + await response.text()});
    });
    const page = context.pages()[0];
    log = fs.createWriteStream(path.join(directory, 'page.log'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= 30 && __webPSOPrecacheReady &&
      document.getElementById('loading')?.hidden, null, {timeout: 120000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    const state = () => owner.evaluate(() => ({
      frames: __webRHIFrames, camera: __webDefaultCamera, view: __webRenderView,
      settings: __webProjectSettings, stages: __webThreadStages,
      streaming: __webTextureStreaming, optimization: __webOptimizationRHI,
      prewarm: __webPipelinePrewarm, occlusion: __webOcclusionRHI,
      motion: globalThis.__webMotionBenchmark, failure: globalThis.__webEngineFailure
    }));
    const route = (duration, mode = 2) => page.evaluate(({duration, mode}) =>
      __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
    assert(await route(0) > 0);
    await page.waitForTimeout(warmup * 1000);
    report.initial = await state();
    for (const name of ['standing', 'turning-first', 'standing-after-turn', 'turning-warm',
      'moving-first', 'moving-warm']) {
      const turning = name.startsWith('turning'), moving = name.startsWith('moving');
      const mode = moving ? 1 : 2;
      assert(await route(0, mode) > 0); await page.waitForTimeout(1000);
      const phase = {name, before: await state(), samples: [], gpuFrames: []};
      report.phases.push(phase); save();
      await owner.evaluate(gpu => {
        if (gpu) __webStartPerformanceCapture();
        else Object.assign(__vsmMotion, {active: true, times: [], creations: []});
      }, gpu);
      const started = Date.now();
      const serial = turning || moving ? await route(seconds, mode) : 0;
      let cpuCapture;
      if (cpu) cpuCapture = require('./web-worker-cpu-profiler.cjs')(context,
        path.join(directory, name), Math.min(seconds, 8));
      for (let second = 0; second < seconds; ++second) {
        await page.waitForTimeout(1000);
        phase.samples.push({ms: Date.now() - started, ...await state()});
        assert(!phase.samples.at(-1).failure && !report.errors.length, JSON.stringify(report.errors));
        if (gpu && [2, 5, 8].includes(second))
          phase.gpuFrames.push(await owner.evaluate(() => __webCaptureGPUFrame()));
      }
      phase.milliseconds = Date.now() - started;
      if (cpuCapture) phase.cpuProfiles = await cpuCapture;
      phase.after = await state();
      phase.capture = await owner.evaluate(gpu => {
        if (gpu) {
          // Detailed pass lists are already retained for the selected GPU frames.
          // Sending every CPU pass through CDP can exhaust the browser during export.
          const {frames, calls, apiMs, errors, adapter} = __webStopPerformanceCapture();
          return {frames, calls, apiMs, errors, adapter};
        }
        __vsmMotion.active = false; return __vsmMotion;
      }, gpu);
      const times = gpu ? phase.capture.frames.map(frame => frame.time) : phase.capture.times;
      const intervals = times.slice(1).map((time, index) => time - times[index]);
      assert(intervals.length > 5, 'Require actual frame progress');
      const sorted = [...intervals].sort((a, b) => a - b), worst = sorted.slice(-Math.max(1, Math.ceil(sorted.length * .01)));
      const frames = phase.after.frames - phase.before.frames;
      phase.summary = {fps: frames * 1000 / phase.milliseconds, frames,
        p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
        maxMs: sorted.at(-1), low1Fps: 1000 * worst.length / worst.reduce((sum, value) => sum + value, 0),
        rhiWorkMs: (phase.after.stages.rhiWorkMilliseconds - phase.before.stages.rhiWorkMilliseconds) / frames,
        prewarmMisses: phase.after.prewarm.counts.misses - phase.before.prewarm.counts.misses,
        creations: phase.capture.creations?.length};
      assert.deepEqual(phase.before.settings, phase.after.settings);
      for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
        assert.equal(phase.before.view[key], phase.after.view[key], key);
      if (turning || moving) {
        assert.equal(phase.after.motion.serial, serial);
        // Motion telemetry is published periodically; wait outside the timing window.
        for (let attempt = 0; attempt < 50 && !(await state()).motion.completed; ++attempt)
          await page.waitForTimeout(100);
        phase.completedMotion = (await state()).motion;
        assert(phase.completedMotion.completed && phase.completedMotion.serial === serial, 'Camera route must finish');
        let degrees = 0, distance = 0;
        for (let index = 1; index < phase.samples.length; ++index)
        {
          degrees += Math.abs(((phase.samples[index].camera.yaw - phase.samples[index - 1].camera.yaw + 540) % 360) - 180);
          const a = phase.samples[index - 1].camera, b = phase.samples[index].camera;
          distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        }
        if (turning) {
          phase.summary.turnDegrees = degrees;
          assert(degrees > 200, 'Camera must rotate continuously');
        } else {
          phase.summary.travelCentimeters = distance;
          assert(distance > 600, 'Camera must move continuously');
        }
      }
      save(); console.log(JSON.stringify({name, ...phase.summary}));
      await page.screenshot({path: path.join(directory, name + '.png')});
    }
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
