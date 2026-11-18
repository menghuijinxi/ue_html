'use strict';
// Reconcile the historical 720p room/wall result with the delivered spawn view.
// Keep the native r.Nanite toggle and observer identical across every window.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const tag = 'nanite-fallback-baseline-20261111';
const output = path.join(__dirname, 'results', tag);
fs.mkdirSync(output, {recursive: true});
const profile = `C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/${tag}`;
const report = {pass: false, date: new Date().toISOString(), source: audit(__filename),
  manifest: audit(path.join(__dirname, 'build/nanite-release-20261111/manifest.json')),
  url: 'http://127.0.0.1:8766/villa/index.html', headless: true, dpr: 1, samples: [], nanite: [], errors: [],
  boundary: 'Unchanged release files, advancing clocks, no CPU profiler or GPU method wrappers. '
    + 'Nanite remains disabled after a verified native toggle. Resolution and camera are the only subsequent variables. '
    + 'Spawn samples retain the original player camera; room/wall use the exact historical camera RPC and coordinates. '
    + 'Historical and current binaries and sampling durations differ, so this is not an isolated revision regression test.'};
let context, page, owner, log;
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const snapshot = () => owner.evaluate(() => ({time: performance.now(), frame: globalThis.__webEngineFrames,
  stages: globalThis.__webThreadStages, view: globalThis.__webRenderView,
  camera: globalThis.__webDefaultCamera, settings: globalThis.__webProjectSettings,
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
  assert.deepEqual(before.camera, after.camera);
  assert.deepEqual(before.settings, after.settings);
  const frames = after.stages.presented - before.stages.presented, milliseconds = after.time - before.time;
  assert(frames > 0 && milliseconds >= 20000);
  const sample = {name, requestedCamera: camera || null, before, after, frames, milliseconds,
    fps: frames * 1000 / milliseconds,
    rhiMs: (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) / frames};
  report.samples.push(sample); save();
  console.log(JSON.stringify({name, fps: sample.fps, rhiMs: sample.rhiMs, camera: after.camera, view: after.view}));
  await page.screenshot({path: path.join(output, name + '.png')});
}
async function inspect(step) {
  assert.equal(await page.evaluate(s => __webEngineRPC('WebNaniteAutomaticSceneTest', s), step), 1);
  let value; const deadline = Date.now() + 180000;
  do {
    await page.waitForTimeout(200);
    await page.evaluate(() => __webEngineRPC('WebNaniteAutomaticSceneTest', 0));
    value = await owner.evaluate(() => globalThis.__webNaniteAutomaticSceneTest || null);
  } while (value?.step !== step && Date.now() < deadline);
  assert.equal(value?.step, step); assert.equal(value.enabled, step === 1);
  assert.equal(value.registered, step === 1 ? 2062 : 0);
  if (step === 2) assert.equal(value.entries, 0);
  const file = path.join(output, `nanite-${step}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  report.nanite.push({step, enabled: value.enabled, registered: value.registered, entries: value.entries, report: audit(file)});
  save();
}
(async () => {
  try {
    context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    report.browserVersion = context.browser().version();
    page = context.pages()[0];
    log = fs.createWriteStream(path.join(output, 'browser.log'));
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
    await inspect(1); await inspect(2);
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
