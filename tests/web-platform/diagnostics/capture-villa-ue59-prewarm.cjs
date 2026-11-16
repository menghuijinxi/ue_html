'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const base = path.resolve(__dirname, '..');
const tag = process.argv[2];
assert(tag && /^[a-z0-9-]+$/.test(tag));
const suite = assertProjectOutputTree(path.join(base, 'build', tag));
const metadata = JSON.parse(fs.readFileSync(path.join(suite, 'suite.json')));
const output = assertProjectOutput(path.join(suite, 'capture-report.json'));
assert(!fs.existsSync(output), 'Preserve failed and successful capture attempts');
const report = {date: new Date().toISOString(), pass: false, runs: [],
  boundary: 'UE59 capture source, two automatic boot loads, six seconds after ready, no camera tour. Capture instrumentation excluded from timing comparisons.'};
let browser;
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles', tag + '-capture'));
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: false,
      viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes')),
        '--enable-logging', '--log-file=' + assertProjectOutput(path.join(suite, 'capture-browser.log'))]});
    for (const restored of browser.pages()) await restored.close();
    const page = await browser.newPage();
    let active;
    page.on('pageerror', error => active?.errors.push(error.message));
    page.on('console', message => {
      if (!active) return;
      const text = message.text();
      if (text.startsWith('PREWARM ')) {
        active.logs.push(text);
        if (text.startsWith('PREWARM capture_written')) active.saved = true;
        if (/failed|refused/.test(text)) active.errors.push(text);
      }
    });
    for (let index = 0; index < 2; ++index) {
      active = {index, errors: [], logs: []}; report.runs.push(active);
      await page.goto('http://127.0.0.1:8765/build/' + metadata.capture.folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webPSOPrecacheReady && document.getElementById('loading')?.hidden, null, {timeout: 120000});
      active.ready = await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure, prewarm: globalThis.__webPipelinePrewarm,
        settings: globalThis.__webProjectSettings, view: globalThis.__webRenderView,
      }));
      assert(!active.ready.failure, JSON.stringify(active.ready.failure));
      for (const key of ['gi', 'reflections', 'virtualShadows', 'virtualTextures'])
        assert.equal(active.ready.settings[key], 1);
      assert.deepEqual(['width', 'height', 'outputWidth', 'outputHeight'].map(key => active.ready.view[key]),
        [1400, 788, 1920, 1080]);
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      assert(owner);
      const deadline = Date.now() + 15000;
      while (!active.saved && !active.errors.length && Date.now() < deadline) await page.waitForTimeout(100);
      assert(active.saved && !active.errors.length, active.errors.join('\n') || 'UE59 capture did not save');
      const capture = await owner.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle('logs');
        return JSON.parse(await (await (await directory.getFileHandle('webgpu-capture.json')).getFile()).text());
      });
      assert.equal(capture.why, 'ready'); assert.equal(capture.tier, 'desktop');
      assert.equal(capture.stamp, metadata.stamp);
      assert(capture.calls.length > 0 && !capture.calls.some(call => call.error));
      fs.writeFileSync(assertProjectOutput(path.join(suite, 'capture-' + index + '.json')), JSON.stringify(capture));
      active.calls = capture.calls.length; active.pass = true;
      console.log(JSON.stringify({index, pass: true, calls: active.calls, marks: capture.marks}));
      await page.goto('about:blank');
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
    }
    report.pass = report.runs.every(run => run.pass);
  } catch (error) {report.error = error.stack; throw error;}
  finally {
    await browser?.close();
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
