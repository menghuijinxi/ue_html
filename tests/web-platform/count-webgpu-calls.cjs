'use strict';
// Diagnostic: per-frame histogram of the WebGPU methods the engine actually
// calls in the GPU owner worker, over the standard first interior tour.
// Method wrapping slows the frame; use the counts, never the frame rate.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(a => a.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag'), nanite = option('nanite');
assert([folder, tag].every(n => /^[a-z0-9-]+$/.test(n)));
assert(nanite === undefined || nanite === '0' || nanite === '1');
// Optional startup console variables, name=value, comma separated.
const cvars = (option('cvars') || '').split(',').filter(Boolean).map(v => v.split('='));
assert(cvars.every(v => v.length === 2 && /^[A-Za-z0-9_.]+$/.test(v[0]) && /^-?[0-9.]+$/.test(v[1])));
const width = Number(option('width') || 2560), height = Number(option('height') || 1440), seconds = Number(option('seconds') || 60);
const output = path.join(__dirname, 'results', tag + '.json');
assert(!fs.existsSync(output), 'Use a new result tag');
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), folder, nanite, cvars, width, height, seconds, errors: [],
  boundary: 'Diagnostic call counts with wrapped WebGPU methods in the GPU owner worker. Normal clocks, first interior tour without warmup. '
    + 'Wrapping adds per-call overhead, so the frame rate here is not game performance. Counts cover only the measured tour window.'};
function installCounter() {
  const state = globalThis.__gpuCalls = {active: false, start: 0, methods: {}, writeBytes: 0, createBufferBytes: 0, copyBytes: 0, pipelines: []};
  // Shader text identifies which pipelines are first created inside the window.
  const modules = new WeakMap();
  const kindOf = d => {
    const text = [d.compute, d.vertex, d.fragment].filter(Boolean).map(v => modules.get(v.module) || '').join('\n');
    const kind = text.includes('WebRasterPixelProgrammable') ? 'nanite-programmable-raster' :
      text.includes('WebShadeBinTiles') || text.includes('WebNativeMaterialTiles') ? 'nanite-material' :
      /WebRaster|WebNanite|WebShadeBin|WebHierarchy|WebOcclusion/.test(text) ? 'nanite-other' : 'other';
    return {kind, shaderBytes: text.length};
  };
  const wrap = (cls) => {
    const proto = globalThis[cls]?.prototype; if (!proto) return;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (name === 'constructor' || typeof descriptor.value !== 'function') continue;
      const original = descriptor.value, key = cls + '.' + name;
      proto[name] = function (...args) {
        if (state.active) {
          state.methods[key] = (state.methods[key] || 0) + 1;
          if (key === 'GPUQueue.writeBuffer') state.writeBytes += args[4] ?? (args[2].byteLength - (args[3] || 0));
          else if (key === 'GPUDevice.createBuffer') state.createBufferBytes += args[0].size;
          else if (key === 'GPUCommandEncoder.copyBufferToBuffer') state.copyBytes += args.length >= 5 ? args[4] : (args[2] ?? 0);
        }
        const result = original.apply(this, args);
        if (key === 'GPUDevice.createShaderModule') modules.set(result, args[0].code);
        else if (state.active && /^GPUDevice\.create(Render|Compute)Pipeline(Async)?$/.test(key))
          state.pipelines.push({seconds: (performance.now() - state.start) / 1000, method: name, ...kindOf(args[0])});
        return result;
      };
    }
  };
  for (const cls of ['GPUDevice', 'GPUQueue', 'GPUCommandEncoder', 'GPURenderPassEncoder', 'GPUComputePassEncoder',
    'GPURenderBundleEncoder', 'GPUBuffer', 'GPUTexture', 'GPUQuerySet']) wrap(cls);
}
(async () => {
  let context;
  try {
    report.package = audit(path.join(__dirname, 'build', folder, 'package.json'));
    context = await chromium.launchPersistentContext(`G:/UE_HTML/ue_html/tests/web-platform/results/browser-profiles/${tag}`, {
      channel: 'msedge', headless: !process.argv.includes('--headed'), viewport: {width, height}, deviceScaleFactor: 1});
    if (nanite !== undefined || cvars.length) await context.route('**/config-files.json*', async route => {
      const response = await route.fetch(), files = await response.json();
      const file = files.find(f => f.path === '/Engine/Platforms/Web/Config/WebEngine.ini'); assert(file);
      const settings = [...(nanite !== undefined ? [['r.Nanite', nanite]] : []), ...cvars];
      const data = Buffer.from(Buffer.from(file.data, 'base64').toString() + '\n[SystemSettings]\n' + settings.map(v => v.join('=')).join('\n') + '\n');
      file.data = data.toString('base64'); file.sha256 = crypto.createHash('sha256').update(data).digest('hex');
      report.startupConfig = {path: file.path, sha256: file.sha256, settings};
      await route.fulfill({response, body: JSON.stringify(files)});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${installCounter.toString()})();\n` + await response.text()});
    });
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => { if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(m.text())) report.errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || (globalThis.__webEngineFrames >= 180 && globalThis.__webPSOPrecacheReady), null, {timeout: 300000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    await page.waitForTimeout(10000);
    const snapshot = () => owner.evaluate(() => ({frame: globalThis.__webRHIFrames, time: performance.now(),
      presented: globalThis.__webThreadStages?.presented, clock: globalThis.__webVisualTestClock}));
    const before = await snapshot();
    await owner.evaluate(() => { const s = globalThis.__gpuCalls; s.methods = {}; s.writeBytes = s.createBufferBytes = s.copyBytes = 0; s.pipelines = []; s.start = performance.now(); s.active = true; });
    assert(await page.evaluate(s => __webEngineRPC('WebMotionBenchmarkControl', 3, s), seconds));
    await page.waitForFunction(() => globalThis.__webMotionBenchmark?.completed && !globalThis.__webMotionBenchmark.active, null, {timeout: (seconds + 60) * 1000});
    const counts = await owner.evaluate(() => { const s = globalThis.__gpuCalls; s.active = false; return s; });
    const after = await snapshot();
    assert(!before.clock?.renderTimeFrozen && !after.clock?.renderTimeFrozen);
    const frames = after.frame - before.frame; assert(frames > 100);
    report.frames = frames; report.instrumentedFps = frames * 1000 / (after.time - before.time);
    report.perFrame = Object.fromEntries(Object.entries(counts.methods).map(([k, v]) => [k, v / frames]).sort((a, b) => b[1] - a[1]));
    report.totalCallsPerFrame = Object.values(counts.methods).reduce((a, b) => a + b, 0) / frames;
    report.writeBytesPerFrame = counts.writeBytes / frames; report.createBufferBytesPerFrame = counts.createBufferBytes / frames;
    report.copyBytesPerFrame = counts.copyBytes / frames;
    report.pipelinesCreated = counts.pipelines;
    report.motion = await page.evaluate(() => globalThis.__webMotionBenchmark);
    assert.deepEqual(report.errors, []); report.pass = true;
  } catch (e) { report.failure = e.stack; process.exitCode = 1; console.error(e.stack); }
  finally {
    await context?.close(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({pass: report.pass, output, frames: report.frames, totalCallsPerFrame: report.totalCallsPerFrame}));
  }
})();
