'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'villa-scheduling-latest-v71', tag = option('tag');
assert(tag && [folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const profile = option('profile') || tag;
assert(/^[a-z0-9-]+$/.test(profile));
const modes = (option('modes') || 'owner,local,local,owner').split(',');
assert(modes.every(value => /^(owner|local|local[1-8]|pipeline[1-8]|page[1-4])$/.test(value)));
const duration = Number(option('seconds') || 20);
const width = Number(option('width') || 2289), height = Number(option('height') || 1287);
const scale = Number(option('scale') || 1);
const gpuProbe = process.argv.includes('--gpu-probe');
const gpuTimestamps = process.argv.includes('--gpu-timestamps');
const rhiWake = option('rhiwake') || 'priority';
const occlusionMode=option('occlusion')||'history';
assert(['history','hzb'].includes(occlusionMode));
const minVisibleRatio = Number(option('min-visible-ratio') || 0);
const visibilityCheck = process.argv.includes('--visibility-check');
const pipeline = process.argv.includes('--pipeline');
const stallTrace = process.argv.includes('--stall-trace');
const dawnTrace = process.argv.includes('--dawn-trace');
const chromeTrace = process.argv.includes('--chrome-trace') || stallTrace || dawnTrace;
const inputMode = option('input') || 'owner-forwarded';
const packagedInput = process.argv.includes('--packaged-input');
const defaultSettings = process.argv.includes('--default-settings');
const mouseOnly=process.argv.includes('--mouse-only'), profileWorkers=process.argv.includes('--profile-workers');
const resetInput=process.argv.includes('--reset-input');
const recoveryCheck=process.argv.includes('--recovery-check');
const passCounts=process.argv.includes('--pass-counts');
const shadowCacheProbe=process.argv.includes('--shadow-cache-probe');
const bufferLifecycle=process.argv.includes('--buffer-lifecycle');
assert(!resetInput||mouseOnly,'Orientation reset is for mouse-only runs');
assert(['owner-forwarded', 'direct-game-thread', 'shared-mailbox'].includes(inputMode));
assert(!defaultSettings || (modes.length === 1 && packagedInput));
const pipelineObserver = require('./web-local-pipeline-observer.cjs');
assert(['priority', 'channel'].includes(rhiWake));
assert(minVisibleRatio >= 0 && minVisibleRatio <= 1);
assert(duration >= 8 && duration <= 60 && width >= 640 && height >= 480 && scale >= 1 && scale <= 2);
const base = path.join(__dirname, 'build', folder), output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'));
fs.copyFileSync(__filename, output + '-source.cjs');
const report = {date: new Date().toISOString(), pass: false, folder, profile, modes, duration, width, height, scale, gpuProbe, gpuTimestamps, rhiWake,
  occlusionMode,
  minVisibleRatio, visibilityCheck, pipeline, chromeTrace, inputMode, packagedInput, defaultSettings,
  mouseOnly,profileWorkers,resetInput,recoveryCheck,stallTrace,dawnTrace,passCounts,shadowCacheProbe,bufferLifecycle,
  source: audit(__filename), capturedSource: audit(output + '-source.cjs'),
  observerSource: pipeline ? audit(path.join(__dirname, 'web-local-pipeline-observer.cjs')) : undefined,
  passCounterSource:passCounts?audit(require.resolve('./web-render-pass-counts.cjs')):undefined,
  bufferObserverSource:bufferLifecycle?audit(require.resolve('./web-buffer-lifecycle-observer.cjs')):undefined,
  gpuObserverSource:gpuTimestamps?audit(require.resolve('./web-performance-capture-observer.cjs')):undefined,
  runs: [], files: ['index.html', 'UEWebEngineThreads.js', 'config-files.json',
    'web-engine-host.js', 'web-engine-worker.js'].map(name => audit(path.join(base, name))),
  boundary: 'Continuous DOM mouse/keyboard events through the packaged input bridge; light submission hook, no draw wrappers. Each run repeats a motion warmup before measurement. Submission throughput is not physical display FPS. Actual trajectories and background GPU utilization must be considered.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
function presents() {
  const state = globalThis.__clockMotionFrames = {active: false, times: []};
  const previous = Object.getOwnPropertyDescriptor(globalThis, '__webRHIFrames');
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => count,
    set(value) {previous?.set?.(value); if (state.active && value > count) state.times.push(performance.now()); count = value;}});
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
function motionStart(options) {
  const duration=typeof options==='number'?options:options.duration;
  const mouseOnly=typeof options==='object'&&options.mouseOnly;
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
      if(mouseOnly)mouse('mousemove',-previousX,-previousY);
      mouse('mouseup', 0, 0);
      clearInterval(timer); state.done = true; state.ended = performance.now();
      return;
    }
    const nextKey = mouseOnly?null:Math.floor(elapsed / 2) % 2 ? 'S' : 'W';
    if (nextKey !== state.key) {
      if (state.key) key('keyup', state.key);
      if(nextKey)key('keydown', nextKey); state.key = nextKey;
    }
    // MouseEvent movement values are integers. Round the absolute trajectory
    // before differencing to avoid accumulating truncation drift every event.
    const x = mouseOnly?Math.round(650*Math.sin(elapsed*Math.PI/4)):650*Math.sin(elapsed*Math.PI/4);
    const y = mouseOnly?0:65 * Math.sin(elapsed * Math.PI / 3);
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
    const frameBudget=mode.startsWith('page')?Number(mode.slice(4)):0;
    const clock = frameBudget?'page':mode === 'owner' ? 'owner' : 'local', ahead = clock==='local'?(Number(mode.match(/[1-8]$/)?.[0]) || 0):0;
    const budgetMode = mode.startsWith('pipeline') ? 'pipeline' : 'submitted';
    assert(!ahead || !gpuProbe, 'The budget already registers its own GPU completion callbacks');
    const run = {index: report.runs.length + 1, mode, errors: [], samples: []};
    report.runs.push(run); save();
    console.log('Moving clock start', run.index, mode);
    context = await chromium.launchPersistentContext(process.argv.includes('--workspace-profile')?
      path.join(__dirname,'build/browser-profiles',profile):path.join(process.env.TEMP, 'ue-web-clock-motion', profile),
      {channel: 'msedge', headless: false, viewport: {width, height}, deviceScaleFactor: scale});
    let diagnosticUrl;
    if (pipeline) {
      let source = fs.readFileSync(path.join(base, 'UEWebEngineThreads.js'), 'utf8');
      const marker = 'var WebThreadBridge = '; assert.equal(source.split(marker).length, 2);
      source = source.replace(marker, '(' + pipelineObserver.game.toString() + ')();\n' + marker);
      const file = output + '-runtime.js';
      fs.writeFileSync(file, source); run.diagnosticRuntime = audit(file);
      diagnosticUrl = 'http://127.0.0.1:8765/results/' + path.basename(file);
    }
    if (!packagedInput || pipeline) await context.route('**/web-engine-host.js?*', async route => {
      const response = await route.fetch();
      let body = await response.text();
      const marker = '  const experiment = new URLSearchParams(location.search);';
      assert.equal(body.split(marker).length, 2);
      body = body.replace(marker, `  assets = {...assets, inputTrace: true${packagedInput ? '' :
        ', inputBridge: ' + JSON.stringify(inputMode)}};\n` + marker);
      if (pipeline) {
        const marker = "const message = {type: 'inputs', sequence, events: items.map(v => v.values)};";
        assert.equal(body.split(marker).length, 2);
        body = body.replace(marker, marker + '\nmessage.pipelineFirst = items[0].first; message.pipelineLast = items.at(-1).last; message.pipelineSent = performance.timeOrigin + performance.now();');
      }
      await route.fulfill({response, body});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      let body = await response.text();
      if(frameBudget&&gpuProbe){
        const marker='  frameScheduler.queue.onSubmittedWorkDone().then(() => {';
        assert.equal(body.split(marker).length,2);
        body=body.replace(marker,`  const s=__clockMotionGPU,at=performance.now(),pending=submitted-Atomics.load(state,0);
  s.submitted=submitted;s.peak=Math.max(s.peak,pending);
  const measured=__clockMotionFrames.active?{sequence:submitted,at,pending,game:globalThis.__webEngineFrames}:null;
  if(measured)s.records.push(measured);
${marker}
    s.completed=Math.max(s.completed,submitted);if(measured)measured.done=performance.now();`);
      }
      if (pipeline) {
        const marker = 'const diagnosticStateKeys = [';
        assert.equal(body.split(marker).length, 2);
        body = body.replace(marker, '(' + pipelineObserver.owner.toString() + ')();\n' + marker);
        const versioned = "const versioned = name => name + '?v=' + assets.versions[name];";
        assert.equal(body.split(versioned).length, 2);
        body = body.replace(versioned, 'const versioned = name => name === assets.runtime ? ' +
          JSON.stringify(diagnosticUrl) + " : name + '?v=' + assets.versions[name];");
      }
      await route.fulfill({response, body:
        (gpuTimestamps?'('+require('./web-performance-capture-observer.cjs').toString()+')();\n':'')+
        '(' + presents.toString() + ')();\n' +
        (passCounts?'('+require('./web-render-pass-counts.cjs').toString()+')();\n':'')+
        (bufferLifecycle?'('+require('./web-buffer-lifecycle-observer.cjs').toString()+')();\n':'')+
        (gpuProbe ? '(' + gpuCompletions.toString() + ')();\n' : '') + body});
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
    run.url = `http://127.0.0.1:8765/build/${folder}/index.html?occlusion=${occlusionMode}&clock=${clock}&gpuahead=${ahead}&gpumode=${budgetMode}&rhiwake=${rhiWake}`+
      (frameBudget?'&framebudget='+frameBudget:'');
    if (packagedInput) run.url += '&input=' + inputMode;
    if (defaultSettings) run.url = `http://127.0.0.1:8765/build/${folder}/index.html`;
    await page.goto(run.url, {waitUntil: 'commit'});
    await page.bringToFront();
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      (globalThis.__webEngineFrames >= 200 && globalThis.__webTextureStreaming?.pending === 0 &&
        (!globalThis.__webPSOPrecacheExpected || globalThis.__webPSOPrecacheReady)),
    null, {timeout: 180000});
    const startupFailure = await page.evaluate(() => globalThis.__webEngineFailure);
    assert(!startupFailure, startupFailure);
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')); assert(owner);
    run.inputBridge = await page.evaluate(() => __webInputBridge);
    run.precache = await page.evaluate(() => ({expected: globalThis.__webPSOPrecacheExpected,
      ready: globalThis.__webPSOPrecacheReady}));
    assert.equal(run.inputBridge.mode, inputMode);
    const state = () => owner.evaluate(() => ({time: performance.now(), frame: __webRHIFrames,
      game: __webEngineFrames, stages: __webThreadStages, camera: __webDefaultCamera,
      clock: __webGameFrameClock, history: __webOcclusionHistory, occlusion: __webOcclusionRHI,
      view: __webRenderView, settings: __webProjectSettings, stream: __webTextureStreaming,
      rhiWake: __webRHIWakeScheduler, pso: globalThis.__webPSOPrecache,
      optimization: globalThis.__webOptimizationRHI,
      renderPassCounts:globalThis.__webRenderPassCounts,
      bufferLifecycle:globalThis.__webBufferLifecycle,
      stagingReadbackPool:globalThis.__webStagingReadbackPool,
      budget: globalThis.__webLocalFrameBudget,
      ownerBudget: frameScheduler?Array.from(frameScheduler.state):null,
      gpu: globalThis.__clockMotionGPU && {submitted: __clockMotionGPU.submitted,
        completed: __clockMotionGPU.completed, peak: __clockMotionGPU.peak}}));
    run.spawn = (await state()).camera;
    if(resetInput)assert.equal(await page.evaluate(()=>__webEngineRPC('WebMotionBenchmarkControl',4,0)),1);
    if(shadowCacheProbe)assert.equal(await page.evaluate(()=>__webEngineRPC('WebLightingQualityTest',11,256)),1);
    await page.evaluate(motionStart, {duration,mouseOnly});
    await page.waitForFunction(() => __clockMotionInput.done, null, {timeout: (duration + 30) * 1000});
    await page.waitForTimeout(1000);
    if(resetInput){
      assert.equal(await page.evaluate(()=>__webEngineRPC('WebMotionBenchmarkControl',5,0)),1);
      await page.waitForTimeout(1000);
      const camera=(await state()).camera;
      assert(Math.hypot(camera.x-run.spawn.x,camera.y-run.spawn.y,camera.z-run.spawn.z)<1);
      assert(Math.abs(((camera.yaw-run.spawn.yaw+540)%360)-180)<.5,'Mouse phases must start from the same pawn camera');
    }
    run.before = await state();
    assert.equal(run.before.clock.mode, clock);
    if (ahead) assert.equal(run.before.budget.maxAhead, ahead);
    if (budgetMode === 'pipeline') assert.equal(run.before.budget.mode, budgetMode);
    assert.equal(run.before.history.enabled, true);
    await owner.evaluate(() => {__clockMotionFrames.times = []; __clockMotionFrames.active = true;});
    if (pipeline) await owner.evaluate(() => {
      __webPipelineCapture.start = performance.timeOrigin + performance.now();
      __webPipelineCapture.active = true;
    });
    let traceComplete;
    if (chromeTrace) {
      traceComplete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
      await cdp.send('Tracing.start', {categories: dawnTrace ?
        'toplevel,blink.user_timing,gpu,gpu.dawn,gpu.dawn.validation,gpu.dawn.recording,gpu.dawn.gpu_work,disabled-by-default-gpu.dawn' : stallTrace ?
        'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc' : 'cc,viz,benchmark,blink.user_timing',
        transferMode: 'ReturnAsStream'});
      await page.evaluate(() => performance.mark('UE motion trace start'));
      run.ownerTraceStart=await owner.evaluate(()=>{performance.mark('UE mouse owner start');return performance.now();});
    }
    await page.evaluate(motionStart, {duration,mouseOnly});
    while (!await page.evaluate(() => __clockMotionInput.done)) {
      await page.waitForTimeout(500);
      run.samples.push({state: await state(), input: await page.evaluate(() => __webInputBridge),
        hud: await page.evaluate(() => __webLivePerformance)});
      if(gpuTimestamps) {
        const frame=await owner.evaluate(()=>__webCaptureGPUFrame());
        assert(!frame.unsupported&&frame.entries.length>0);
        (run.gpuTimestampFrames||=[]).push(frame);
      }
    }
    run.measurement = await owner.evaluate(() => {
      __clockMotionFrames.active = false; return __clockMotionFrames.times;
    });
    run.after = await state();
    if(gpuTimestamps)assert.deepEqual(await owner.evaluate(()=>__webPerformanceCapture.errors),[]);
    if(occlusionMode==='hzb')assert(run.after.history.hzbCompleted>run.before.history.hzbCompleted);
    if(frameBudget){assert(run.after.ownerBudget[3]<=frameBudget&&run.after.ownerBudget[5]<=frameBudget);
      assert(run.after.ownerBudget[7]<=2);}
    const runtimeFailure = await page.evaluate(() => globalThis.__webEngineFailure);
    assert(!runtimeFailure, runtimeFailure);
    if (budgetMode === 'pipeline') assert(run.after.budget.peak <= ahead, 'Pipeline budget overshot');
    if (chromeTrace) {
      await page.evaluate(() => performance.mark('UE motion trace end'));
      await cdp.send('Tracing.end');
      const {stream} = await traceComplete, file = output + '-' + run.index + '-trace.json';
      const descriptor = fs.openSync(file, 'w');
      try {
        for (;;) {
          const chunk = await cdp.send('IO.read', {handle: stream, size: 1024 * 1024});
          fs.writeSync(descriptor, Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
          if (chunk.eof) break;
        }
      } finally {fs.closeSync(descriptor); await cdp.send('IO.close', {handle: stream});}
      run.trace = audit(file);
    }
    if (pipeline) {
      await owner.evaluate(() => {
        __webPipelineCapture.active = false;
        __webPipelineCapture.end = performance.timeOrigin + performance.now();
      });
      await page.waitForTimeout(500);
      run.pipeline = await owner.evaluate(async () => {
        const channel = new MessageChannel();
        const game = await new Promise(resolve => {
          channel.port1.onmessage = ({data}) => {channel.port1.close(); resolve(data);};
          __webGameThreadWorker.postMessage({type: 'web-pipeline-read', port: channel.port2}, [channel.port2]);
        });
        return {...__webPipelineCapture, game};
      });
      const {start, end} = run.pipeline;
      run.pipeline.game.frames = run.pipeline.game.frames.filter(frame => frame.begin >= start && frame.begin <= end);
      assert(run.pipeline.game.frames.length > 20 && run.pipeline.tasks.length > 20 && run.pipeline.gpu.length > 20);
    }
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
    // Villa's camera is offset from its yaw pivot; mouse-only turning traces
    // an ~80 cm orbit. Do not replace that real input path with a fixed camera.
    const cameraRadius=Math.max(...cameras.map(v=>Math.hypot(v.x-run.spawn.x,v.y-run.spawn.y,v.z-run.spawn.z)));
    assert((mouseOnly?cameraRadius<100:run.travel>10)&&run.turn>30,'Camera must follow the requested input motion');
    run.cameraRadius=cameraRadius;
    assert.deepEqual(run.errors, []);
    assert.deepEqual(run.before.settings, run.after.settings);
    if(run.after.history?.groupMotionQueries)
      assert(run.after.history.motionQueriesGrouped>run.before.history.motionQueriesGrouped,'Motion query batching must actually run');
    if(run.after.history?.motionGroupHoldMs>0)
      assert(run.after.history.motionGroupHoldRequests>run.before.history.motionGroupHoldRequests,'Brief input gaps must exercise query grouping hold');
    if(run.after.history?.groupNewMotionQueries)
      assert(run.after.history.newMotionGroupRequests>run.before.history.newMotionGroupRequests,'Newly considered primitives must exercise motion grouping');
    await page.locator('canvas').screenshot({path: output + '-' + run.index + '-' + mode + '.png'});
    if (visibilityCheck && (ahead || frameBudget)) {
      // This automated Edge session reports all tabs as visible. Exercise the
      // real host visibility handler explicitly; this is not OS tab freezing.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(pageClock => document.hidden && (pageClock || __webGameFrameClock.paused), !!frameBudget,
        {timeout: 10000, polling: 100});
      await page.waitForTimeout(1000);
      const paused = await state();
      await page.waitForTimeout(300);
      assert.equal((await state()).frame, paused.frame, 'Hidden Game clock must stop frame production');
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(({frame,pageClock}) => !document.hidden && (pageClock || !__webGameFrameClock.paused) &&
        __webEngineFrames > frame + 10, {frame:paused.game,pageClock:!!frameBudget}, {timeout: 10000});
      run.visibility = {method: 'synthetic-document-visibility-event',
        paused: paused.frame, resumed: (await state()).frame};
    }
    if(profileWorkers){
      await page.evaluate(motionStart,{duration:12,mouseOnly});
      run.profiles=await require('./web-worker-cpu-profiler.cjs')(context,output+'-'+run.index+'-mouse-cpu',8);
      await page.waitForFunction(()=>__clockMotionInput.done,null,{timeout:20000});
    }
    if(recoveryCheck){
      await page.waitForTimeout(1500);
      const before=await state();
      await page.waitForTimeout(2500);
      const after=await state();
      assert.deepEqual(after.camera,before.camera,'Recovery must be stationary');
      assert.equal(after.history.motionQueriesSkipped,before.history.motionQueriesSkipped,'Stationary queries must resume immediately');
      if(after.history.motionQueriesGrouped!==undefined)
        assert.equal(after.history.motionQueriesGrouped,before.history.motionQueriesGrouped,'Motion grouping must stop while stationary');
      if(occlusionMode==='hzb')assert(after.history.hzbCompleted>before.history.hzbCompleted);
      else assert(after.history.queryCaptured>before.history.queryCaptured);
      assert(after.history.hits>before.history.hits&&after.history.zero>before.history.zero);
      run.recovery={before,after};
    }
    assert.deepEqual(run.errors,[]);
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
