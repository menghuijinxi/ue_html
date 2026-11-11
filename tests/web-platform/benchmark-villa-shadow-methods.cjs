'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const {readPage} = require('./web-pipeline-prewarm-package.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder') || 'villa-lumen-vt-20261110-v7', tag = option('tag');
const seconds = Number(option('seconds') || 30), warmup = Number(option('warmup') || 15);
const order = (option('order') || '0,1,1,0').split(',').map(Number);
const profile = option('profile') || tag;
const capturePackage = process.argv.includes('--capture-package');
assert([folder, tag].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(profile && /^[a-z0-9-]+$/.test(profile));
assert(Number.isInteger(seconds) && seconds >= 15 && seconds <= 60);
assert(Number.isInteger(warmup) && warmup >= 15 && warmup <= 60);
assert(order.length >= 2 && order.length <= 8 && order.every(value => [0, 1].includes(value)));
assert(order.includes(0) && order.includes(1));
const directory = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(directory), 'Use a new tag to preserve prior evidence');
fs.mkdirSync(directory);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const packageDirectory = path.join(__dirname, 'build', folder), packagedPage = readPage(packageDirectory);
assert(!packagedPage.args.includes('-WebPSOPrecacheTest'), 'Speculative prewarming is not comparable');
assert(capturePackage ? !packagedPage.assets.pipelinePrewarm : packagedPage.assets.pipelinePrewarm,
  'Explicitly identify diagnostic packages without a release prewarm record');
const report = {date: new Date().toISOString(), pass: false, folder, seconds, warmup, order,
  source: audit(__filename), package: audit(path.join(__dirname, 'build', folder, 'asset-versions.json')),
  capturePackage, files: ['index.html', 'UEWebEngineThreads.wasm', 'config-files.json', 'content.bin']
    .map(name => audit(path.join(packageDirectory, name))),
  runs: [], errors: [], comparisons: [],
  boundary: 'Diagnostic startup override only; original package is unchanged. VSM off retains traditional shadows. Both routes warm before timing. RHI submission intervals, not display timings. All measured windows must have zero pipeline creations and, when a release prewarm record exists, zero misses. Explicit capture packages measure warm steady-state only and are not releases.'};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function install() {
  const capture = globalThis.__shadowMethodCapture = {active: false, times: [], creations: []};
  let frame = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => frame, set(value) {
    if (capture.active && value > frame) capture.times.push(performance.now());
    frame = value;
  }});
  for (const name of ['createRenderPipeline', 'createComputePipeline', 'createShaderModule']) {
    const original = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(...args) {
      if (capture.active) capture.creations.push({name, label: args[0]?.label});
      return original.apply(this, args);
    };
  }
}
function summarize(intervals) {
  assert(intervals.length >= 100 && intervals.every(value => Number.isFinite(value) && value > 0));
  const sorted = [...intervals].sort((a, b) => a - b);
  const slowest = sorted.slice(-Math.ceil(sorted.length * .01));
  return {intervals: intervals.length, fps: 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0),
    low1Fps: 1000 * slowest.length / slowest.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1),
    over50Ms: intervals.filter(value => value > 50).length, over100Ms: intervals.filter(value => value > 100).length};
}
let context, log, run;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', profile), {
      channel: 'msedge', headless: false, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    report.browser = context.browser().version();
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      let body = await response.text();
      const marker = "        removeRunDependency('worker-content');";
      assert.equal(body.split(marker).length, 2);
      // Validate and mount original assets first, then change only the in-memory
      // test config. No package hashes or release prewarm records are rewritten.
      run.override = {path: '/Engine/Platforms/Web/Config/WebEngine.ini',
        section: 'SystemSettings', key: 'r.Shadow.Virtual.Enable', value: run.virtualShadows};
      body = body.replace(marker, `
        const shadowTestPath = ${JSON.stringify(run.override.path)};
        FS.writeFile(shadowTestPath, FS.readFile(shadowTestPath, {encoding: 'utf8'}) +
          '\\n[SystemSettings]\\nr.Shadow.Virtual.Enable=${run.virtualShadows}\\n');
${marker}`);
      await route.fulfill({response, body: '(' + install.toString() + ')();\n' + body});
    });
    for (const virtualShadows of order) {
      run = {index: report.runs.length + 1, virtualShadows, phases: [], errors: []};
      report.runs.push(run); save();
      log = fs.createWriteStream(path.join(directory, 'run-' + run.index + '.log'));
      const page = await context.newPage();
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline|Missing global shader/.test(text))
          run.errors.push(text);
      });
      page.on('pageerror', error => run.errors.push(error.message));
      console.log(JSON.stringify({run: run.index, virtualShadows, stage: 'starting'}));
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= 60 && __webPSOPrecacheReady && document.getElementById('loading')?.hidden,
      null, {timeout: 180000});
      assert(!await page.evaluate(() => globalThis.__webEngineFailure), JSON.stringify(run.errors));
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({
        frames: __webRHIFrames, camera: __webDefaultCamera, view: __webRenderView,
        settings: __webProjectSettings, stages: __webThreadStages, prewarm: globalThis.__webPipelinePrewarm || null,
        streaming: __webTextureStreaming, motion: globalThis.__webMotionBenchmark,
        failure: globalThis.__webEngineFailure
      }));
      const motion = (duration, mode) => page.evaluate(({duration, mode}) =>
        __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
      const check = value => {
        assert(!value.failure && !run.errors.length, JSON.stringify(run.errors));
        assert.equal(value.settings.virtualShadows, virtualShadows);
        assert.equal(value.settings.virtualShadowPathActive, !!virtualShadows);
        for (const key of ['gi', 'reflections', 'virtualTextures']) assert.equal(value.settings[key], 1, key);
        assert(value.settings.virtualTexturePathActive);
        assert.equal(value.view.antiAliasing, 4);
        if (!capturePackage) assert(value.prewarm?.ready && value.prewarm.adopted);
      };
      run.initial = await state(); check(run.initial);
      console.log(JSON.stringify({run: run.index, virtualShadows, stage: 'warming-routes', settings: run.initial.settings}));
      for (const mode of [2, 1]) {
        await motion(0, mode);
        const serial = await motion(warmup, mode); assert(serial > 0);
        await page.waitForTimeout(warmup * 1000);
        await page.waitForFunction(() => globalThis.__webMotionBenchmark?.completed, null, {timeout: 15000});
      }
      await motion(0, 2); await page.waitForTimeout(5000);
      run.warmed = await state(); check(run.warmed);
      for (const [name, mode] of [['standing', 0], ['turning', 2], ['moving', 1]]) {
        await motion(0, mode || 2); await page.waitForTimeout(2000);
        const phase = {name, before: await state(), samples: []}; check(phase.before);
        run.phases.push(phase); save();
        await owner.evaluate(() => Object.assign(__shadowMethodCapture, {active: true, times: [], creations: []}));
        const serial = mode ? await motion(seconds, mode) : 0;
        for (let second = 0; second < seconds; ++second) {
          await page.waitForTimeout(1000);
          const sample = await state(); check(sample); phase.samples.push(sample);
        }
        phase.capture = await owner.evaluate(() => {
          __shadowMethodCapture.active = false; return __shadowMethodCapture;
        });
        phase.after = await state(); check(phase.after);
        const times = phase.capture.times;
        phase.summary = summarize(times.slice(1).map((value, index) => value - times[index]));
        phase.summary.prewarmMisses = phase.before.prewarm ?
          phase.after.prewarm.counts.misses - phase.before.prewarm.counts.misses : null;
        phase.summary.creations = phase.capture.creations.length;
        phase.summary.rhiWorkMs = (phase.after.stages.rhiWorkMilliseconds - phase.before.stages.rhiWorkMilliseconds) /
          (phase.after.frames - phase.before.frames);
        assert.deepEqual(phase.before.settings, phase.after.settings);
        for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
          assert.equal(phase.before.view[key], phase.after.view[key], key);
        if (mode) {
          await page.waitForFunction(() => globalThis.__webMotionBenchmark?.completed, null, {timeout: 15000});
          phase.completedMotion = (await state()).motion;
          assert(phase.completedMotion.completed && phase.completedMotion.serial === serial);
          let degrees = 0, distance = 0;
          for (let index = 1; index < phase.samples.length; ++index) {
            const a = phase.samples[index - 1].camera, b = phase.samples[index].camera;
            degrees += Math.abs(((b.yaw - a.yaw + 540) % 360) - 180);
            distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          }
          phase.summary.turnDegrees = degrees; phase.summary.travelCentimeters = distance;
          assert(mode === 2 ? degrees > 250 : distance > 600, 'Camera route must cover the scene');
        }
        save(); console.log(JSON.stringify({run: run.index, virtualShadows, name, ...phase.summary}));
        await page.screenshot({path: path.join(directory, 'run-' + run.index + '-' + name + '.png')});
        if (!capturePackage)
          assert.equal(phase.summary.prewarmMisses, 0, 'Repeat route prewarming before accepting performance');
        assert.equal(phase.summary.creations, 0, 'Pipeline compilation contaminated measured window');
      }
      await page.close(); log.end(); log = null;
    }
    const reference = report.runs[0].warmed;
    for (const item of report.runs) {
      const comparable = ({virtualShadows, virtualShadowPathActive, ...settings}) => settings;
      assert.deepEqual(comparable(item.warmed.settings), comparable(reference.settings));
      for (const key of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing'])
        assert.equal(item.warmed.view[key], reference.view[key], key);
    }
    for (const name of ['standing', 'turning', 'moving']) {
      const values = order.map((value, index) => ({virtualShadows: value,
        phase: report.runs[index].phases.find(phase => phase.name === name)}));
      const summarizeMode = enabled => {
        const phases = values.filter(value => value.virtualShadows === enabled).map(value => value.phase);
        const intervals = phases.flatMap(phase => phase.capture.times.slice(1).map((time, index) => time - phase.capture.times[index]));
        return {...summarize(intervals), runs: phases.map(phase => phase.summary)};
      };
      const off = summarizeMode(0), on = summarizeMode(1);
      report.comparisons.push({name, off, on, low1CostPercent: 100 * (1 - on.low1Fps / off.low1Fps),
        averageCostPercent: 100 * (1 - on.fps / off.fps)});
    }
    assert.equal(audit(report.package.file).sha256, report.package.sha256, 'Package changed during comparison');
    report.pass = true; console.log(JSON.stringify(report.comparisons));
  } catch (error) {
    report.error = error.stack; report.errors.push(error.message); console.error(error); process.exitCode = 1;
  } finally {save(); log?.end(); await context?.close();}
})();
