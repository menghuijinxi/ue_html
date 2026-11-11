'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const output = path.join(__dirname, 'results/villa-nanite-off-20261111');
fs.mkdirSync(output, {recursive: true});
const packageFile = path.join(__dirname, 'results/villa-nanite-off-20261111-package.json');
const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const report = {pass: false, date: new Date().toISOString(), source: audit(__filename), package: audit(packageFile),
  url: packaged.url, runs: [], errors: [],
  boundary: 'Unmodified startup configuration, no runtime Nanite toggle. Scene step 1 observes native disabled state only. '
    + 'Reload must remain disabled. Normal clocks and original spawn; startup, input and resize smoke test, not full performance acceptance.'};
let context, page, owner, log;
const snapshot = () => page.evaluate(() => ({time: performance.now(), frame: globalThis.__webEngineFrames,
  stages: globalThis.__webThreadStages, camera: globalThis.__webDefaultCamera, view: globalThis.__webRenderView,
  settings: globalThis.__webProjectSettings, failure: globalThis.__webEngineFailure}));
(async () => {
  try {
    assert(packaged.pass); packaged.products.forEach(p => assert.equal(audit(p.file).sha256, p.sha256));
    context = await chromium.launchPersistentContext(
      'C:/Users/wap80/.cache/ue-html-build-archive/nanite-core-browser/user-profile-effect-20261111',
      {channel: 'msedge', headless: true, viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    page = context.pages()[0]; log = fs.createWriteStream(path.join(output, 'browser.log'));
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('crash', () => report.errors.push('Page crashed'));
    page.on('console', m => {
      log.write(m.text() + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) report.errors.push(m.text());
    });
    for (let run = 0; run < 2; ++run) {
      if (run) await page.reload({waitUntil: 'commit'}); else await page.goto(report.url, {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady), null, {timeout: 300000});
      assert(!(await snapshot()).failure);
      owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
      const clock = await owner.evaluate(() => globalThis.__webVisualTestClock || null);
      assert(!clock?.materialTimeFrozen && !clock?.renderTimeFrozen);
      const before = await snapshot(); await page.waitForTimeout(10000); const after = await snapshot();
      const frames = after.stages.presented - before.stages.presented;
      assert(frames > 0 && !after.failure);
      assert.equal(await page.evaluate(() => __webEngineRPC('WebNaniteAutomaticSceneTest', 1)), 1);
      let state; const deadline = Date.now() + 120000;
      do {
        await page.waitForTimeout(200);
        await page.evaluate(() => __webEngineRPC('WebNaniteAutomaticSceneTest', 0));
        state = await owner.evaluate(() => globalThis.__webNaniteAutomaticSceneTest || null);
      } while (state?.step !== 1 && Date.now() < deadline);
      assert.equal(state?.step, 1); assert.equal(state.enabled, false);
      assert.equal(state.registered, 0); assert.equal(state.entries, 0);
      assert(state.assets.length >= 2062 && state.assets.every(a => a.fallbackTriangles > 0));
      const stateFile = path.join(output, `run-${run}-nanite.json`);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      const initial = await snapshot();
      await page.keyboard.down('w'); await page.waitForTimeout(600); await page.keyboard.up('w');
      await page.waitForTimeout(600); const moved = await snapshot();
      const distance = Math.hypot(...['x', 'y', 'z'].map(k => moved.camera[k] - initial.camera[k]));
      assert(distance > 5, 'Real scene input must work');
      await page.setViewportSize({width: 1600, height: 900});
      await page.waitForFunction(() => globalThis.__webRenderView?.outputWidth === 1600 &&
        globalThis.__webRenderView?.outputHeight === 900, null, {timeout: 30000});
      report.runs.push({run, clock, before, after, fps: frames * 1000 / (after.time - before.time),
        nanite: {enabled: state.enabled, registered: state.registered, entries: state.entries, assets: state.assets.length, report: audit(stateFile)},
        movementCm: distance, resized: await snapshot()});
      console.log({run, fps: report.runs.at(-1).fps, enabled: state.enabled, registered: state.registered, movementCm: distance});
      await page.screenshot({path: path.join(output, `run-${run}.png`)});
      await page.setViewportSize({width: 1280, height: 720});
    }
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (e) {
    report.failure = e.stack; console.error(e.stack); process.exitCode = 1;
  } finally {
    await context?.close(); log?.end();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log({pass: report.pass, url: report.url, failure: report.failure});
  }
})();
