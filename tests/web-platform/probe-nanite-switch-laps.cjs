'use strict';
// Alternates one integer console variable between laps of the interior tour
// inside a single browser session. Separate sessions differ by several percent
// with the state of the desktop (which window is in front, what else runs), so
// a setting worth a few percent is compared here lap against lap instead.
// The first laps warm textures and pipelines and are not compared. This is a
// steady-state comparison: it has no first-visit stalls and is not the
// first-tour acceptance number.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const sampleEnvironment = require('./sample-test-environment.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
// Index is the Id of WebNaniteTestSwitch in WebNaniteAutomaticSceneTest.cpp.
const switches = ['r.Web.OcclusionMergeBoundsChanges', 'r.Nanite.WebHZB', 'r.RDG.Validation',
  'r.Nanite.WebShadeBinning', 'r.Nanite.WebMergeProgrammableRaster', 'r.Nanite.WebMergeFixedRaster', 'r.Nanite.WebHZBAutoClusters', 'r.Nanite', 'r.Nanite.WebBatchInstances'];
const folder = option('folder'), tag = option('tag'), name = option('switch'), id = switches.indexOf(name);
assert([folder, tag].every(n => /^[a-z0-9-]+$/.test(n || '')), 'usage: --folder= --tag= --switch=<cvar> --values=a,b,b,a');
assert(id >= 0, 'Unknown switch; known: ' + switches.join(', '));
const values = (option('values') || '0,1,1,0').split(',').map(Number);
assert(values.length >= 2 && values.length <= 12 && values.every(v => Number.isInteger(v) && v >= 0));
const seconds = Number(option('seconds') || 60), warmupLaps = Number(option('warmup-laps') || 1);
// Uncompared laps run first, by default with the first value. Give both values when each state needs its own first visit.
const warmupValues = option('warmup-values') ? option('warmup-values').split(',').map(Number) : Array(warmupLaps).fill(values[0]);
assert(warmupValues.every(v => Number.isInteger(v) && v >= 0));
const width = Number(option('width') || 2560), height = Number(option('height') || 1440);
const still = process.argv.includes('--still'); // hold the spawn view instead of touring
const cvars = (option('cvars') || '').split(',').filter(Boolean).map(v => v.split('='));
assert(cvars.every(v => v.length === 2 && /^[A-Za-z0-9_.]+$/.test(v[0]) && /^-?[0-9.]+$/.test(v[1])));
const output = path.join(__dirname, 'results', tag); assert(!fs.existsSync(output), 'Use a new result tag'); fs.mkdirSync(output);
fs.copyFileSync(__filename, path.join(output, 'source.cjs'));
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), folder, switch: name, values, seconds, warmupValues, still, width, height, cvars, laps: [], errors: [],
  boundary: 'One visible Edge session, normal clocks, no profiler or WebGPU wrapper. ' + (still ? 'Still spawn view. ' : 'Repeated interior tour laps. ')
    + 'Warm-up laps are not compared. The switch is set by code between laps; every lap records the desktop state before and after. '
    + 'Steady-state A/B of one setting, not first-tour acceptance.'};
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
function installObserver() {
  const state = globalThis.__lapFrames = {active: false, times: []};
  let count = 0;
  Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, enumerable: true, get: () => count,
    set(next) { if (state.active && next > count) state.times.push(performance.now()); count = next; }});
}
function statistics(times) {
  const intervals = times.slice(1).map((v, i) => v - times[i]); assert(intervals.length > 50);
  const sorted = intervals.toSorted((a, b) => a - b), tail = sorted.slice(-Math.ceil(sorted.length / 100));
  return {frames: intervals.length, fps: 1000 * intervals.length / (times.at(-1) - times[0]), low1Fps: 1000 * tail.length / tail.reduce((a, b) => a + b, 0),
    p50Ms: sorted[Math.floor(sorted.length * .5)], p95Ms: sorted[Math.floor(sorted.length * .95)], p99Ms: sorted[Math.floor(sorted.length * .99)],
    maxMs: sorted.at(-1), over33Ms: intervals.filter(v => v > 1000 / 30).length};
}
(async () => {
  let context;
  try {
    report.package = audit(path.join(__dirname, 'build', folder, 'package.json'));
    context = await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}`, {
      channel: 'msedge', headless: false, viewport: {width, height}, deviceScaleFactor: 1});
    if (cvars.length) await context.route('**/config-files.json*', async route => {
      const response = await route.fetch(), files = await response.json();
      const file = files.find(f => f.path === '/Engine/Platforms/Web/Config/WebEngine.ini'); assert(file);
      const data = Buffer.from(Buffer.from(file.data, 'base64').toString() + '\n[SystemSettings]\n' + cvars.map(v => v.join('=')).join('\n') + '\n');
      file.data = data.toString('base64'); file.sha256 = crypto.createHash('sha256').update(data).digest('hex');
      report.startupConfig = {path: file.path, sha256: file.sha256, settings: cvars};
      await route.fulfill({response, body: JSON.stringify(files)});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${installObserver.toString()})();\n` + await response.text()});
    });
    const page = context.pages()[0];
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) report.errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady), null, {timeout: 300000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    const rpc = (fn, ...args) => page.evaluate(a => __webEngineRPC(a[0], ...a.slice(1)), [fn, ...args]);
    await page.waitForTimeout(10000);
    const stages = () => owner.evaluate(() => ({rhi: globalThis.__webThreadStages?.rhiWorkMilliseconds, render: globalThis.__webThreadStages?.renderWorkMilliseconds,
      clock: globalThis.__webVisualTestClock}));
    let snapshots = 0;
    async function lap(value, compared) {
      assert.equal(await rpc('WebNaniteTestSwitch', id, value), 1);
      await page.waitForTimeout(name === 'r.Nanite' ? 8000 : 1500); // r.Nanite rebuilds every proxy
      const record = {index: report.laps.length, value, compared}; report.laps.push(record);
      if (name === 'r.Nanite') {
        // Confirm from the renderer, before the lap, that the proxies really switched.
        assert.equal(await rpc('WebNaniteAutomaticSceneTest', ++snapshots), 1); let state; const start = Date.now();
        do { await page.waitForTimeout(100); assert.equal(await rpc('WebNaniteAutomaticSceneTest', 0), 1); state = await owner.evaluate(() => globalThis.__webNaniteAutomaticSceneTest); }
        while (state?.step !== snapshots && Date.now() - start < 120000);
        assert.equal(state?.step, snapshots); assert.equal(state.enabled, !!value);
        if (value) assert(state.entries > 1 && state.registered > 1); else { assert.equal(state.entries, 0); assert.equal(state.registered, 0); }
        record.nanite = {enabled: state.enabled, registered: state.registered, entries: state.entries};
        await page.waitForTimeout(1000);
      }
      record.environmentBefore = await sampleEnvironment(page);
      const before = await stages(); assert(!before.clock?.renderTimeFrozen);
      await owner.evaluate(() => { const s = globalThis.__lapFrames; s.times = []; s.active = true; });
      if (still) await page.waitForTimeout(seconds * 1000);
      else {
        const serial = await rpc('WebMotionBenchmarkControl', 3, seconds); assert(serial > 0);
        // The published state lags the call; match this lap's serial, not the previous lap's completed state.
        await page.waitForFunction(s => globalThis.__webMotionBenchmark?.serial === s && globalThis.__webMotionBenchmark.completed &&
          !globalThis.__webMotionBenchmark.active, serial, {timeout: (seconds + 60) * 1000});
        record.motion = await page.evaluate(() => globalThis.__webMotionBenchmark);
        assert(record.motion.elapsed >= seconds * .98, 'The lap must run its full duration');
      }
      const times = await owner.evaluate(() => { const s = globalThis.__lapFrames; s.active = false; return s.times; });
      const after = await stages();
      Object.assign(record, statistics(times));
      record.rhiMs = (after.rhi - before.rhi) / record.frames; record.renderMs = (after.render - before.render) / record.frames;
      record.environmentAfter = await sampleEnvironment(page);
      assert.deepEqual(report.errors, []); save();
      console.log(JSON.stringify({lap: record.index, value, compared, fps: +record.fps.toFixed(2), low1Fps: +record.low1Fps.toFixed(1), rhiMs: +record.rhiMs.toFixed(2),
        renderMs: +record.renderMs.toFixed(2), foreground: [record.environmentBefore.desktop?.foregroundProcess, record.environmentAfter.desktop?.foregroundProcess]}));
    }
    for (const value of warmupValues) await lap(value, false);
    for (const value of values) await lap(value, true);
    assert.equal(await rpc('WebNaniteTestSwitch', id, -1), 1);
    if (snapshots) assert.equal(await rpc('WebNaniteAutomaticSceneTest', -1), 1);
    // Each value's mean over its compared laps; with a symmetric order (A,B,B,A) a steady drift cancels.
    report.summary = Object.fromEntries([...new Set(values)].map(v => {
      const rows = report.laps.filter(l => l.compared && l.value === v), mean = k => rows.reduce((sum, r) => sum + r[k], 0) / rows.length;
      return [v, {laps: rows.length, fps: mean('fps'), low1Fps: mean('low1Fps'), frameMs: rows.reduce((sum, r) => sum + 1000 / r.fps, 0) / rows.length,
        rhiMs: mean('rhiMs'), renderMs: mean('renderMs'), fpsRange: [Math.min(...rows.map(r => r.fps)), Math.max(...rows.map(r => r.fps))]}];
    }));
    report.foregroundProcesses = [...new Set(report.laps.filter(l => l.compared).flatMap(l => [l.environmentBefore.desktop?.foregroundProcess, l.environmentAfter.desktop?.foregroundProcess]))];
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (e) { report.failure = e.stack; process.exitCode = 1; console.error(e.stack); }
  finally { await context?.close(); save(); console.log(JSON.stringify({pass: report.pass, output, summary: report.summary, foregroundProcesses: report.foregroundProcesses})); }
})();
