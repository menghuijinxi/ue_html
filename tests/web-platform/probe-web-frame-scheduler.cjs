'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = n => process.argv.find(v => v.startsWith('--' + n + '='))?.slice(n.length + 3);
const folder = option('folder') || 'villa-buffer-lifecycle-v62', tag = option('tag');
assert([folder, tag].every(v => v && /^[a-z0-9-]+$/.test(v)));
const prototype = process.argv.includes('--prototype'), stress = process.argv.includes('--stress');
const frozen = process.argv.includes('--frozen');
assert(!frozen || stress);
const modes = (option('modes') || 'control,frame2,frame2,control').split(',');
assert(modes.every(v => /^(control|frame[1-4])(?:w(?:[0-9]|1[0-9]|20))?$/.test(v)));
const seconds = Number(option('seconds') || 20), warmup = Number(option('warmup') || 15);
assert(seconds >= 5 && seconds <= 60 && warmup >= 5 && warmup <= 120);
const output = path.join(__dirname, 'results', tag), base = path.join(__dirname, 'build', folder);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
fs.copyFileSync(__filename, output + '-source.cjs');
const runtime = fs.readdirSync(base).find(v => /^UEWebEngineThreads\w*\.js$/.test(v)); assert(runtime);
const helpers = ['web-engine-host.js', 'web-engine-worker.js'];
const report = {date: new Date().toISOString(), folder, modes, prototype, stress, frozen, seconds, warmup, pass: false,
  source: audit(output + '-source.cjs'), helpers: helpers.map(f => audit(path.join(prototype ? __dirname : base, f))),
  packageFiles: ['index.html', runtime, runtime.replace(/\.js$/, '.wasm'), 'config-files.json', 'content-files.json'].map(f => audit(path.join(base, f))),
  qualityOverrides: [], runs: [], boundary: 'Same-package frame scheduling experiment. Queries remain enabled with original buffering. Visible Edge, 2289x1287 DPR1, original quality/Cook, no profiler or per-draw wrappers. Candidate uses direct page-to-Game rAF and GPU completion credits. Promise per frame is part of the candidate cost. FPS is completed RHI submission, not scanout. Prototype substitutes only JS bridge/helpers; compiled runs use packaged runtime.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
const stableView = view => Object.fromEntries(Object.entries(view).filter(([k]) => !['frame', 'threadId'].includes(k)));
function distribution(values) {
  assert(values.length);
  const sorted = [...values].sort((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length * .01));
  return {count: values.length, mean: values.reduce((s, v) => s + v, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)],
    maximum: sorted.at(-1), low1Fps: 1000 * tail.length / tail.reduce((s, v) => s + v, 0)};
}
function presents() {
  let count = 0;
  const capture = globalThis.__frameSchedulerCapture = {active: false, times: []};
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => count,
    set(value) {if (capture.active && value > count) capture.times.push(performance.now()); count = value;}});
}
let diagnosticUrl;
if (prototype) {
  let source = fs.readFileSync(path.join(base, runtime), 'utf8').replace(/\r\n/g, '\n');
  const bridge = fs.readFileSync(path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = bridge.indexOf('  $WebThreadBridge: () => {') + '  $WebThreadBridge: () => {'.length;
  const end = bridge.indexOf('\n  },\n  $findCanvasEventTarget__deps', start); assert(start > 30 && end > start);
  const original = source.match(/var WebThreadBridge = \(\) => \{[\s\S]*?\n\};/g); assert.equal(original?.length, 1);
  source = source.replace(original[0], 'var WebThreadBridge = () => {' + bridge.slice(start, end) + '\n};');
  const attach = '    globalThis.__webGameThreadWorker = PThread.pthreads[Number($0)];';
  assert.equal(source.split(attach).length, 2);
  source = source.replace(attach, attach + '\n    globalThis.__webAttachFrameScheduler?.(globalThis.__webGameThreadWorker);');
  const endFrame = '    globalThis.__webRHIFrames = $3;';
  assert.equal(source.split(endFrame).length, 2);
  source = source.replace(endFrame, endFrame + '\n    globalThis.__webGPUFrameSubmitted?.();');
  const file = output + '-runtime.js'; fs.writeFileSync(file, source);
  report.prototypeRuntime = audit(file);
  report.prototypeBridge = audit(path.resolve(__dirname, '../../reference-engine/Engine/Platforms/Web/Build/WebWorkerCanvas.js'));
  diagnosticUrl = 'http://127.0.0.1:8765/results/' + path.basename(file);
}
let context, log;
(async () => {try {
  for (const mode of modes) {
    const maxAhead = mode.startsWith('control') ? 0 : Number(mode[5]);
    const queryWaitMs = Number(mode.split('w')[1] || 0);
    assert(!prototype || !queryWaitMs, 'Query waiting requires a compiled runtime');
    const run = {index: report.runs.length + 1, mode, maxAhead, queryWaitMs, errors: []}; report.runs.push(run); save();
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/frame-scheduler'),
      {channel: 'msedge', headless: false, viewport: {width: 2289, height: 1287}, deviceScaleFactor: 1});
    await context.route('**/index.html', async route => {
      const response = await route.fetch(); let body = await response.text();
      const match = body.match(/arguments: (\[[^\n]+\]),/); assert(match);
      const args = JSON.parse(match[1]); assert(!args.some(a => a.startsWith('-WebFrameScheduler=')));
      if (maxAhead) args.push('-WebFrameScheduler=' + maxAhead);
      if (frozen) args.push('-WebVisualTestClock');
      body = body.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',');
      await route.fulfill({response, body});
    });
    await context.route('**/web-engine-host.js?*', async route => {
      if (prototype) await route.fulfill({contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'web-engine-host.js'), 'utf8')});
      else await route.continue();
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch(); let body = prototype ? fs.readFileSync(path.join(__dirname, 'web-engine-worker.js'), 'utf8') : await response.text();
      if (prototype) {
        const key = "const versioned = name => name + '?v=' + assets.versions[name];"; assert.equal(body.split(key).length, 2);
        body = body.replace(key, 'const versioned = name => name === assets.runtime ? ' + JSON.stringify(diagnosticUrl) + " : name + '?v=' + assets.versions[name];");
      }
      await route.fulfill({response, body: '(' + presents.toString() + ')();\n' + body});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    log = fs.createWriteStream(output + '-' + run.index + '-' + mode + '.log');
    page.on('console', m => {const text = m.text(); log?.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(text)) run.errors.push(text);});
    page.on('pageerror', e => run.errors.push(e.message));
    console.log('Frame scheduler start', run.index, mode);
    await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html', {waitUntil: 'commit'});
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90, null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    if (queryWaitMs) assert.equal(await page.evaluate(ms => __webEngineRPC('WebLightingQualityTest', 20, ms), queryWaitMs), 1);
    const state = () => owner.evaluate(() => ({time: performance.now(), frame: __webRHIFrames, game: __webEngineFrames,
      stages: __webThreadStages, threads: __webEngineThreads, view: __webRenderView, camera: __webDefaultCamera,
      settings: __webProjectSettings, occlusion: __webOcclusionRHI, streaming: __webTextureStreaming,
      capacity: HEAPU8.buffer.byteLength, gpu: frameScheduler ? Array.from(frameScheduler.state) : null,
      upload: globalThis.__webUploadStaging, queryWait: globalThis.__webOcclusionWait, failure: globalThis.__webEngineFailure}));
    await page.waitForTimeout(warmup * 1000);
    run.before = await state();
    assert(run.before.threads.renderThread && run.before.threads.rhiThread);
    assert(!run.before.occlusion.bindingPlanEnabled && !run.before.upload?.enabled);
    if (!prototype) assert.equal(run.before.queryWait.budgetMs, queryWaitMs);
    assert.equal(!!run.before.gpu, !!maxAhead);
    if (maxAhead) assert.equal(run.before.gpu[6], 1);
    await owner.evaluate(() => {const c = __frameSchedulerCapture; c.times = []; c.active = true; c.start = performance.now(); c.first = __webRHIFrames;});
    await page.waitForTimeout(seconds * 1000);
    run.measurement = await owner.evaluate(() => {const c = __frameSchedulerCapture; c.active = false;
      return {start: c.start, end: performance.now(), frames: __webRHIFrames - c.first, times: c.times};});
    run.after = await state();
    assert.deepEqual(run.before.camera, run.after.camera);
    assert.deepEqual(run.before.settings, run.after.settings);
    assert.deepEqual(stableView(run.before.view), stableView(run.after.view));
    assert(!run.errors.length && !run.after.failure, run.errors.join('\n'));
    run.intervals = run.measurement.times.slice(1).map((t, i) => t - run.measurement.times[i]);
    run.frameMs = distribution(run.intervals);
    run.fps = run.measurement.frames * 1000 / (run.measurement.end - run.measurement.start);
    run.rhiWorkMs = (run.after.stages.rhiWorkMilliseconds - run.before.stages.rhiWorkMilliseconds) / run.measurement.frames;
    const samples = run.after.occlusion.sampleFrame - run.before.occlusion.sampleFrame;
    run.workload = Object.fromEntries(['draws', 'indirectDraws', 'dispatches', 'ready', 'pending', 'zero'].map(k => [k,
      (run.after.occlusion[k] - run.before.occlusion[k]) / samples]));
    run.workload.pendingFraction = run.workload.pending / (run.workload.ready + run.workload.pending);
    if (!prototype) run.queryWait = {callsPerFrame: (run.after.queryWait.calls - run.before.queryWait.calls) / samples,
      unreadyPerFrame: (run.after.queryWait.unready - run.before.queryWait.unready) / samples,
      msPerFrame: (run.after.queryWait.microseconds - run.before.queryWait.microseconds) / samples / 1000};
    if (maxAhead) {
      assert(run.after.gpu[0] > run.before.gpu[0]);
      assert(run.after.gpu[3] <= maxAhead && run.after.gpu[5] <= maxAhead, 'GPU credit cap exceeded');
    }
    run.pageClock = await page.evaluate(() => globalThis.__webFrameSchedulerPage || null);
    run.bootstrap = await owner.evaluate(() => globalThis.__webFrameSchedulerBootstrap || null);
    await page.locator('canvas').screenshot({path: output + '-' + run.index + '-' + mode + '.png'});
    if (stress) {
      run.stress = [];
      const camera = run.before.camera;
      // Verify input before the visual RPC replaces the pawn's view target
      // with its stationary diagnostic camera actor.
      const inputStart = await state();
      await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown',
        {key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true})));
      await page.waitForTimeout(600);
      await page.evaluate(() => document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keyup',
        {key: 'w', code: 'KeyW', keyCode: 87, which: 87, bubbles: true})));
      await page.waitForTimeout(300); const inputEnd = await state();
      assert.notDeepEqual(inputStart.camera, inputEnd.camera, 'Gameplay input did not move the camera');
      run.input = {before: inputStart.camera, after: inputEnd.camera};
      const views = [camera, ...[90, 180, 270].map(yaw => ({...camera, yaw: camera.yaw + yaw})),
        {x: -175, y: -80, z: 160, pitch: -5, yaw: 50}];
      const viewRPC = async view => assert.equal(await page.evaluate(p => __webEngineRPC('WebProjectViewTest',
        p.x, p.y, p.z, p.pitch, p.yaw), view), 1);
      for (const view of views) {await viewRPC(view); await page.waitForTimeout(2000);}
      run.visual = [];
      for (let index = 0; index < views.length; ++index) {
        await viewRPC(views[index]); await page.waitForTimeout(2500);
        const snapshot = await state(), file = output + '-' + run.index + '-view' + index + '.png';
        assert.equal(snapshot.streaming.pending, 0);
        await page.locator('canvas').screenshot({path: file});
        run.visual.push({view: views[index], snapshot, screenshot: audit(file)}); run.stress.push(snapshot);
      }
      await viewRPC(camera);
      for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}, {width: 2289, height: 1287}]) {
        await page.setViewportSize(size); await page.waitForTimeout(1800); run.stress.push(await state());
      }
      if (maxAhead) {
        await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false});
        // Focus emulation can keep a page visible even after a tab switch;
        // use a separate browser window and minimize the tested window.
        const {windowId} = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'minimized'}});
        await page.waitForTimeout(500);
        const actualHiddenObserved = await page.evaluate(() => document.hidden);
        // This automation host can keep every page visible, including minimized
        // windows. Retain that limit and test our visibility handler explicitly.
        if (!actualHiddenObserved) await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', {configurable: true, value: true});
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(500); const hidden = await state(); await page.waitForTimeout(1000);
        const hiddenAfter = await state(); assert(hiddenAfter.frame - hidden.frame <= maxAhead);
        await cdp.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'normal'}});
        if (!actualHiddenObserved) await page.evaluate(() => {
          delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.bringToFront(); await page.waitForTimeout(1500);
        const resumed = await state(); assert(resumed.frame > hiddenAfter.frame + 20);
        run.visibility = {actualHiddenObserved, handlerSimulated: !actualHiddenObserved, hidden, hiddenAfter, resumed};
      }
      assert(run.stress.every(s => !s.failure && (!maxAhead || s.gpu[3] <= maxAhead && s.gpu[5] <= maxAhead)));
    }
    assert(!run.errors.length); run.pass = true; save();
    console.log(JSON.stringify({mode, fps: run.fps, low: run.frameMs.low1Fps, rhiWorkMs: run.rhiWorkMs,
      workload: run.workload, queryWait: run.queryWait, gpu: run.after.gpu}));
    await context.close(); context = null; log.end(); log = null;
  }
  for (const run of report.runs) {
    assert.deepEqual(run.before.camera, report.runs[0].before.camera);
    assert.deepEqual(run.before.settings, report.runs[0].before.settings);
    assert.deepEqual(stableView(run.before.view), stableView(report.runs[0].before.view));
  }
  report.summary = Object.fromEntries([...new Set(modes)].map(mode => {
    const runs = report.runs.filter(r => r.mode === mode);
    return [mode, {fps: runs.reduce((s, r) => s + r.measurement.frames, 0) * 1000 /
      runs.reduce((s, r) => s + r.measurement.end - r.measurement.start, 0), frameMs: distribution(runs.flatMap(r => r.intervals))}];
  }));
  report.packageFiles.forEach(item => assert.equal(audit(item.file).sha256, item.sha256));
  report.pass = true; console.log(JSON.stringify(report.summary));
} catch (error) {report.error = error.stack; console.error(error.stack); process.exitCode = 1;}
finally {await context?.close(); log?.end(); save();}})();
