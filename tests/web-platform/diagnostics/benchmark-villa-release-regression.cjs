'use strict';
const {initializeProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright'), {execFileSync} = require('node:child_process');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const base = path.resolve(__dirname, '..'), tag = option('tag');
const seconds = Number(option('seconds') || 15);
const variants = {
  old: {folder: 'villa-vsm-sampling-adaptive-20261112', url: 'vsm-adaptive-live.html#adaptive', settings: {}},
  latest: {folder: 'villa-tsr-tiles-20261112', settings: {}},
  small: {folder: 'villa-tsr-tiles-20261112', settings: {'r.WebGPU.TSRLargeTiles': 0}},
  pagesoff: {folder: 'villa-tsr-tiles-20261112', settings: {'r.WebGPU.VSMPageOptimization': 0}},
  indirectoff: {folder: 'villa-tsr-tiles-20261112', settings: {'r.WebGPU.IndirectDrawReuse': 0}},
  previous: {folder: 'villa-tsr-tiles-20261112', settings: {'r.WebGPU.TSRLargeTiles': 0,
    'r.WebGPU.VSMPageOptimization': 0, 'r.WebGPU.IndirectDrawReuse': 0}},
};
const order = (option('order') || 'old,latest,latest,old').split(',');
const phases = (option('phases') || 'standing,turning,input').split(',');
assert(tag && /^[a-z0-9-]+$/.test(tag));
assert(seconds >= 15 && seconds <= 60 && order.every(name => variants[name]));
assert(phases.length && phases.every(name => ['standing', 'turning', 'input'].includes(name)));
const directory = assertProjectOutputTree(path.join(base, 'results', tag));
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
fs.copyFileSync(__filename, path.join(directory, 'benchmark-source.cjs'));
const packages = Object.fromEntries([...new Set(order.map(name => variants[name].folder))].map(folder =>
  [folder, audit(path.join(base, 'build', folder, 'asset-versions.json'))]));
const report = {date: new Date().toISOString(), pass: false, order, seconds, phases, packages, runs: [],
  startupFailures: [], source: audit(path.join(directory, 'benchmark-source.cjs')),
  boundary: 'Sequential old live wrapper versus current release, fixed physical resolution and native input. ' +
    'RHI submission intervals and page rAF observations are not display scanout timestamps. ' +
    'Startup overrides are diagnostic only; immutable packages and recorded prewarm stay unchanged.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
const gpu = () => execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,pstate,clocks.gr',
  '--format=csv,noheader'], {encoding: 'utf8'}).trim();
function install() {
  const capture = globalThis.__releaseRegression = {active: false, times: [], completions: [], creations: []};
  let frames = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => frames, set(value) {
    if (capture.active && value > frames) capture.times.push(performance.now());
    frames = value;
  }});
  for (const name of ['createShaderModule', 'createComputePipeline', 'createRenderPipeline',
    'createComputePipelineAsync', 'createRenderPipelineAsync']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(...args) {
      if (capture.active) capture.creations.push(name);
      return original.apply(this, args);
    };
  }
}
function summary(times) {
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  assert(intervals.length > 100 && intervals.every(value => value > 0 && Number.isFinite(value)));
  const sorted = [...intervals].sort((a, b) => a - b), slow = sorted.slice(-Math.ceil(sorted.length * .01));
  return {frames: intervals.length, fps: 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0),
    low1: 1000 * slow.length / slow.reduce((a, b) => a + b, 0),
    p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)],
    max: sorted.at(-1), over33: intervals.filter(value => value > 33.34).length,
    over50: intervals.filter(value => value > 50).length};
}
let context, log, run;
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/villa-regression-20261112'));
    for (let index = 0; index < order.length; ++index) {
      const name = order[index], variant = variants[name];
      run = {name, index: index + 1, errors: [], phases: [], gpuBefore: gpu()};
      report.runs.push(run); save();
      context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
        viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
      report.browser = context.browser().version();
      const anchor = context.pages()[0] || await context.newPage();
      for (const page of context.pages()) if (page !== anchor) await page.close();
      await anchor.goto('about:blank');
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch(), marker = "        removeRunDependency('worker-content');";
        let body = await response.text();
        assert.equal(body.split(marker).length, 2);
        const completion = "    send('gpu-frame-complete');";
        assert.equal(body.split(completion).length, 2);
        body = body.replace(completion,
          "    if (__releaseRegression.active) __releaseRegression.completions.push(performance.now());\n" + completion);
        const settings = variants[run.name].settings;
        if (Object.keys(settings).length) {
          const ini = '\n[SystemSettings]\n' + Object.entries(settings).map(([k, v]) => k + '=' + v).join('\n') + '\n';
          body = body.replace(marker, `        const regressionIni='/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(regressionIni,FS.readFile(regressionIni,{encoding:'utf8'})+${JSON.stringify(ini)});
${marker}`);
        }
        await route.fulfill({response, body: '(' + install.toString() + ')();\n' + body});
      });
      const page = await context.newPage();
      log = fs.createWriteStream(path.join(directory, 'run-' + run.index + '-' + report.startupFailures.length + '.log'));
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
          run.errors.push(text);
      });
      console.log(JSON.stringify({name, run: run.index, stage: 'starting'}));
      await page.goto('http://127.0.0.1:8765/' + (variant.url || 'build/' + variant.folder + '/index.html'));
      const wrapper = !!variant.url;
      await page.waitForFunction(wrapper => {
        if (wrapper) return globalThis.__vsmAdaptiveLive?.error || globalThis.__vsmAdaptiveLive?.ready;
        return globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90 &&
          document.getElementById('loading')?.hidden;
      }, wrapper, {timeout: 240000});
      const scene = wrapper ? page.frames().find(frame => frame.url().includes('/build/')) : page.mainFrame();
      assert(scene);
      const failure = await scene.evaluate(() => globalThis.__webEngineFailure || null);
      if (failure && /external Instance reference|E_OUTOFMEMORY/.test(failure) && report.startupFailures.length < 3) {
        report.startupFailures.push({...run, failure, excluded: 'No measured window'});
        report.runs.pop(); save(); await context.close(); context = null;
        log.end(); log = null; --index; continue;
      }
      assert(!failure, failure);
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({frames: __webRHIFrames, view: __webRenderView,
        camera: __webDefaultCamera, player: globalThis.__webPlayerView, settings: __webProjectSettings,
        rhi: __webOcclusionRHI, prewarm: __webPipelinePrewarm, stages: __webThreadStages,
        sampling: globalThis.__webVSMAdaptiveSampling || globalThis.__webVSMAdaptiveProbe,
        scheduler: globalThis.__webFrameScheduler, failure: globalThis.__webEngineFailure}));
      const motion = (duration, mode) => scene.evaluate(({duration, mode}) =>
        __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
      const playerControl = async player => {
        const keys = ['x', 'y', 'z', 'pitch', 'yaw', 'roll', 'controlPitch', 'controlYaw', 'controlRoll'];
        const serial = await scene.evaluate(({player, keys}) =>
          __webEngineRPC('WebPlayerViewControl', player ? 1 : 0,
            ...keys.map(key => player ? player[key] : 0)), {player, keys});
        assert(serial > 0);
        await scene.waitForFunction(serial => globalThis.__webPlayerView?.serial === serial &&
          __webPlayerView.active, serial, {timeout: 15000});
        await page.waitForTimeout(250);
      };
      function check(value) {
        assert(!value.failure); assert.deepEqual(run.errors, []);
        assert(value.prewarm.ready && value.prewarm.adopted);
        for (const key of ['gi', 'reflections', 'virtualShadows', 'virtualTextures']) assert.equal(value.settings[key], 1);
        assert.deepEqual([value.view.width, value.view.height, value.view.outputWidth,
          value.view.outputHeight, value.view.antiAliasing], [1400, 788, 1920, 1080, 4]);
      }
      // Register the real possessed camera before a scripted route replaces its view target.
      await playerControl(null);
      const native = await state();
      run.native = native;
      const offset = Object.fromEntries(['x', 'y', 'z'].map(axis =>
        [axis, native.camera[axis] - native.player[axis]]));
      for (const mode of [2, 1]) {
        await motion(0, mode); const serial = await motion(15, mode);
        await scene.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
          __webMotionBenchmark.completed, serial, {timeout: 45000});
      }
      await motion(0, 2); await page.waitForTimeout(3000);
      run.initial = await state(); check(run.initial);
      console.log(JSON.stringify({name, run: run.index, stage: 'measuring', camera: run.initial.camera}));
      for (const kind of phases) {
        await motion(0, 2); await page.waitForTimeout(2500);
        if (kind === 'input') {
          await playerControl({...native.player, x: -175 - offset.x, y: -80 - offset.y,
            z: 160 - offset.z, pitch: 0, yaw: 50, roll: 0,
            controlPitch: -5, controlYaw: 50, controlRoll: 0});
          await page.waitForTimeout(2500);
        }
        const phase = {kind, before: await state()}; check(phase.before); run.phases.push(phase);
        await owner.evaluate(() => Object.assign(__releaseRegression,
          {active: true, times: [], completions: [], creations: []}));
        if (kind === 'turning') await motion(seconds, 2);
        const began = Date.now();
        if (kind === 'input') {
          phase.cameras = [phase.before.camera];
          const canvas = scene.locator('#canvas'), box = await canvas.boundingBox();
          const center = {x: box.x + box.width / 2, y: box.y + box.height / 2};
          await page.mouse.click(center.x, center.y); await page.mouse.move(center.x, center.y);
          try {
            await page.mouse.down({button: 'right'});
            while (Date.now() - began < seconds * 1000) {
              const elapsed = (Date.now() - began) / 1000;
              await page.mouse.move(center.x + Math.sin(elapsed * Math.PI / 2) * box.width * .20,
                center.y + Math.sin(elapsed * Math.PI / 3) * box.height * .025);
              if (elapsed >= phase.cameras.length) phase.cameras.push((await state()).camera);
              await page.waitForTimeout(32);
            }
          } finally {await page.mouse.up({button: 'right'});}
        } else await page.waitForTimeout(seconds * 1000);
        phase.capture = await owner.evaluate(() => {__releaseRegression.active = false; return __releaseRegression;});
        phase.after = await state(); check(phase.after); phase.gpu = gpu();
        if (kind === 'input') {
          phase.cameras.push(phase.after.camera);
          phase.yawTravel = phase.cameras.slice(1).reduce((total, camera, index) =>
            total + Math.abs((camera.yaw - phase.cameras[index].yaw + 540) % 360 - 180), 0);
          assert(phase.yawTravel > 50, 'Native drag must rotate the actual possessed camera');
          assert(phase.after.player.active, 'Script camera must not own the native input phase');
        }
        assert.equal(phase.before.prewarm.counts.misses, phase.after.prewarm.counts.misses);
        assert.deepEqual(phase.capture.creations, []);
        phase.summary = summary(phase.capture.times);
        phase.gpuCompletionSummary = summary(phase.capture.completions.filter((value, index, values) =>
          index === 0 || value > values[index - 1]));
        const frames = phase.after.frames - phase.before.frames;
        phase.summary.rhiMs = (phase.after.stages.rhiWorkMilliseconds - phase.before.stages.rhiWorkMilliseconds) / frames;
        console.log(JSON.stringify({name, kind, ...phase.summary})); save();
      }
      await page.screenshot({path: path.join(directory, 'run-' + run.index + '.png')});
      await context.close(); context = null; log.end(); log = null;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    for (const record of Object.values(packages)) assert.equal(audit(record.file).sha256, record.sha256);
    report.pass = true;
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
