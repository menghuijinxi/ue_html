'use strict';
// Compare the shipped packages and isolate the retained scene opt-in flag.
// Default performance runs observe viewport submissions without GPU wrappers or
// frozen clocks. Explicit diagnostic switches are recorded separately.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const modes = (option('modes') || 'legacy,off,no-scene').split(',');
const candidateFolder = option('folder');
const baselineFolder = option('baseline-folder');assert(!baselineFolder||/^[a-z0-9-]+$/.test(baselineFolder));
assert(modes.every(m => ['legacy', 'off', 'no-scene','candidate'].includes(m)));
assert(!modes.includes('candidate') || /^[a-z0-9-]+$/.test(candidateFolder));
const tour = process.argv.includes('--tour');
const walk = process.argv.includes('--walk') || tour, headed = process.argv.includes('--headed');
const trace = process.argv.includes('--trace'), gpuProbe = process.argv.includes('--gpu-probe');
const traceStart = Number(option('trace-start') || 0), traceSeconds = Number(option('trace-seconds') || 0);
const gpuTimestamps = process.argv.includes('--gpu-timestamps');
const observeMotionGPU = gpuTimestamps ? require('./observe-nanite-motion-gpu.cjs') : null;
const pointOnly = process.argv.includes('--shadow-point-only');
const pointDiagnostic = pointOnly ? require('./diagnose-point-shadow-vsm.cjs') : null;
assert(!pointOnly || modes.every(m=>m==='off'));
assert(!trace || walk); assert(!gpuProbe || walk);
const width = Number(option('width') || 1280), height = Number(option('height') || 720);
const seconds = Number(option('seconds') || 60);
assert(Number.isInteger(width) && width >= 640 && width <= 3840);
assert(Number.isInteger(height) && height >= 480 && height <= 2160);
assert(Number.isFinite(seconds) && seconds >= 16 && seconds <= 180);
assert(!tour || seconds <= 60);
const tag = option('tag') || 'nanite-off-regression-20261111';
assert(/^[a-z0-9-]+$/.test(tag));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(path.join(output, 'report.json')), 'Use a new result tag');
fs.mkdirSync(output, {recursive: true});
fs.copyFileSync(__filename, path.join(output, 'source.cjs'));
if (gpuTimestamps) fs.copyFileSync(require.resolve('./observe-nanite-motion-gpu.cjs'), path.join(output,'gpu-observer.cjs'));
if (pointOnly) fs.copyFileSync(require.resolve('./diagnose-point-shadow-vsm.cjs'), path.join(output,'point-diagnostic.cjs'));
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), baselineFolder, walk, tour, headed, trace, traceStart, traceSeconds, gpuProbe, gpuTimestamps, pointOnly, width, height, seconds, runs: [],
  boundary: 'Serial fresh Edge contexts at the recorded viewport, DPR 1. Viewport submission intervals, not physical display timestamps. '
    + 'All intervals retained, including stalls. No-scene changes only the HTML -WebNaniteScene argument of the shipped Nanite-off package. '
    + 'Legacy also has different runtime and Cook, so its difference cannot be assigned to one code change. '
    + (tour ? 'Existing native game-frame camera tour through the interior: simultaneous position and rotation, without keyboard input or route warmup. ' : walk ?
      'Simultaneous keyboard movement and horizontal/vertical mouse input through the packaged bridge. First movement is measured without a route warmup. '
      + 'Identical requested inputs do not guarantee identical world trajectories; sampled camera coordinates are retained.' :
      'Mouse-only DOM input follows the same absolute trajectory; actual camera state and event count are retained.')};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
if(baselineFolder)report.boundary+=' Explicit baseline-folder overrides the predefined baseline directories; mode names do not change its r.Nanite setting. Compare recorded package/configuration provenance.';
function installObserver(detailed) {
  const state = globalThis.__naniteOffFrames = {active: false, times: [], frames: [], samples: [], gpu: []};
  let sampled = 0;
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => count, set(next) {
      if (state.active && next > count) {
        const now = performance.now(); state.times.push(now);
        if (detailed) {
          state.frames.push([next, now, globalThis.__webEngineFrames,
            globalThis.__webThreadStages?.rhiWorkMilliseconds, globalThis.__webThreadFrameTimes?.at(-1)]);
          if (now - sampled >= 200) {
            sampled = now;
            state.samples.push({time:now, frame:next, camera:{...globalThis.__webDefaultCamera},
              history:{...globalThis.__webOcclusionHistory}, rhi:{...globalThis.__webOcclusionRHI},
              optimization:{...globalThis.__webOptimizationRHI}, streaming:{...globalThis.__webTextureStreaming},
              io:{...globalThis.__webContentIO?.stats}, stages:{...globalThis.__webThreadStages}});
          }
        }
      }
      count = next;
    }});
}
function mouseMotion(options) {
  const {seconds, walk} = options;
  const canvas = document.querySelector('canvas'); canvas.focus();
  const state = globalThis.__naniteOffMotion = {start: performance.now(), events: 0, done: false, keyEvents:[]};
  const mouse = (type, dx, dy = 0) => canvas.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true,
    button: 2, buttons: type === 'mouseup' ? 0 : 2, clientX: innerWidth / 2, clientY: innerHeight / 2,
    movementX: dx, movementY: dy}));
  const key = (type, value) => {
    state.keyEvents.push({time:performance.now(), type, value});
    canvas.dispatchEvent(new KeyboardEvent(type, {bubbles:true, cancelable:true, key:value.toLowerCase(),
      code:'Key'+value, keyCode:value.charCodeAt(0), which:value.charCodeAt(0)}));
  };
  mouse('mousedown', 0); let previous = 0, previousY = 0, currentKey = null;
  const timer = setInterval(() => {
    const elapsed = (performance.now() - state.start) / 1000;
    if (elapsed >= seconds) {
      if (currentKey) key('keyup', currentKey);
      mouse('mousemove', -previous, -previousY); mouse('mouseup', 0); clearInterval(timer);
      state.done = true; state.end = performance.now(); return;
    }
    const x = Math.round(650 * Math.sin(elapsed * Math.PI / 4));
    const y = walk ? Math.round(65 * Math.sin(elapsed * Math.PI / 3)) : 0;
    const nextKey = walk ? ['W','W','D','S','S','A'][Math.floor(elapsed / 2) % 6] : null;
    if (currentKey !== nextKey) {
      if (currentKey) key('keyup', currentKey);
      if (nextKey) key('keydown', nextKey);
      currentKey = nextKey;
    }
    mouse('mousemove', x - previous, y - previousY); previous = x; previousY = y; state.events++;
  }, 16);
}
function statistics(times) {
  const intervals = times.slice(1).map((v, i) => v - times[i]);
  assert(intervals.length > 50);
  const sorted = intervals.toSorted((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length / 100));
  return {frames: intervals.length, fps: 1000 * intervals.length / (times.at(-1) - times[0]),
    low1Fps: 1000 * tail.length / tail.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)],
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1),
    over33Ms: intervals.filter(v => v > 1000 / 30).length, over50Ms: intervals.filter(v => v > 50).length};
}
(async () => {
  try {
    for (const [index, mode] of modes.entries()) {
      const folder = mode === 'candidate' ? candidateFolder : baselineFolder || (mode === 'legacy' ? 'villa-default-20261107' : 'villa-nanite-off-20261111');
      const run = {index, mode, folder, errors: [], phases: [], assets: []}; report.runs.push(run);
      for (const file of ['index.html', 'asset-versions.json', 'config-files.json'])
        run.assets.push(audit(path.join(__dirname, 'build', folder, file)));
      const context = await chromium.launchPersistentContext(
        `C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}-${index}`, {
          channel: 'msedge', headless: !headed, viewport: {width, height}, deviceScaleFactor: 1});
      const log = fs.createWriteStream(path.join(output, index + '-' + mode + '.log'));
      try {
        run.browser = context.browser().version();
        await context.route('**/web-engine-worker.js?*', async route => {
          const response = await route.fetch();
          let body = await response.text();
          if (gpuProbe) {
            const marker = '  frameScheduler.queue.onSubmittedWorkDone().then(() => {';
            assert.equal(body.split(marker).length, 2);
            body = body.replace(marker, `  const probe = __naniteOffFrames.active ? {sequence:submitted,
    frame:globalThis.__webRHIFrames, submitted:performance.now(), pending:submitted-Atomics.load(state,0)} : null;
  if (probe) __naniteOffFrames.gpu.push(probe);
${marker}
    if (probe) probe.completed = performance.now();`);
          }
          await route.fulfill({response, body: `(${installObserver.toString()})(${walk});\n` +
            (pointOnly ? `(${pointDiagnostic.toString()})();\n` : '') +
            (gpuTimestamps ? `(${observeMotionGPU.toString()})();\n` : '') + body});
        });
        if (mode === 'no-scene') await context.route('**/index.html', async route => {
          const response = await route.fetch(), html = await response.text();
          assert(html.includes('"-WebNaniteScene",'));
          await route.fulfill({response, body: html.replace('"-WebNaniteScene",', '')});
        });
        const page = context.pages()[0];
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setFocusEmulationEnabled', {enabled:true});
        page.on('pageerror', e => run.errors.push(e.message));
        page.on('crash', () => run.errors.push('Page crashed'));
        page.on('console', m => {
          log.write(m.text() + '\n');
          if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) run.errors.push(m.text());
        });
        await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
        await page.waitForFunction(() => globalThis.__webEngineFailure ||
          (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady), null, {timeout: 300000});
        assert(!await page.evaluate(() => globalThis.__webEngineFailure));
        const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
        const snapshot = () => owner.evaluate(() => ({time: performance.now(), stages: globalThis.__webThreadStages,
          frame: globalThis.__webRHIFrames, view: globalThis.__webRenderView, camera: globalThis.__webDefaultCamera,
          settings: globalThis.__webProjectSettings, history: globalThis.__webOcclusionHistory,
          occlusion: globalThis.__webOcclusionRHI, optimization: globalThis.__webOptimizationRHI,
          pool: globalThis.__webStagingReadbackPool, clock: globalThis.__webGameFrameClock,
          visualClock: globalThis.__webVisualTestClock, failure: globalThis.__webEngineFailure}));
        async function measure(name, action) {
          assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
          let traceDone, traceWindowMark;
          const beginTrace = async () => {
            traceDone = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
            await cdp.send('Tracing.start', {categories:'toplevel,devtools.timeline,v8,blink.user_timing,gpu,disabled-by-default-v8.gc,disabled-by-default-gpu.service,disabled-by-default-gpu.dawn',
              transferMode:'ReturnAsStream'});
          };
          if (trace && !traceStart) {
            await beginTrace();
            await page.waitForTimeout(1000);
          }
          const before = await snapshot();
          console.log(JSON.stringify({index, mode, name, status:'measuring', seconds:walk ? seconds : 20}));
          const traceMark = await owner.evaluate(() => {__naniteOffFrames.times = []; __naniteOffFrames.frames = [];
            __naniteOffFrames.samples = []; __naniteOffFrames.gpu = [];
            const time = performance.now(); performance.mark('UE motion capture begin');
            __naniteOffFrames.active = true; return time;});
          const delayedTrace = trace && traceStart ? (async () => {
            assert(traceSeconds > 0 && traceStart + traceSeconds < seconds);
            await page.waitForTimeout(traceStart * 1000); await beginTrace();
            traceWindowMark = await owner.evaluate(() => {const now = performance.now();
              performance.mark('UE motion trace window'); return now;});
            await page.waitForTimeout(traceSeconds * 1000); await cdp.send('Tracing.end');
          })() : null;
          await action(); await delayedTrace;
          const capture = await owner.evaluate(() => {__naniteOffFrames.active = false; return __naniteOffFrames;});
          const {times} = capture;
          const after = await snapshot();
          for (const s of [before, after]) {
            assert(!s.failure && !s.visualClock?.renderTimeFrozen && !s.visualClock?.materialTimeFrozen);
            assert.equal(s.view.outputWidth, width); assert.equal(s.view.outputHeight, height);
          }
          const result = statistics(times);
          result.rhiMs = (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) /
            (after.stages.presented - before.stages.presented);
          const phase = {name, before, after, result, times, traceMark};
          if (walk) {
            phase.frameColumns = ['rhiFrame','time','gameFrame','rhiTotalMs','lastGameMs'];
            phase.frames = capture.frames; phase.samples = capture.samples;
            if (gpuProbe) phase.gpu = capture.gpu;
            const cameras = [before.camera, ...capture.samples.map(s => s.camera), after.camera];
            const distance = (a,b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);
            phase.travelCm = cameras.slice(1).reduce((s,c,i) => s + distance(c,cameras[i]), 0);
            phase.radiusCm = Math.max(...cameras.map(c => distance(c,cameras[0])));
            phase.turnDegrees = cameras.slice(1).reduce((s,c,i) => s + Math.abs((c.yaw-cameras[i].yaw+540)%360-180), 0);
            phase.pitchRange = Math.max(...cameras.map(c=>c.pitch))-Math.min(...cameras.map(c=>c.pitch));
            // The real camera has an approximately 80 cm rotation orbit. Require
            // displacement beyond that orbit to prove keyboard translation.
            assert(phase.radiusCm > 150 && phase.travelCm > 500 && phase.turnDegrees > 180 && phase.pitchRange > 5,
              'Simultaneous translation and camera rotation must actually occur');
          }
          run.phases.push(phase); save();
          console.log(JSON.stringify({index, mode, name, ...result}));
          if (trace) {
            if (!traceStart) await cdp.send('Tracing.end');
            phase.traceWindowMark = traceWindowMark;
            const {stream} = await traceDone;
            const file = path.join(output, `${index}-${mode}-trace.json`), fd = fs.openSync(file,'w');
            try {
              for (;;) {
                const chunk = await cdp.send('IO.read',{handle:stream,size:1024*1024});
                fs.writeSync(fd,Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8'));
                if(chunk.eof)break;
              }
            } finally {fs.closeSync(fd); await cdp.send('IO.close',{handle:stream});}
            phase.trace = audit(file); save();
          }
        }
        const motion = async seconds => {
          await page.evaluate(mouseMotion, {seconds, walk});
          await page.waitForFunction(() => __naniteOffMotion.done, null, {timeout: (seconds + 30) * 1000});
        };
        await page.waitForTimeout(10000);
        run.initial = await snapshot();
        save();
        if (walk) {
          await measure(tour ? 'interior-tour-first' : 'walk-and-turn-first', async () => {
            if (!tour) return motion(seconds);
            assert(await page.evaluate(s => __webEngineRPC('WebMotionBenchmarkControl', 3, s), seconds));
            await page.waitForFunction(() => globalThis.__webMotionBenchmark?.completed &&
              !globalThis.__webMotionBenchmark.active, null, {timeout:(seconds+30)*1000});
          });
          run.motion = await page.evaluate(isTour => isTour ? globalThis.__webMotionBenchmark : __naniteOffMotion, tour);
          if (pointOnly) {
            run.pointDiagnostic = await owner.evaluate(() => globalThis.__pointShadowDiagnostic);
            assert.equal(new Set(run.pointDiagnostic.patched).size,3);
          }
          if (gpuTimestamps) {
            run.gpuTimestamps = await owner.evaluate(() => globalThis.__motionGPU);
            assert.equal(run.gpuTimestamps.pending, 0);
            assert.equal(run.gpuTimestamps.errors.length, 0, run.gpuTimestamps.errors.slice(0,3).join('\n'));
          }
          await page.screenshot({path:path.join(output,index+'-'+mode+'.png')});
          assert.deepEqual(run.errors, []); run.pass = true; save();
          continue;
        }
        await measure('spawn', () => page.waitForTimeout(20000));
        await motion(8); await page.waitForTimeout(1000);
        await measure('mouse', () => motion(16));
        run.motion = await page.evaluate(() => __naniteOffMotion);
        await page.waitForTimeout(500);
        run.returnedCamera = (await snapshot()).camera;
        assert(Math.abs(run.returnedCamera.yaw - run.initial.camera.yaw) < .01);
        assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', -175, -80, 160, -5, 50)), 1);
        await page.waitForTimeout(10000);
        await measure('room', () => page.waitForTimeout(20000));
        await page.screenshot({path: path.join(output, index + '-' + mode + '.png')});
        assert.deepEqual(run.errors, []); run.pass = true; save();
      } finally {await context.close(); log.end();}
    }
    report.pass = true;
  } catch (e) {report.failure = e.stack; process.exitCode = 1; console.error(e.stack);}
  finally {save(); console.log(JSON.stringify({pass: report.pass, output, failure: report.failure}));}
})();
