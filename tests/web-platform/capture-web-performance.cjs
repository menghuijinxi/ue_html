'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const installObserver = require('./web-performance-capture-observer.cjs');
const {writeReport} = require('./render-web-performance-report.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag') || 'spawn', folder = option('folder') || 'triplex-project-distance-fields-threads';
assert(/^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
const width = Number(option('width') || 1863), height = Number(option('height') || 1030);
const dpr = Number(option('dpr') || 1), seconds = Number(option('seconds') || 6);
const warmupSeconds = Number(option('warmup-seconds') || 0);
assert(width >= 640 && width <= 3840 && height >= 360 && height <= 2160 && dpr >= 1 && dpr <= 3);
assert(seconds >= 3 && seconds <= 30);
assert(warmupSeconds >= 0 && warmupSeconds <= 120);
const output = path.join(__dirname, 'results', `performance-capture-${tag}`);
fs.mkdirSync(path.dirname(output), {recursive: true});
const report = {date: new Date().toISOString(), tag, folder, width, height, dpr, seconds, warmupSeconds,
  headless: process.argv.includes('--headless'),
  gpuCaptureBoundary: 'present-to-present',
  settingsOverrides: [], errors: [], profiles: [], parallelDrawThreads: [], pass: false,
  boundaries: ['CPU profiles are statistical stack samples, not exact scope timers.',
    'Game tick diagnostics include waits and asynchronous delivery; they are not Draw time.',
    'Pass CPU duration includes C++ command encoding between WebGPU begin/end.',
    'GPU timestamps use their own clock. They must not be aligned to CPU time without calibration.',
    'GPU pass sum excludes copies and gaps. Profiling overhead is measured separately.',
    'Original spawn camera unless --camera=room is explicitly selected. No quality cvars change.']};
let context, browserCDP, log;
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
const timeout = (promise, ms = 15000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`CDP timeout after ${ms} ms`)), ms);
  promise.then(value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);});
});
function summarize(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map(), self = new Map(), total = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  for (let i = 0; i < (profile.samples || []).length; ++i) {
    const id = profile.samples[i], us = profile.timeDeltas[i];
    self.set(id, (self.get(id) || 0) + us);
    for (let cursor = id; cursor !== undefined; cursor = parents.get(cursor)) total.set(cursor, (total.get(cursor) || 0) + us);
  }
  const rank = map => [...map].map(([id, us]) => ({name: nodes.get(id).callFrame.functionName || '(anonymous)',
    url: nodes.get(id).callFrame.url, milliseconds: us / 1000,
    percent: us / (profile.endTime - profile.startTime) * 100}))
    .sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 80);
  const names = profile.nodes.map(n => n.callFrame.functionName).join('\n');
  const role = /FRHIThread::WebPump/.test(names) ? 'RHI' : /EngineFrame\(void/.test(names) ? 'Game' :
    /RenderingThreadMain|FRenderingThread::Run/.test(names) ? 'Draw / Render' : 'Task / auxiliary';
  return {role, durationMs: (profile.endTime - profile.startTime) / 1000,
    sampleCount: profile.samples?.length || 0, self: rank(self), total: rank(total)};
}
async function attach(target) {
  const {sessionId} = await browserCDP.send('Target.attachToTarget', {targetId: target.targetId, flatten: false});
  let sequence = 0;
  const pending = new Map();
  const listener = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    message.error ? task.reject(Error(JSON.stringify(message.error))) : task.resolve(message.result);
  };
  browserCDP.on('Target.receivedMessageFromTarget', listener);
  return {target, sessionId, command: (method, params = {}) => timeout(new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, {resolve, reject});
    browserCDP.send('Target.sendMessageToTarget', {sessionId,
      message: JSON.stringify({id, method, params})}).catch(reject);
  })), detach: async () => {
    browserCDP.off('Target.receivedMessageFromTarget', listener);
    await browserCDP.send('Target.detachFromTarget', {sessionId});
  }};
}
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', 'capture-villa'),
      {channel: 'msedge', headless: process.argv.includes('--headless'), viewport: {width, height}, deviceScaleFactor: dpr});
    log = fs.createWriteStream(output + '.log');
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${installObserver.toString()})();\n` + await response.text()});
    });
    const page = context.pages()[0];
    // Performance runs must not receive keyboard/mouse input from the desktop user.
    const inputCDP = await context.newCDPSession(page);
    await inputCDP.send('Input.setIgnoreInputEvents', {ignore: true});
    await inputCDP.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    report.externalInputIgnored = true;
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const value = message.text(); log.write(value + '\n');
      const ready = value.match(/P3_ENGINE_READY (\{[^\n]+\})/);
      if (ready) report.engineReady = JSON.parse(ready[1]);
      const parallel = value.match(/P3_WEB_PARALLEL_DRAW_THREAD (\{[^\n]+\})/);
      if (parallel) report.parallelDrawThreads.push(JSON.parse(parallel[1]));
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(value)) report.errors.push(value);
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 30,
      null, {timeout: 900000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    const state = () => owner.evaluate(() => ({frames: __webRHIFrames, gameFrames: __webEngineFrames,
      stages: globalThis.__webThreadStages, threads: globalThis.__webEngineThreads,
      camera: globalThis.__webDefaultCamera, view: globalThis.__webRenderView,
      settings: globalThis.__webProjectSettings, streaming: globalThis.__webTextureStreaming,
      occlusion: globalThis.__webOcclusionRHI, adapter: __webPerformanceCapture.adapter,
      io: globalThis.__webContentIO?.stats, runtime: globalThis.__webEngineRuntime,
      failure: globalThis.__webEngineFailure, gpuErrors: __webPerformanceCapture.errors}));
    if (option('camera') === 'room')
      assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', -175, -80, 160, -5, 50)), 1);
    report.cameraMode = option('camera') === 'room' ? 'fixed-room' : 'original-spawn';
    const initial = await state();
    await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
      initial.gameFrames + 60, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    if (warmupSeconds) await page.waitForTimeout(warmupSeconds * 1000);
    report.before = await state();
    assert(!report.before.failure, report.before.failure);
    const cameraKey = value => ['x', 'y', 'z', 'pitch', 'yaw'].map(key => value.camera[key]);
    report.initialCamera = cameraKey(initial);
    assert.deepEqual(cameraKey(report.before), report.initialCamera, 'Camera moved during warmup');
    const baselineStart = performance.now();
    report.baselineSamples = [];
    const baselineSeconds = Number(option('baseline-seconds') || 10);
    assert(baselineSeconds >= 5 && baselineSeconds <= 60);
    let previousState = report.before, previousTime = baselineStart;
    for (let second = 0; second < baselineSeconds; ++second) {
      await page.waitForTimeout(1000);
      const value = await state(), time = performance.now();
      assert(!value.failure, value.failure);
      assert.deepEqual(cameraKey(value), report.initialCamera, 'Camera moved during measurement');
      report.baselineSamples.push({elapsedMs: time - baselineStart,
        frames: value.frames - previousState.frames, milliseconds: time - previousTime,
        fps: (value.frames - previousState.frames) / (time - previousTime) * 1000,
        rhiWorkMsPerFrame: (value.stages.rhiWorkMilliseconds - previousState.stages.rhiWorkMilliseconds) /
          (value.frames - previousState.frames)});
      previousState = value; previousTime = time;
    }
    report.afterBaseline = previousState;
    if (process.argv.includes('--require-render-bundles')) {
      assert(report.afterBaseline.occlusion.drawBundleHits > report.before.occlusion.drawBundleHits,
        'Render bundle cache must be used during measurement');
      assert(report.afterBaseline.occlusion.cachedDrawBundles > 0);
    }
    report.baseline = {milliseconds: previousTime - baselineStart, frames: report.afterBaseline.frames - report.before.frames};
    report.baseline.fps = report.baseline.frames / report.baseline.milliseconds * 1000;
    report.baseline.rhiWorkMsPerFrame = (report.afterBaseline.stages.rhiWorkMilliseconds -
      report.before.stages.rhiWorkMilliseconds) / report.baseline.frames;
    console.log(JSON.stringify({baseline: report.baseline, camera: report.before.camera,
      view: report.before.view, adapter: report.before.adapter}));
    await page.locator('canvas').screenshot({path: output + '-scene.png', timeout: 60000});
    if (process.argv.includes('--baseline-only')) {
      report.after = await state();
      assert(!report.errors.length && !report.after.gpuErrors.length);
      report.pass = true;
      return;
    }
    // Time API/pass instrumentation separately from statistical CPU sampling.
    await owner.evaluate(() => __webStartPerformanceCapture());
    await page.waitForTimeout(seconds * 1000);
    const captureStats = await owner.evaluate(() => {
      __webStopPerformanceCapture();
      return {milliseconds: __webPerformanceCapture.end - __webPerformanceCapture.start,
        frames: __webPerformanceCapture.frames.length};
    });
    report.instrumentedMeasurement = {...captureStats, fps: captureStats.frames / captureStats.milliseconds * 1000};
    report.capture = await owner.evaluate(() => __webPerformanceCapture);
    browserCDP = await context.browser().newBrowserCDPSession();
    const {targetInfos} = await browserCDP.send('Target.getTargets');
    const targets = targetInfos.filter(target => target.type === 'worker' &&
      (target.url.includes('127.0.0.1:8765') || target.url.startsWith('blob:')));
    const attached = [];
    // Workers may be blocked in a WASM wait; CPU sampling still works without a JS evaluation.
    for (const target of targets) {
      try {
        const session = await attach(target);
        await session.command('Profiler.enable');
        await session.command('Profiler.setSamplingInterval', {interval: 1000});
        attached.push(session);
      } catch (error) { (report.attachFailures ||= []).push({target, error: String(error)}); }
    }
    report.targets = targets;
    console.log(JSON.stringify({attachedWorkers: attached.length}));
    const traceComplete = new Promise(resolve => browserCDP.once('Tracing.tracingComplete', resolve));
    await browserCDP.send('Tracing.start', {categories: 'toplevel,devtools.timeline,v8,blink.user_timing,gpu',
      transferMode: 'ReturnAsStream'});
    const started = await Promise.allSettled(attached.map(session => session.command('Profiler.start')));
    started.forEach((result, index) => { attached[index].started = result.status === 'fulfilled'; });
    report.beforeProfile = await state();
    const profileStart = performance.now();
    await page.waitForTimeout(seconds * 1000);
    report.afterProfile = await state();
    report.profileMeasurement = {milliseconds: performance.now() - profileStart,
      frames: report.afterProfile.frames - report.beforeProfile.frames};
    report.profileMeasurement.fps = report.profileMeasurement.frames / report.profileMeasurement.milliseconds * 1000;
    const stopped = await Promise.allSettled(attached.map(session => session.started ? session.command('Profiler.stop') : null));
    for (let i = 0; i < stopped.length; ++i) {
      const value = stopped[i];
      if (value.status !== 'fulfilled' || !value.value?.profile) {
        (report.profileFailures ||= []).push({target: attached[i].target, error: String(value.reason || 'not started')});
        continue;
      }
      const profile = value.value.profile, file = path.basename(output) + `-worker-${i}.cpuprofile`;
      fs.writeFileSync(path.join(__dirname, 'results', file), JSON.stringify(profile));
      report.profiles.push({file, target: attached[i].target,
        summary: summarize(profile)});
    }
    await browserCDP.send('Tracing.end');
    const {stream} = await timeout(traceComplete, 30000);
    const traceFile = output + '-browser-trace.json';
    const trace = fs.createWriteStream(traceFile);
    while (true) {
      const chunk = await browserCDP.send('IO.read', {handle: stream, size: 1024 * 1024});
      trace.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
      if (chunk.eof) break;
    }
    await browserCDP.send('IO.close', {handle: stream});
    await new Promise(resolve => trace.end(resolve));
    report.browserTrace = path.basename(traceFile);
    await Promise.allSettled(attached.map(session => session.detach()));
    report.gpuFrames = [];
    for (let i = 0; i < 3; ++i) report.gpuFrames.push(await timeout(owner.evaluate(() => __webCaptureGPUFrame()), 60000));
    report.after = await state();
    assert(!report.errors.length && !report.after.gpuErrors.length, 'Capture reported runtime or GPU errors');
    assert(report.capture.frames.length >= 5, 'Capture must contain presented frames');
    assert(report.profiles.some(p => p.summary.role === 'RHI'), 'Capture must include the actual RHI worker');
    assert(report.profiles.some(p => p.summary.role === 'Game'), 'Capture must include the actual Game worker');
    assert(report.profiles.some(p => p.summary.role === 'Draw / Render'), 'Capture must include the actual Render worker');
    report.pass = true;
    save(); writeReport(output + '.json');
    console.log(JSON.stringify({pass: true, baseline: report.baseline, sampled: report.profileMeasurement,
      profiles: report.profiles.map(p => ({role: p.summary.role, samples: p.summary.sampleCount, file: p.file})),
      instrumented: report.instrumentedMeasurement, gpu: report.gpuFrames.map(f => f.totalPassMs), output}));
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { save(); await context?.close(); log?.end();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output})); }
})();
