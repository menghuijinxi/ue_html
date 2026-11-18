'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const folder = 'villa-default-20261107', directory = path.join(__dirname, 'build', folder);
const output = path.join(__dirname, 'results/villa-legacy-baseline-20261111');
fs.mkdirSync(output, {recursive: true});
const profile = 'C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/villa-legacy-baseline-20261111';
const report = {pass: false, date: new Date().toISOString(), source: audit(__filename),
  url: `http://127.0.0.1:8765/build/${folder}/index.html`, headless: true, dpr: 1,
  assets: [], samples: [], errors: [],
  boundary: 'User-specified original November 7 release, unchanged files and arguments. No Nanite test API, '
    + 'GPU method wrappers, CPU profiler or frozen clocks. Same original spawn and historical room/wall '
    + 'camera requests as the current fallback probe, ten-second settling and twenty-second present-count windows.'};
let context, page, owner, log;
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const snapshot = () => owner.evaluate(() => ({time: performance.now(), frame: globalThis.__webEngineFrames,
  stages: globalThis.__webThreadStages, view: globalThis.__webRenderView,
  camera: globalThis.__webDefaultCamera, settings: globalThis.__webProjectSettings,
  occlusion: globalThis.__webOcclusionHistory, rhi: globalThis.__webOcclusionRHI,
  clock: globalThis.__webVisualTestClock || null, failure: globalThis.__webEngineFailure}));
async function measure(name, width, height, camera) {
  await page.setViewportSize({width, height});
  if (camera) assert.equal(await page.evaluate(v => __webEngineRPC('WebProjectViewTest', ...v), camera), 1);
  await page.waitForTimeout(10000);
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  const before = await snapshot();
  await page.waitForTimeout(20000);
  const after = await snapshot();
  for (const state of [before, after]) {
    assert(!state.failure && !state.clock?.renderTimeFrozen && !state.clock?.materialTimeFrozen);
    assert.equal(state.view.outputWidth, width); assert.equal(state.view.outputHeight, height);
  }
  assert.deepEqual(before.camera, after.camera); assert.deepEqual(before.settings, after.settings);
  const frames = after.stages.presented - before.stages.presented, milliseconds = after.time - before.time;
  assert(frames > 0 && milliseconds >= 20000);
  const sample = {name, requestedCamera: camera || null, before, after, frames, milliseconds,
    fps: frames * 1000 / milliseconds,
    rhiMs: (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) / frames};
  report.samples.push(sample); save();
  console.log(JSON.stringify({name, fps: sample.fps, rhiMs: sample.rhiMs, camera: after.camera, view: after.view}));
  await page.screenshot({path: path.join(output, name + '.png')});
}
(async () => {
  try {
    const html = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
    assert(!html.includes('-WebNaniteScene'));
    // Hash before launching so file reads cannot distort a timing window.
    report.assets = fs.readdirSync(directory).filter(f => fs.statSync(path.join(directory, f)).isFile())
      .map(f => audit(path.join(directory, f)));
    context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    report.browserVersion = context.browser().version();
    page = context.pages()[0]; log = fs.createWriteStream(path.join(output, 'browser.log'));
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('crash', () => report.errors.push('Page crashed'));
    page.on('console', m => {
      log.write(m.text() + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) report.errors.push(m.text());
    });
    await page.goto(report.url, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure ||
      (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady), null, {timeout: 300000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    await measure('spawn-720', 1280, 720);
    await measure('spawn-1440', 2560, 1440);
    await measure('room-1440', 2560, 1440, [-175, -80, 160, -5, 50]);
    await measure('room-720', 1280, 720);
    await measure('wall-720', 1280, 720, [-175, -80, 160, -5, 230]);
    await measure('wall-1440', 2560, 1440);
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (e) {
    report.failure = e.stack; console.error(e.stack); process.exitCode = 1;
  } finally {
    await context?.close(); log?.end(); save(); console.log({pass: report.pass, output, failure: report.failure});
  }
})();
