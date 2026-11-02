'use strict';
// Separate first visibility, first 30 ticks and the precache gate using one package.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
const offOnly = process.argv.includes('--off-only');
assert([folder, tag].every(x => x && /^[a-z0-9-]+$/.test(x)));
const output = path.join(__dirname, 'results', tag + '.json');
function observe() {
  const state = globalThis.__startupPSO = {counts: {}, pending: 0, peakPending: 0, failed: [], errors: []};
  for (const method of ['createShaderModule', 'createRenderPipeline', 'createComputePipeline',
    'createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(...args) {
      state.counts[method] = (state.counts[method] || 0) + 1;
      const result = original.apply(this, args);
      if (method.endsWith('Async')) {
        state.firstRequestAt ??= performance.now();
        state.peakPending = Math.max(state.peakPending, ++state.pending);
        const complete = () => {--state.pending; state.lastCompletionAt = performance.now();};
        result.then(complete, error => {state.failed.push({label: args[0]?.label, message: error.message}); complete();});
      }
      return result;
    };
  }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', e => state.errors.push(e.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') state.errors.push('Device lost: ' + info.message);});
    return device;
  };
}
(async () => {
  const report = {date: new Date().toISOString(), folder, order: offOnly ? [false, false] : [false, true, true, false],
    qualityOverrides: [], pass: false, runs: [], errors: [],
    boundary: 'Same binary, Cook and persistent browser profile. Only remove/add the diagnostic PSO precache startup argument. Caches retained; timings sampled every 50 ms.'};
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  try {
    report.package = Object.fromEntries(['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm', 'content.bin',
      'content-files.json', 'config-files.json'].map(name => [name, audit(path.join(__dirname, 'build', folder, name))]));
    for (const [index, enabled] of report.order.entries()) {
      const context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/stutters'), {
        channel: 'msedge', headless: false, viewport: {width: 1863, height: 1030}, deviceScaleFactor: 1.25});
      const run = {index, enabled, samples: [], events: [], errors: []}; report.runs.push(run); save();
      try {
        await context.route('**/index.html', async route => {
          const response = await route.fetch(), html = await response.text();
          const match = html.match(/arguments: (\[[^\n]+\]),/); assert(match);
          // Older generated pages use plain single-quoted argument literals.
          assert(/^\[\s*(?:['"][a-zA-Z0-9_./=:-]+['"]\s*,?\s*)*\]$/.test(match[1]));
          const args = [...match[1].matchAll(/['"]([a-zA-Z0-9_./=:-]+)['"]/g)].map(x => x[1])
            .filter(x => x !== '-WebPSOPrecacheTest' && !x.startsWith('-WebPSOPrecacheConcurrency='));
          if (enabled) args.push('-WebPSOPrecacheTest');
          await route.fulfill({response, body: html.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',')});
        });
        await context.route('**/web-engine-worker.js?*', async route => {
          const response = await route.fetch();
          await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
        });
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
        await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
        report.browser = await cdp.send('Browser.getVersion');
        page.on('pageerror', error => run.errors.push(error.message));
        page.on('crash', () => run.errors.push('Renderer crashed'));
        const start = Date.now();
        page.on('console', message => {
          const text = message.text();
          if (/^P3_ENGINE_(WORLD|READY|THREADS) /.test(text)) run.events.push({ms: Date.now() - start, text});
          if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) run.errors.push(text);
        });
        await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
        await page.bringToFront();
        for (;;) {
          const sample = await page.evaluate(() => ({frames: globalThis.__webEngineFrames,
            engineReady: globalThis.__webEngineReady, psoReady: globalThis.__webPSOPrecacheReady,
            shown: document.getElementById('loading').hidden, pso: globalThis.__webPSOPrecache,
            rhi: globalThis.__webOptimizationRHI, pool: globalThis.__webThreadPool,
            stage: typeof startupDiagnostics !== 'undefined' ? startupDiagnostics.stage : null,
            failure: globalThis.__webEngineFailure}));
          const ms = Date.now() - start; run.samples.push({ms, ...sample});
          assert(!sample.failure, JSON.stringify(sample.failure));
          if (sample.frames >= 2) run.first2FramesMs ??= ms;
          if (sample.frames >= 30) run.first30FramesMs ??= ms;
          if (sample.shown) run.shownMs ??= ms;
          if (run.shownMs !== undefined && run.first30FramesMs !== undefined) break;
          assert(ms < 180000, 'Startup timed out');
          await page.waitForTimeout(50);
        }
        const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
        run.state = await owner.evaluate(() => ({capture: __startupPSO, settings: globalThis.__webProjectSettings,
          view: globalThis.__webRenderView, rhi: globalThis.__webOptimizationRHI,
          pso: globalThis.__webPSOPrecache, io: globalThis.__webContentIO?.stats}));
        assert.deepEqual(run.state.capture.errors, []); assert.deepEqual(run.errors, []);
        assert.equal(!!run.state.pso?.enabled, enabled); assert.equal(run.state.capture.pending, 0);
        assert.equal(run.state.io.downloadedBytes, 0, 'Compare retained content caches');
        assert.equal(run.state.capture.failed.length, enabled ? 8 : 0);
        if (enabled) assert.equal(run.state.rhi.precacheConcurrency, 8);
        if (index) {
          const reference = report.runs[0].state;
          assert.deepEqual(run.state.settings, reference.settings);
          for (const k of ['width', 'height', 'outputWidth', 'outputHeight', 'antiAliasing']) assert.equal(run.state.view[k], reference.view[k]);
        }
        save(); console.log(JSON.stringify({index, enabled, first2FramesMs: run.first2FramesMs,
          first30FramesMs: run.first30FramesMs, shownMs: run.shownMs, counts: run.state.capture.counts,
          io: run.state.io, events: run.events}));
      } finally {save(); await context.close();}
    }
    report.pass = true;
  } catch (error) {report.errors.push(error.stack || String(error)); throw error;}
  finally {save();}
})().catch(error => {console.error(error); process.exitCode = 1;});
