'use strict';
// Compare the shipped packages and isolate the retained scene opt-in flag.
// Observe viewport submissions only: no GPU wrappers, profiler or frozen clocks.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const modes = (option('modes') || 'legacy,off,no-scene').split(',');
assert(modes.every(m => ['legacy', 'off', 'no-scene'].includes(m)));
const tag = option('tag') || 'nanite-off-regression-20261111';
assert(/^[a-z0-9-]+$/.test(tag));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(path.join(output, 'report.json')), 'Use a new result tag');
fs.mkdirSync(output, {recursive: true});
fs.copyFileSync(__filename, path.join(output, 'source.cjs'));
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), runs: [],
  boundary: 'Serial fresh Edge contexts at 1280x720 DPR 1. Viewport submission intervals, not physical display timestamps. '
    + 'All intervals retained, including stalls. No-scene changes only the HTML -WebNaniteScene argument of the shipped Nanite-off package. '
    + 'Legacy also has different runtime and Cook, so its difference cannot be assigned to one code change. '
    + 'Mouse-only DOM input follows the same absolute trajectory; actual camera state and event count are retained.'};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function installObserver() {
  const state = globalThis.__naniteOffFrames = {active: false, times: []};
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true,
    get: () => count, set(next) {
      if (state.active && next > count) state.times.push(performance.now());
      count = next;
    }});
}
function mouseMotion(seconds) {
  const canvas = document.querySelector('canvas'); canvas.focus();
  const state = globalThis.__naniteOffMotion = {start: performance.now(), events: 0, done: false};
  const mouse = (type, dx) => canvas.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true,
    button: 2, buttons: type === 'mouseup' ? 0 : 2, clientX: innerWidth / 2, clientY: innerHeight / 2,
    movementX: dx, movementY: 0}));
  mouse('mousedown', 0); let previous = 0;
  const timer = setInterval(() => {
    const elapsed = (performance.now() - state.start) / 1000;
    if (elapsed >= seconds) {
      mouse('mousemove', -previous); mouse('mouseup', 0); clearInterval(timer);
      state.done = true; state.end = performance.now(); return;
    }
    const x = Math.round(650 * Math.sin(elapsed * Math.PI / 4));
    mouse('mousemove', x - previous); previous = x; state.events++;
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
      const folder = mode === 'legacy' ? 'villa-default-20261107' : 'villa-nanite-off-20261111';
      const run = {index, mode, folder, errors: [], phases: [], assets: []}; report.runs.push(run);
      for (const file of ['index.html', 'asset-versions.json', 'config-files.json'])
        run.assets.push(audit(path.join(__dirname, 'build', folder, file)));
      const context = await chromium.launchPersistentContext(
        `C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}-${index}`, {
          channel: 'msedge', headless: true, viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      const log = fs.createWriteStream(path.join(output, index + '-' + mode + '.log'));
      try {
        run.browser = context.browser().version();
        await context.route('**/web-engine-worker.js?*', async route => {
          const response = await route.fetch();
          await route.fulfill({response, body: `(${installObserver.toString()})();\n` + await response.text()});
        });
        if (mode === 'no-scene') await context.route('**/index.html', async route => {
          const response = await route.fetch(), html = await response.text();
          assert(html.includes('"-WebNaniteScene",'));
          await route.fulfill({response, body: html.replace('"-WebNaniteScene",', '')});
        });
        const page = context.pages()[0];
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
          const before = await snapshot();
          await owner.evaluate(() => {__naniteOffFrames.times = []; __naniteOffFrames.active = true;});
          await action();
          const times = await owner.evaluate(() => {__naniteOffFrames.active = false; return __naniteOffFrames.times;});
          const after = await snapshot();
          for (const s of [before, after]) {
            assert(!s.failure && !s.visualClock?.renderTimeFrozen && !s.visualClock?.materialTimeFrozen);
            assert.equal(s.view.outputWidth, 1280); assert.equal(s.view.outputHeight, 720);
          }
          const result = statistics(times);
          result.rhiMs = (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) /
            (after.stages.presented - before.stages.presented);
          run.phases.push({name, before, after, result, times}); save();
          console.log(JSON.stringify({index, mode, name, ...result}));
        }
        const motion = async seconds => {
          await page.evaluate(mouseMotion, seconds);
          await page.waitForFunction(() => __naniteOffMotion.done, null, {timeout: (seconds + 30) * 1000});
        };
        await page.waitForTimeout(10000);
        run.initial = await snapshot();
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
