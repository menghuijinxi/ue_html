'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {execFileSync} = require('node:child_process');
const {audit} = require('./content-file-metadata.cjs'), {readPage} = require('./web-pipeline-prewarm-package.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag'), seconds = Number(option('seconds') || 15);
const optimization = option('optimization') || 'indirect';
assert(['indirect', 'pages'].includes(optimization));
const setting = optimization === 'pages' ? 'r.WebGPU.VSMPageOptimization' : 'r.WebGPU.IndirectDrawReuse';
const order = (option('order') || (optimization === 'pages' ? '0,3,3,0' : '0,2,2,0')).split(',').map(Number);
assert([folder, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(seconds >= 15 && seconds <= 60 && order.every(value => [0, 1, 2, 3].includes(value)));
const directory = path.join(__dirname, 'results', tag); assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const packaged = readPage(path.join(__dirname, 'build', folder));
assert(packaged.assets.pipelinePrewarm && !packaged.args.includes('-WebPSOPrecacheTest'));
const report = {date: new Date().toISOString(), pass: false, folder, seconds, order, setting, runs: [], comparisons: [],
  source: audit(__filename), package: audit(path.join(__dirname, 'build', folder, 'asset-versions.json')),
  boundary: 'One immutable release, diagnostic startup override only for ' + setting + '. Static, turning and moving RHI submission intervals after route warmup. No per-draw instrumentation or CPU profiler. Normal prewarm must be adopted; measured windows require zero pipeline creations and misses.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
const gpuState = () => process.argv.includes('--gpu-state') ? execFileSync('nvidia-smi',
  ['--query-gpu=pstate,utilization.gpu,memory.used,clocks.gr,clocks.mem', '--format=csv'], {encoding: 'utf8'}) : undefined;
function install() {
  const capture = globalThis.__indirectCapture = {active: false, times: [], creations: []}; let frame = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => frame, set(value) {
    if (capture.active && value > frame) capture.times.push(performance.now()); frame = value;
  }});
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createShaderModule',
    'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const create = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(...args) {
      if (capture.active) capture.creations.push(name); return create.apply(this, args);
    };
  }
}
function summarize(intervals) {
  assert(intervals.length >= 100 && intervals.every(value => value > 0 && Number.isFinite(value)));
  const sorted = [...intervals].sort((a, b) => a - b), slow = sorted.slice(-Math.ceil(sorted.length * .01));
  return {frames: intervals.length, fps: 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0),
    low1Fps: 1000 * slow.length / slow.reduce((a, b) => a + b, 0),
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1)};
}
let context, log, run;
(async () => {
  try {
    process.env.TEMP = process.env.TMP = path.join(__dirname, 'build/test-tmp');
    context = await chromium.launchPersistentContext(path.join(__dirname,
      'build/browser-profiles/vsm-adaptive-production-20261112'), {channel: 'msedge', headless: false,
      viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    report.browser = context.browser().version();
    const anchor = context.pages()[0] || await context.newPage();
    await anchor.goto('about:blank');
    for (const previous of context.pages()) if (previous !== anchor) await previous.close();
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch(), marker = "        removeRunDependency('worker-content');";
      let body = await response.text(); assert.equal(body.split(marker).length, 2);
      body = body.replace(marker, `
        const reuseTestPath='/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(reuseTestPath,FS.readFile(reuseTestPath,{encoding:'utf8'})+
          '\\n[SystemSettings]\\n${setting}=${run.mode}\\n');
${marker}`);
      await route.fulfill({response, body: '(' + install.toString() + ')();\n' + body});
    });
    for (const mode of order) {
      run = {index: report.runs.length + 1, mode, phases: [], errors: []}; report.runs.push(run); save();
      const page = await context.newPage();
      log = fs.createWriteStream(path.join(directory, 'run-' + run.index + '.log'));
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline/.test(text))
          run.errors.push(text);
      });
      console.log(JSON.stringify({run: run.index, mode, stage: 'starting'}));
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90 &&
        document.getElementById('loading')?.hidden, null, {timeout: 240000});
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({frames: __webRHIFrames, view: __webRenderView,
        settings: __webProjectSettings, camera: __webDefaultCamera, motion: globalThis.__webMotionBenchmark,
        prewarm: __webPipelinePrewarm, rhi: __webOcclusionRHI, stages: __webThreadStages,
        sampling: __webVSMAdaptiveSampling, failure: globalThis.__webEngineFailure}));
      function check(value) {
        assert(!value.failure, value.failure); assert.deepEqual(run.errors, []);
        assert.equal(value.rhi.indirectDrawReuse, optimization === 'indirect' ? mode : 2);
        if (optimization === 'pages') {
          assert.equal(value.rhi.vsmPageOptimization, mode);
          if (mode & 1) assert(value.rhi.atomicHeaderBindings > 0);
        }
        assert(value.prewarm.ready && value.prewarm.adopted);
        for (const key of ['gi', 'reflections', 'virtualTextures', 'virtualShadows']) assert.equal(value.settings[key], 1);
        assert(value.settings.virtualTexturePathActive && value.settings.virtualShadowPathActive);
        assert(value.sampling.enabled && value.sampling.supported);
        assert.deepEqual([value.view.width, value.view.height, value.view.outputWidth,
          value.view.outputHeight, value.view.antiAliasing], [1400, 788, 1920, 1080, 4]);
      }
      const motion = (duration, mode) => page.evaluate(({duration, mode}) =>
        __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
      for (const route of [2, 1]) {
        await motion(0, route); const serial = await motion(15, route);
        await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
          __webMotionBenchmark.completed, serial, {timeout: 45000});
      }
      await motion(0, 2); await page.waitForTimeout(5000);
      run.warmed = await state(); check(run.warmed);
      run.gpuWarmed = gpuState();
      for (const [name, route] of [['standing', 0], ['turning', 2], ['moving', 1]]) {
        await motion(0, route || 2); await page.waitForTimeout(2000);
        const phase = {name, before: await state(), samples: []}; check(phase.before); run.phases.push(phase);
        await owner.evaluate(() => Object.assign(__indirectCapture, {active: true, times: [], creations: []}));
        const serial = route ? await motion(seconds, route) : 0;
        for (let second = 0; second < seconds; ++second) {
          await page.waitForTimeout(1000); const value = await state(); check(value); phase.samples.push(value);
        }
        phase.capture = await owner.evaluate(() => {__indirectCapture.active = false; return __indirectCapture;});
        phase.after = await state(); check(phase.after);
        phase.gpuAfter = gpuState();
        const times = phase.capture.times;
        phase.summary = summarize(times.slice(1).map((value, index) => value - times[index]));
        const frames = phase.after.frames - phase.before.frames;
        phase.summary.rhiMs = (phase.after.stages.rhiWorkMilliseconds - phase.before.stages.rhiWorkMilliseconds) / frames;
        for (const key of ['indirectTemplateHits', 'indirectTemplatesCreated', 'indirectBindingHits', 'indirectDraws',
          ...(optimization === 'pages' ? ['atomicCopiesToTexture', 'atomicCopiesToBuffer', 'atomicCopyBytes'] : [])])
          phase.summary[key + 'PerFrame'] = (phase.after.rhi[key] - phase.before.rhi[key]) / frames;
        assert.equal(phase.after.prewarm.counts.misses, phase.before.prewarm.counts.misses);
        assert.deepEqual(phase.capture.creations, []);
        assert.deepEqual(phase.before.settings, phase.after.settings);
        if (route) {
          await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
            __webMotionBenchmark.completed, serial, {timeout: 15000});
          let degrees = 0, distance = 0;
          for (let index = 1; index < phase.samples.length; ++index) {
            const a = phase.samples[index - 1].camera, b = phase.samples[index].camera;
            degrees += Math.abs((b.yaw - a.yaw + 540) % 360 - 180);
            distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          }
          Object.assign(phase.summary, {degrees, distance});
          assert(route === 2 ? degrees > 250 : distance > 600);
        }
        await page.screenshot({path: path.join(directory, 'run-' + run.index + '-' + name + '.png')});
        console.log(JSON.stringify({run: run.index, mode, name, ...phase.summary})); save();
      }
      await page.close(); log.end(); log = null;
    }
    for (const name of ['standing', 'turning', 'moving']) {
      const modes = [...new Set(order)].map(mode => {
        const phases = report.runs.filter(run => run.mode === mode).map(run => run.phases.find(phase => phase.name === name));
        return {mode, ...summarize(phases.flatMap(phase => phase.capture.times.slice(1)
          .map((value, index) => value - phase.capture.times[index]))), runs: phases.map(phase => phase.summary)};
      });
      report.comparisons.push({name, modes});
    }
    assert.equal(audit(report.package.file).sha256, report.package.sha256); report.pass = true;
    console.log(JSON.stringify(report.comparisons));
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
