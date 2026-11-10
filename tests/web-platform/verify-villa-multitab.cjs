'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag'), folder = option('folder'), channel = option('browser') || 'chrome';
assert([tag, folder].every(value => value && /^[a-z0-9-]+$/.test(value)));
assert(['chrome', 'msedge'].includes(channel));
const directory = path.join(__dirname, 'results', 'villa-multitab-' + tag);
assert(!fs.existsSync(directory));
fs.mkdirSync(directory);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'build', folder, 'asset-versions.json')));
const report = {date: new Date().toISOString(), folder, channel, pass: false,
  package: audit(path.join(__dirname, 'build', folder, 'asset-versions.json')),
  source: audit(__filename), errors: [], states: []};
let context;
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
(async () => {
  try {
    context = await chromium.launchPersistentContext(
      path.join(__dirname, 'build/browser-profiles/villa-multitab-' + tag),
      {channel, headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
    const url = 'http://127.0.0.1:8766/build/' + folder + '/index.html';
    function observe(page, name) {
      page.on('pageerror', error => report.errors.push({page: name, error: error.message}));
      page.on('crash', () => report.errors.push({page: name, error: 'Renderer crashed'}));
      page.on('console', message => {
        const text = message.text();
        fs.appendFileSync(path.join(directory, name + '.log'), text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(text))
          report.errors.push({page: name, error: text});
      });
    }
    async function state(page, label) {
      const value = await page.evaluate(async () => ({
        frames: globalThis.__webEngineFrames, ready: globalThis.__webPSOPrecacheReady,
        shown: document.getElementById('loading')?.hidden, failure: globalThis.__webEngineFailure,
        stage: globalThis.__webStartupDiagnostics?.stage,
        view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings,
        prewarm: globalThis.__webPipelinePrewarm, io: globalThis.__webLocalContentStats,
        locks: await navigator.locks.query()
      }));
      report.states.push({label, ...value}); save();
      assert(!value.failure && !report.errors.length, value.failure || JSON.stringify(report.errors));
      assert(value.shown && value.ready && value.frames >= 30);
      assert.equal(value.view.width, 1920); assert.equal(value.view.height, 1080);
      assert(value.prewarm.adopted && value.prewarm.ready);
      console.log(JSON.stringify({label, frames: value.frames, downloads: value.io.downloads,
        persistentHits: value.io.persistentHits, pendingLocks: value.locks.pending.length}));
      return value;
    }
    async function ready(page, label) {
      const start = Date.now();
      await page.bringToFront();
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webPSOPrecacheReady && document.getElementById('loading')?.hidden &&
        globalThis.__webEngineFrames >= 30, null, {timeout: 90000});
      const value = await state(page, label);
      report.states.at(-1).elapsedMs = Date.now() - start;
      return value;
    }
    async function advance(page, label) {
      await page.bringToFront();
      const before = await page.evaluate(() => __webEngineFrames);
      await page.locator('canvas').focus();
      await page.keyboard.down('w');
      try {
        await page.waitForFunction(before => globalThis.__webEngineFailure || __webEngineFrames >= before + 60,
          before, {timeout: 30000});
      } finally {await page.keyboard.up('w');}
      const value = await state(page, label);
      await page.screenshot({path: path.join(directory, label + '.png')});
      return value;
    }
    const first = context.pages()[0]; observe(first, 'first');
    await first.goto(url);
    const baseline = await ready(first, 'first-ready');
    const second = await context.newPage(); observe(second, 'second');
    await second.goto(url);
    const next = await ready(second, 'second-ready-while-first-open');
    assert.equal(next.io.downloads, 0); assert.equal(next.io.persistentHits, 2);
    assert.deepEqual(next.settings, baseline.settings);
    for (const name of ['UEWebEngineThreads.wasm', 'content.bin'])
      assert.equal(next.locks.held.filter(lock => lock.name === 'ue-web-local-' + manifest[name].sha256 &&
        lock.mode === 'shared').length, 2, 'Both pages must retain their read leases');
    assert.equal(next.locks.pending.length, 0);
    await advance(first, 'first-running-with-second-open');
    await advance(second, 'second-running-with-first-open');
    await first.close();
    await second.reload();
    const reloaded = await ready(second, 'second-reloaded-after-first-closed');
    assert.equal(reloaded.io.downloads, 0);
    assert.deepEqual(reloaded.settings, baseline.settings);
    await advance(second, 'second-after-reload');
    report.pass = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    for (const page of context?.pages() || []) {
      const last = await page.evaluate(async () => ({url: location.href,
        failure: globalThis.__webEngineFailure, stage: globalThis.__webStartupDiagnostics?.stage,
        frames: globalThis.__webEngineFrames, locks: await navigator.locks.query()})).catch(() => null);
      (report.failedStates ||= []).push(last);
    }
    console.error(error);
  } finally {save(); await context?.close();}
})();
