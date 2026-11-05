'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'villa-scheduling-latest-v71', tag = option('tag');
assert(tag && [folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const modes = (option('modes') || 'owner,local,local,owner').split(',');
assert(modes.every(value => ['owner', 'local', 'local2', 'local4', 'local8'].includes(value)));
const duration = Number(option('seconds') || 20);
const width = Number(option('width') || 2289), height = Number(option('height') || 1287);
const scale = Number(option('scale') || 1);
const gpuProbe = process.argv.includes('--gpu-probe');
const rhiWake = option('rhiwake') || 'priority';
const minVisibleRatio = Number(option('min-visible-ratio') || 0);
const visibilityCheck = process.argv.includes('--visibility-check');
assert(['priority', 'channel'].includes(rhiWake));
assert(minVisibleRatio >= 0 && minVisibleRatio <= 1);
assert(duration >= 8 && duration <= 60 && width >= 640 && height >= 480 && scale >= 1 && scale <= 2);
const base = path.join(__dirname, 'build', folder), output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'));
fs.copyFileSync(__filename, output + '-source.cjs');
const report = {date: new Date().toISOString(), pass: false, folder, modes, duration, width, height, scale, gpuProbe, rhiWake,
  minVisibleRatio, visibilityCheck, source: audit(__filename), capturedSource: audit(output + '-source.cjs'),
  runs: [], files: ['index.html', 'UEWebEngineThreads.js', 'config-files.json',
    'web-engine-host.js', 'web-engine-worker.js'].map(name => audit(path.join(base, name))),
  boundary: 'Continuous DOM mouse/keyboard events through the packaged input bridge; light submission hook, no draw wrappers. Each run repeats a motion warmup before measurement. Submission throughput is not physical display FPS. Actual trajectories and background GPU utilization must be considered.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
function presents() {
  const state = globalThis.__clockMotionFrames = {active: false, times: []};
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => count,
    set(value) {if (state.active && value > count) state.times.push(performance.now()); count = value;}});
}
function gpuCompletions() {
  const state = globalThis.__clockMotionGPU = {submitted: 0, completed: 0, peak: 0, records: []};
  let queue;
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args); queue = device.queue; return device;
  };
  globalThis.__webGPUFrameSubmitted = () => {
    const sequence = ++state.submitted, at = performance.now();
    const pending = sequence - state.completed;
    state.peak = Math.max(state.peak, pending);
    const record = globalThis.__clockMotionFrames.active ?
      {sequence, at, pending, game: globalThis.__webEngineFrames, rhi: globalThis.__webThreadStages?.rhiWorkMilliseconds} : null;
    if (record) state.records.push(record);
    queue.onSubmittedWorkDone().then(() => {
      state.completed = Math.max(state.completed, sequence);
      if (record) record.done = performance.now();
    });
  };
}
function motionStart(duration) {
  const canvas = document.querySelector('canvas');
  canvas.focus();
  const state = globalThis.__clockMotionInput = {started: performance.now(), events: 0, done: false, key: null};
  const mouse = (type, dx, dy) => canvas.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, button: 2, buttons: type === 'mouseup' ? 0 : 2,
    clientX: innerWidth / 2, clientY: innerHeight / 2, movementX: dx, movementY: dy,
  }));
  const key = (type, value) => canvas.dispatchEvent(new KeyboardEvent(type, {
    bubbles: true, cancelable: true, key: value.toLowerCase(), code: 'Key' + value,
    keyCode: value.charCodeAt(0), which: value.charCodeAt(0),
  }));
  mouse('mousedown', 0, 0);
  let previousX = 0, previousY = 0;
  const timer = setInterval(() => {
    const elapsed = (performance.now() - state.started) / 1000;
    if (elapsed >= duration) {
      if (state.key) key('keyup', state.key);
      mouse('mouseup', 0, 0);
      clearInterval(timer); state.done = true; state.ended = performance.now();
      return;
    }
    const nextKey = Math.floor(elapsed / 2) % 2 ? 'S' : 'W';
    if (nextKey !== state.key) {
      if (state.key) key('keyup', state.key);
      key('keydown', nextKey); state.key = nextKey;
    }
    const x = 650 * Math.sin(elapsed * Math.PI / 4), y = 65 * Math.sin(elapsed * Math.PI / 3);
    mouse('mousemove', x - previousX, y - previousY);
    previousX = x; previousY = y; state.events++;
  }, 16);
}
function distribution(times) {
  const intervals = times.slice(1).map((value, index) => value - times[index]);
  assert(intervals.length > 20);
  const sorted = intervals.toSorted((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length / 100));
  return {samples: intervals.length, fps: intervals.length * 1000 / (times.at(-1) - times[0]),
    low1Fps: 1000 * tail.length / tail.reduce((sum, value) => sum + value, 0),
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], maximum: sorted.at(-1)};
}
let context, log;
(async () => {try {
  for (const mode of modes) {
    const clock = mode === 'owner' ? 'owner' : 'local', ahead = Number(mode.slice(5)) || 0;
    assert(!ahead || !gpuProbe, 'The budget already registers its own GPU completion callbacks');
    const run = {index: report.runs.length + 1, mode, errors: [], samples: []};
    report.runs.push(run); save();
    console.log('Moving clock start', run.index, mode);
    context = await chromium.launchPersistentContext(path.join(process.env.TEMP, 'ue-web-clock-motion', tag),
      {channel: 'msedge', headless: false, viewport: {width, height}, deviceScaleFactor: scale});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: '(' + presents.toString() + ')();\n' +
        (gpuProbe ? '(' + gpuCompletions.toString() + ')();\n' : '') + await response.text()});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    log = fs.createWriteStream(output + '-' + run.index + '-' + mode + '.log');
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) run.errors.push(text);
    });
    page.on('pageerror', error => run.errors.push(error.message));
    page.on('crash', () => run.errors.push('Renderer crashed'));
    run.url = `http://127.0.0.1:8765/build/${folder}/index.html?occlusion=history&clock=${clock}&gpuahead=${ahead}&rhiwake=${rhiWake}`;
    await page.goto(run.url, {waitUntil: 'commit'});
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      (globalThis.__webEngineFrames >= 200 && globalThis.__webTextureStreaming?.pending === 0),
    null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
    const state = () => owner.evaluate(() => ({time: performance.now(), frame: __webRHIFrames,
      game: __webEngineFrames, stages: __webThreadStages, camera: __webDefaultCamera,
      clock: __webGameFrameClock, history: __webOcclusionHistory, occlusion: __webOcclusionRHI,
      view: __webRenderView, settings: __webProjectSettings, stream: __webTextureStreaming,
      rhiWake: __webRHIWakeScheduler, pso: globalThis.__webPSOPrecache,
      budget: globalThis.__webLocalFrameBudget,
      gpu: globalThis.__clockMotionGPU && {submitted: __clockMotionGPU.submitted,
        completed: __clockMotionGPU.completed, peak: __clockMotionGPU.peak}}));
    run.spawn = (await state()).camera;
    await page.evaluate(motionStart, duration);
    await page.waitForFunction(() => __clockMotionInput.done, null, {timeout: (duration + 30) * 1000});
    await page.waitForTimeout(1000);
    run.before = await state();
    assert.equal(run.before.clock.mode, clock);
    if (ahead) assert.equal(run.before.budget.maxAhead, ahead);
    assert.equal(run.before.history.enabled, true);
    await owner.evaluate(() => {__clockMotionFrames.times = []; __clockMotionFrames.active = true;});
    await page.evaluate(motionStart, duration);
    while (!await page.evaluate(() => __clockMotionInput.done)) {
      await page.waitForTimeout(500);
      run.samples.push({state: await state(), input: await page.evaluate(() => __webInputBridge),
        hud: await page.evaluate(() => __webLivePerformance)});
    }
    run.measurement = await owner.evaluate(() => {
      __clockMotionFrames.active = false; return __clockMotionFrames.times;
    });
    run.after = await state();
    if (gpuProbe) {
      await page.waitForTimeout(1000);
      run.gpu = await owner.evaluate(() => __clockMotionGPU);
      const completed = run.gpu.records.filter(record => record.done);
      run.gpuSummary = {samples: completed.length, pending: run.gpu.submitted - run.gpu.completed,
        peak: Math.max(...run.gpu.records.map(record => record.pending)),
        meanLatency: completed.reduce((sum, record) => sum + record.done - record.at, 0) / completed.length,
        maxLatency: Math.max(...completed.map(record => record.done - record.at))};
    }
    run.motion = await page.evaluate(() => __clockMotionInput);
    run.result = distribution(run.measurement);
    run.display = Object.fromEntries(['visual', 'submitted', 'refresh'].map(key =>
      [key, run.samples.reduce((sum, sample) => sum + sample.hud[key].fps, 0) / run.samples.length]));
    run.display.ratio = run.display.visual / run.display.submitted;
    assert(run.display.ratio >= minVisibleRatio, 'Page-observed progress collapsed relative to submissions');
    run.rhiMs = (run.after.stages.rhiWorkMilliseconds - run.before.stages.rhiWorkMilliseconds) /
      (run.after.frame - run.before.frame);
    const frames = run.after.occlusion.sampleFrame - run.before.occlusion.sampleFrame;
    run.workload = Object.fromEntries(['draws', 'dispatches', 'pending', 'ready'].map(key =>
      [key, (run.after.occlusion[key] - run.before.occlusion[key]) / frames]));
    const cameras = [run.before.camera, ...run.samples.map(sample => sample.state.camera)];
    run.travel = cameras.slice(1).reduce((sum, value, i) => sum + Math.hypot(
      value.x - cameras[i].x, value.y - cameras[i].y, value.z - cameras[i].z), 0);
    run.turn = cameras.slice(1).reduce((sum, value, i) => sum +
      Math.abs(((value.yaw - cameras[i].yaw + 540) % 360) - 180), 0);
    assert(run.travel > 10 && run.turn > 30, 'Camera must translate and turn during measurement');
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.before.settings, run.after.settings);
    await page.locator('canvas').screenshot({path: output + '-' + run.index + '-' + mode + '.png'});
    if (visibilityCheck && ahead) {
      // This automated Edge session reports all tabs as visible. Exercise the
      // real host visibility handler explicitly; this is not OS tab freezing.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => document.hidden && __webGameFrameClock.paused, null,
        {timeout: 10000, polling: 100});
      await page.waitForTimeout(1000);
      const paused = await state();
      await page.waitForTimeout(300);
      assert.equal((await state()).frame, paused.frame, 'Hidden Game clock must stop frame production');
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(frame => !document.hidden && !__webGameFrameClock.paused &&
        __webEngineFrames > frame + 10, paused.game, {timeout: 10000});
      run.visibility = {method: 'synthetic-document-visibility-event',
        paused: paused.frame, resumed: (await state()).frame};
    }
    run.pass = true; save();
    console.log(JSON.stringify({mode, ...run.result, travel: run.travel, turn: run.turn, rhiMs: run.rhiMs,
      workload: run.workload, display: run.display, gpu: run.gpuSummary, budget: run.after.budget}));
    await context.close(); context = null;
    await new Promise(resolve => log.end(resolve)); log = null;
  }
  for (const run of report.runs) {
    assert.deepEqual(run.before.settings, report.runs[0].before.settings);
    for (const key of ['width', 'height', 'outputWidth', 'outputHeight'])
      assert.equal(run.before.view[key], report.runs[0].before.view[key]);
  }
  for (const item of report.files) assert.equal(audit(item.file).sha256, item.sha256);
  report.pass = true;
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (context) report.startup = await context.pages()[0]?.evaluate(() => ({
    failure: globalThis.__webEngineFailure, diagnostics: globalThis.__webStartupDiagnostics,
  })).catch(() => null);
} finally {
  await context?.close(); if (log) await new Promise(resolve => log.end(resolve));
  save(); console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));
}})();
