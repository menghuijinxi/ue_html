'use strict';
// Separate browser pipeline completion time from the application's request schedule.
// Does not delete browser caches or change project/render settings.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder') || 'villa-pso-reuse-v17-tsr-on';
const tag = option('tag') || 'pso-reload';
const rounds = Number(option('rounds') || 3);
assert([folder, tag].every(x => /^[a-z0-9-]+$/.test(x)));
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 5);
const output = path.join(__dirname, 'results', tag + '.json');
function observe() {
  const state = globalThis.__psoReload = {modules: [], pipelines: [], errors: [], pending: 0, peakPending: 0};
  const objects = new WeakMap();
  const clone = value => {
    if (value === null || typeof value !== 'object') return value;
    if (objects.has(value)) return objects.get(value);
    if (Array.isArray(value)) return value.map(clone);
    return Object.fromEntries(Object.keys(value).filter(k => k !== 'label').sort().map(k => [k, clone(value[k])]));
  };
  const module = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(d) {
    const start = performance.now(), result = module.call(this, d);
    const index = state.modules.length;
    state.modules.push({index, code: d.code, start, callMs: performance.now() - start});
    objects.set(result, {shader: index});
    return result;
  };
  for (const method of ['createBindGroupLayout', 'createPipelineLayout']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(d) {
      const result = original.call(this, d);
      objects.set(result, {[method]: clone(d)});
      return result;
    };
  }
  for (const method of ['createRenderPipelineAsync', 'createComputePipelineAsync']) {
    const original = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(d) {
      const item = {method, start: performance.now(), descriptor: clone(d)};
      state.pipelines.push(item);
      state.peakPending = Math.max(state.peakPending, ++state.pending);
      const result = original.call(this, d);
      item.callMs = performance.now() - item.start;
      result.then(() => { item.end = performance.now(); item.success = true; --state.pending; }, error => {
        item.end = performance.now(); item.success = false; item.error = error.message; --state.pending;
      });
      return result;
    };
  }
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    state.deviceDescriptor = clone(args[0]);
    const device = await request.apply(this, args);
    device.addEventListener('uncapturederror', e => state.errors.push(e.error.message));
    device.lost.then(info => { if (info.reason !== 'destroyed') state.errors.push(info.message); });
    state.deviceLimits = {x: device.limits.maxComputeWorkgroupSizeX, invocations: device.limits.maxComputeInvocationsPerWorkgroup};
    return device;
  };
}
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function normalize(capture) {
  const modules = capture.modules.map(m => ({...m, sha256: hash(m.code), code: undefined}));
  const replace = value => {
    if (value === null || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && Number.isInteger(value.shader)) return {shaderSHA256: modules[value.shader].sha256};
    if (Array.isArray(value)) return value.map(replace);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
  };
  return {...capture, modules, pipelines: capture.pipelines.map(p => {
    const descriptor = replace(p.descriptor);
    return {...p, descriptor, sha256: hash(JSON.stringify(descriptor)), elapsedMs: p.end - p.start};
  })};
}
function summarize(capture) {
  const items = capture.pipelines;
  const sorted = items.map(p => p.elapsedMs).sort((a, b) => a - b);
  const ranges = items.map(p => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
  let union = 0, end = ranges[0][0];
  for (const [start, next] of ranges) { union += Math.max(0, next - Math.max(end, start)); end = Math.max(end, next); }
  const span = Math.max(...items.map(p => p.end)) - Math.min(...items.map(p => p.start));
  return {requests: items.length, failed: items.filter(p => !p.success).length, peakPending: capture.peakPending,
    requestSpanMs: span, pendingUnionMs: union, noRequestPendingMs: span - union,
    meanCompletionMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    medianCompletionMs: sorted[Math.floor(sorted.length * .5)], p95CompletionMs: sorted[Math.floor(sorted.length * .95)],
    maximumCompletionMs: sorted.at(-1), synchronousCallMs: items.reduce((a, p) => a + p.callMs, 0)};
}
(async () => {
  const report = {date: new Date().toISOString(), folder, pass: false, runs: [], errors: [], qualityOverrides: [],
    boundary: 'Same package and persistent profile, sequential reloads. Promise latency includes browser scheduling, not just compiler CPU time.'};
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  const context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/stutters'), {
    channel: 'msedge', headless: false, viewport: {width: 1863, height: 1030}, deviceScaleFactor: 1.25});
  try {
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
    });
    const page = await context.newPage(), cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    report.browser = await cdp.send('Browser.getVersion');
    report.commandLine = await cdp.send('Browser.getBrowserCommandLine').catch(error => ({unavailable: error.message}));
    const histograms = async () => (await cdp.send('Browser.getHistograms', {})).histograms.filter(h => /webgpu|dawn/i.test(h.name));
    report.histogramsBefore = await histograms();
    for (let index = 0; index < rounds; ++index) {
      const run = {index, samples: []}; report.runs.push(run); save();
      const start = Date.now();
      if (index === 0) await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
      else await page.reload({waitUntil: 'commit'});
      await page.bringToFront();
      const deadline = Date.now() + 180000;
      for (;;) {
        const sample = await page.evaluate(() => ({frames: globalThis.__webEngineFrames, ready: globalThis.__webPSOPrecacheReady,
          pso: globalThis.__webPSOPrecache, rhi: globalThis.__webOptimizationRHI, failure: globalThis.__webEngineFailure}));
        run.samples.push({elapsedMs: Date.now() - start, ...sample});
        assert(!sample.failure, JSON.stringify(sample.failure));
        if (sample.ready && sample.frames >= 30) break;
        assert(Date.now() < deadline, 'Startup timed out');
        await page.waitForTimeout(1000);
      }
      run.readyMs = Date.now() - start;
      const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
      const raw = await owner.evaluate(() => __psoReload);
      if (index === 0) {
        report.replayInputs = path.join(__dirname, 'results', tag + '-inputs.json');
        fs.writeFileSync(report.replayInputs, JSON.stringify(raw));
      }
      run.capture = normalize(raw);
      run.summary = summarize(run.capture);
      run.state = await owner.evaluate(() => ({rhi: __webOptimizationRHI, pso: __webPSOPrecache,
        settings: __webProjectSettings, view: __webRenderView, io: __webContentIO?.stats}));
      run.histograms = await histograms();
      assert.deepEqual(run.capture.errors, []);
      assert.equal(run.capture.pending, 0);
      if (index) {
        assert.deepEqual([...new Set(run.capture.modules.map(m => m.sha256))].sort(), [...new Set(report.runs[0].capture.modules.map(m => m.sha256))].sort());
        assert.deepEqual(run.capture.pipelines.map(p => p.sha256).sort(), report.runs[0].capture.pipelines.map(p => p.sha256).sort());
        assert.deepEqual(run.state.settings, report.runs[0].state.settings);
      }
      save(); console.log(JSON.stringify({index, readyMs: run.readyMs, ...run.summary,
        cacheHistograms: run.histograms.filter(h => /CacheHit|CacheMiss/.test(h.name)).map(h => ({name:h.name, count:h.count, sum:h.sum}))}));
    }
    report.pass = true;
  } catch (error) {report.errors.push(error.stack || String(error)); throw error;}
  finally {save(); await context.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
