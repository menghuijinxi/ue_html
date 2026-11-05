'use strict';
// Diagnostic transport substitutions in routed JS only. Packaged runtime files
// and project settings remain the inputs; this does not enable a product mode.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const folder = option('folder') || 'villa-buffer-lifecycle-v62', tag = option('tag');
assert([folder, tag].every(v => v && /^[a-z0-9-]+$/.test(v)));
const modes = (option('modes') || 'owner-raf,owner-immediate,game-local,game-local,owner-immediate,owner-raf').split(',');
assert(modes.every(v => ['owner-raf', 'owner-immediate', 'game-local'].includes(v)));
const seconds = Number(option('seconds') || 10), warmup = Number(option('warmup') || 15);
assert(seconds >= 5 && seconds <= 60 && warmup >= 5 && warmup <= 120);
const queryBuffering = Number(option('query-buffering') || 0);
assert(Number.isInteger(queryBuffering) && queryBuffering >= 0 && queryBuffering <= 4);
const queries = option('queries') || 'default';
assert(['default', 'off'].includes(queries) && !(queries === 'off' && queryBuffering));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
fs.copyFileSync(__filename, output + '-source.cjs');
const base = path.join(__dirname, 'build', folder);
const scriptName = fs.readdirSync(base).find(v => /^UEWebEngineThreads\w*\.js$/.test(v)); assert(scriptName);
const files = ['index.html', scriptName, scriptName.replace(/\.js$/, '.wasm'), 'config-files.json', 'content-files.json'];
const report = {date: new Date().toISOString(), folder, modes, seconds, warmup, queryBuffering, queries,
  source: audit(__filename), capturedSource: audit(output + '-source.cjs'), packageFiles: files.map(f => audit(path.join(base, f))),
  runs: [], qualityOverrides: [], diagnosticOverrides: queries === 'off' ? {occlusionEnabled: false} :
    queryBuffering ? {occlusionBufferedFrames: queryBuffering} : {}, pass: false,
  boundary: 'Scheduling isolation, not an accepted rendering optimization. Each run restarts visible Edge with the same saved browser profile, 2289x1287 DPR1. The nested Game rAF transport and its owner response are replaced in diagnostic JS. Optional queries-off or query-buffering RPC overrides are reported separately in diagnosticOverrides. Project visual quality, render threads, allocator, PSO-precache defaults and packaged files stay identical. Normal timing has one present hook and no CPU profiler, GPU timestamps or per-draw wrappers. Detailed scheduling records start only after normal timing. As-fast-as-possible variants change Game scheduling and power/latency behavior; compare draw/dispatch counts and camera, and do not ship these substitutions. No OS GPU utilization or full GPU frame measured.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
// Frame number and the logical worker ID are runtime metadata. Fresh workers
// can receive different IDs while rendering identical views.
const stableView = view => Object.fromEntries(Object.entries(view).filter(([key]) => !['frame', 'threadId'].includes(key)));
function distribution(values) {
  assert(values.length);
  const sorted = [...values].sort((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {count: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)],
    p99: sorted[Math.floor(sorted.length * .99)], max: sorted.at(-1),
    low1Fps: 1000 * tail.length / tail.reduce((s, v) => s + v, 0)};
}
function patchRuntime(source, mode) {
  source = `globalThis.__webPacingBuildMode = ${JSON.stringify(mode)};\n` + source;
  const bridgeBegin = '  let rafSequence = 0;\n  const rafCallbacks = new Map;\n';
  assert.equal(source.split(bridgeBegin).length, 2, 'Unexpected Game rAF bridge');
  source = source.replace(bridgeBegin, bridgeBegin + `
  const pacingMode = ${JSON.stringify(mode)};
  let pacingActive = false;
  const pacingLocal = new MessageChannel();
  const pacingNow = () => performance.timeOrigin + performance.now();
  const pacingInvoke = (id, timestamp, timing) => {
    const callback = rafCallbacks.get(id);
    rafCallbacks.delete(id);
    if (!callback) return;
    if (!timing) { callback(timestamp); return; }
    timing.gameBegin = pacingNow();
    callback(timestamp);
    timing.gameEnd = pacingNow();
    postMessage({type: 'web-pacing-record', timing});
  };
  pacingLocal.port1.onmessage = event => {
    const {id, timing} = event.data;
    pacingInvoke(id, performance.now(), timing);
  };
  addEventListener('message', event => {
    if (event.data.type === 'web-pacing-capture') {
      pacingActive = !!event.data.active;
      postMessage({type: 'web-pacing-capture-ack', active: pacingActive});
    }
  });
`);
  const send = '    postMessage({\n      type: "web-game-raf-request",\n      id\n    });';
  assert.equal(source.split(send).length, 2);
  source = source.replace(send, `    const timing = pacingActive ? {id, mode: pacingMode, requested: pacingNow()} : null;
    if (pacingMode === 'game-local') pacingLocal.port2.postMessage({id, timing});
    else postMessage({type: 'web-game-raf-request', id, timing});`);
  const deliver = '      const callback = rafCallbacks.get(event.data.id);\n      rafCallbacks.delete(event.data.id);\n      callback?.(event.data.timestamp);';
  assert.equal(source.split(deliver).length, 2);
  source = source.replace(deliver, '      pacingInvoke(event.data.id, event.data.timestamp, event.data.timing);');
  const owner = `        const id = event.data.id;
        requestAnimationFrame(timestamp => globalThis.__webGameThreadWorker.postMessage({
          type: "web-game-raf",
          id,
          timestamp
        }));`;
  assert.equal(source.split(owner).length, 2, 'Unexpected owner rAF handler');
  source = source.replace(owner, `        const id = event.data.id, timing = event.data.timing;
        if (timing) timing.ownerReceived = performance.timeOrigin + performance.now();
        const respond = timestamp => {
          if (timing) timing.ownerCallback = performance.timeOrigin + performance.now();
          globalThis.__webGameThreadWorker.postMessage({type: 'web-game-raf', id, timestamp, timing});
        };
        ${mode === 'owner-immediate' ? 'setImmediate(() => respond(performance.now()));' : 'requestAnimationFrame(respond);'}`);
  const listener = '    globalThis.__webGameThreadWorker.addEventListener("message", event => {\n';
  assert.equal(source.split(listener).length, 2);
  source = source.replace(listener, listener + `      if (event.data.type === 'web-pacing-record') {
        (globalThis.__webPacingRecords ||= []).push(event.data.timing); return;
      }
      if (event.data.type === 'web-pacing-capture-ack') {
        globalThis.__webPacingCaptureAck = event.data.active; return;
      }
`);
  return source;
}
function installPresents() {
  const state = globalThis.__schedulingPresents = {active: false, times: []};
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true,
    get: () => count, set(value) {
      if (state.active && value > count) state.times.push(performance.now());
      count = value;
    }});
}
let context, log;
(async () => {try {
  const runtimeSource = fs.readFileSync(path.join(base, scriptName), 'utf8').replace(/\r\n/g, '\n');
  for (const mode of modes) {
    const run = {index: report.runs.length + 1, mode, errors: []}; report.runs.push(run); save();
    const patched = patchRuntime(runtimeSource, mode);
    run.routedRuntimeSha256 = require('node:crypto').createHash('sha256').update(patched).digest('hex');
    const diagnosticName = tag + '-' + mode + '-runtime.js';
    fs.writeFileSync(path.join(__dirname, 'results', diagnosticName), patched);
    const diagnosticUrl = 'http://127.0.0.1:8765/results/' + diagnosticName;
    run.diagnosticRuntime = audit(path.join(__dirname, 'results', diagnosticName));
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/frame-scheduling'),
      {channel: 'msedge', headless: false, viewport: {width: 2289, height: 1287}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const versioned = "const versioned = name => name + '?v=' + assets.versions[name];";
      assert.equal(source.split(versioned).length, 2);
      const body = source.replace(versioned, 'const versioned = name => name === assets.runtime ? ' +
        JSON.stringify(diagnosticUrl) + " : name + '?v=' + assets.versions[name];");
      await route.fulfill({response, body: '(' + installPresents.toString() + ')();\n' + body});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    log = fs.createWriteStream(output + '-' + run.index + '-' + mode + '.log');
    page.on('console', m => {const text = m.text(); log?.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|P3_ENGINE_.*FAILED/.test(text)) run.errors.push(text);});
    page.on('pageerror', e => run.errors.push(e.message));
    console.log('Scheduling start', run.index, mode);
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html', {waitUntil: 'commit'});
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90, null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    run.browser = await page.evaluate(() => navigator.userAgent);
    if (queryBuffering || queries === 'off') {
      assert.equal(await page.evaluate(p => __webEngineRPC('WebOcclusionTestMode', p.enabled, p.buffering),
        {enabled: Number(queries !== 'off'), buffering: queryBuffering}), 1);
      run.occlusionOverrideAck = true;
    }
    const state = () => owner.evaluate(() => ({time: performance.now(), frames: __webRHIFrames,
      gameFrames: __webEngineFrames, stages: __webThreadStages, threads: __webEngineThreads,
      view: __webRenderView, camera: __webDefaultCamera, settings: __webProjectSettings,
      occlusion: __webOcclusionRHI, capacity: HEAPU8.buffer.byteLength,
      optimization: globalThis.__webOptimizationRHI, upload: globalThis.__webUploadStaging,
      pacingBuildMode: globalThis.__webPacingBuildMode}));
    await page.waitForTimeout(warmup * 1000);
    run.before = await state();
    assert.equal(run.before.pacingBuildMode, mode, 'Patched owner runtime did not load');
    assert(run.before.threads.renderThread && run.before.threads.rhiThread);
    assert(!run.before.upload?.enabled, 'Staging experiment must be disabled');
    assert(!run.before.occlusion.bindingPlanEnabled, 'Binding-plan experiment must be disabled');
    await owner.evaluate(() => {const s = __schedulingPresents; s.times = []; s.active = true; s.start = performance.now(); s.first = __webRHIFrames;});
    await page.waitForTimeout(seconds * 1000);
    run.measurement = await owner.evaluate(() => {const s = __schedulingPresents; s.active = false;
      return {start: s.start, end: performance.now(), frames: __webRHIFrames - s.first, times: s.times};});
    run.after = await state();
    assert.deepEqual(run.before.camera, run.after.camera);
    assert.deepEqual(run.before.settings, run.after.settings);
    assert.deepEqual([run.before.view.width, run.before.view.height, run.before.view.outputWidth, run.before.view.outputHeight], [1484, 835, 2289, 1288]);
    assert(!run.errors.length, run.errors.join('\n'));
    run.fps = run.measurement.frames * 1000 / (run.measurement.end - run.measurement.start);
    run.intervals = run.measurement.times.slice(1).map((t, i) => t - run.measurement.times[i]);
    run.frameMs = distribution(run.intervals);
    run.rhiWorkMs = (run.after.stages.rhiWorkMilliseconds - run.before.stages.rhiWorkMilliseconds) / run.measurement.frames;
    const frames = run.after.occlusion.sampleFrame - run.before.occlusion.sampleFrame;
    run.workload = Object.fromEntries(['draws', 'indirectDraws', 'dispatches', 'ready', 'pending', 'zero'].map(k => [k,
      (run.after.occlusion[k] - run.before.occlusion[k]) / frames]));
    save();
    // Timing records are a separate diagnostic window, never merged into FPS.
    await owner.evaluate(() => {globalThis.__webPacingRecords = []; globalThis.__webPacingCaptureAck = false;
      __webGameThreadWorker.postMessage({type: 'web-pacing-capture', active: true});});
    await page.waitForTimeout(4000);
    assert(await owner.evaluate(() => __webPacingCaptureAck), 'Game did not acknowledge timing capture');
    await owner.evaluate(() => __webGameThreadWorker.postMessage({type: 'web-pacing-capture', active: false}));
    await page.waitForTimeout(100);
    run.scheduling = await owner.evaluate(() => __webPacingRecords);
    assert(run.scheduling.length > 100);
    run.schedulingSummary = {};
    for (const [name, from, to] of [['requestToGame', 'requested', 'gameBegin'], ['gameCallbackWall', 'gameBegin', 'gameEnd'],
      ['requestToOwner', 'requested', 'ownerReceived'], ['ownerScheduleWait', 'ownerReceived', 'ownerCallback'], ['ownerToGame', 'ownerCallback', 'gameBegin']]) {
      const times = run.scheduling.filter(r => Number.isFinite(r[from]) && Number.isFinite(r[to])).map(r => r[to] - r[from]);
      if (times.length) run.schedulingSummary[name] = distribution(times);
    }
    await page.locator('canvas').screenshot({path: output + '-' + run.index + '-' + mode + '.png'});
    run.pass = !run.errors.length; assert(run.pass, run.errors.join('\n')); save();
    console.log(JSON.stringify({mode, fps: run.fps, low: run.frameMs.low1Fps, rhiWorkMs: run.rhiWorkMs,
      workload: run.workload, scheduling: run.schedulingSummary}));
    await context.close(); context = null; log.end(); log = null;
  }
  report.summary = {};
  for (const run of report.runs) {
    assert.deepEqual(run.before.camera, report.runs[0].before.camera);
    assert.deepEqual(run.before.settings, report.runs[0].before.settings);
    assert.deepEqual(stableView(run.before.view), stableView(run.after.view));
    assert.deepEqual(stableView(run.before.view), stableView(report.runs[0].before.view));
  }
  for (const mode of new Set(modes)) {
    const runs = report.runs.filter(r => r.mode === mode);
    report.summary[mode] = {fps: runs.reduce((s, r) => s + r.measurement.frames, 0) * 1000 /
      runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0),
      frameMs: distribution(runs.flatMap(r => r.intervals)), runs: runs.map(r => r.fps)};
  }
  for (const input of report.packageFiles) assert.equal(audit(input.file).sha256, input.sha256);
  report.pass = true; console.log(JSON.stringify(report.summary, null, 2));
} catch (e) {report.error = e.stack; console.error(e.stack); process.exitCode = 1;}
finally {await context?.close(); log?.end(); save();}})();
