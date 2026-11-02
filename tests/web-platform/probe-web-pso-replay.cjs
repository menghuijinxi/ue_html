'use strict';
// Replay captured, unchanged descriptors in an idle page to exclude UE scheduling.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const input = option('input');
const tag = option('tag') || 'pso-replay';
assert(input && /^[a-z0-9-]+$/.test(tag));
const captured = JSON.parse(fs.readFileSync(input));
const sourcePipelineCount = captured.pipelines.length;
const usedOnly = process.argv.includes('--used-only');
if (usedOnly) {
  assert(captured.pipelines.some(p => p.binds > 0), 'Capture pipeline use first');
  captured.pipelines = captured.pipelines.filter(p => p.binds > 0);
}
const tracing = process.argv.includes('--trace');
const browserRounds = Number(option('browsers') || 2);
assert(Number.isInteger(browserRounds) && browserRounds > 0 && browserRounds <= 3);
const concurrency = Number(option('concurrency') || 2);
assert(Number.isInteger(concurrency) && concurrency > 0 && concurrency <= 64);
const retainPipelines = process.argv.includes('--retain-pipelines');
async function replay({capture, concurrency, retainPipelines}) {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  const device = await adapter.requestDevice(capture.deviceDescriptor);
  const errors = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  device.lost.then(info => {if (info.reason !== 'destroyed') errors.push('Device lost: ' + info.message);});
  const start = performance.now();
  const modules = capture.modules.map(m => device.createShaderModule({code: m.code}));
  const layouts = new Map();
  const restore = value => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(restore);
    if (Number.isInteger(value.shader)) return modules[value.shader];
    for (const method of ['createBindGroupLayout', 'createPipelineLayout']) {
      if (value[method]) {
        const key = JSON.stringify(value);
        if (!layouts.has(key)) layouts.set(key, device[method](restore(value[method])));
        return layouts.get(key);
      }
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]));
  };
  const descriptors = capture.pipelines.map(p => ({method: p.method, descriptor: restore(p.descriptor)}));
  const preparationMs = performance.now() - start;
  const rounds = [];
  const retained = retainPipelines ? new Array(descriptors.length) : null;
  for (let round = 0; round < 2; ++round) {
    const start = performance.now(), times = [];
    let index = 0, failed = 0, pending = 0, peakPending = 0;
    const work = async () => {
      while (index < descriptors.length) {
        const current = index++, item = descriptors[current], at = performance.now();
        peakPending = Math.max(peakPending, ++pending);
        let error;
        try {
          const pipeline = await device[item.method](item.descriptor);
          if (retained) retained[current] = pipeline;
        }
        catch (e) {++failed; error = e.message;}
        --pending;
        times.push({index: current, ms: performance.now() - at, error});
      }
    };
    await Promise.all(Array.from({length: concurrency}, work));
    const values = times.map(t => t.ms).sort((a, b) => a - b);
    rounds.push({round, wallMs: performance.now() - start, failed, requests: times.length, peakPending,
      meanMs: values.reduce((a, b) => a + b, 0) / values.length,
      medianMs: values[Math.floor(values.length * .5)], p95Ms: values[Math.floor(values.length * .95)],
      maximumMs: values.at(-1), times});
  }
  await device.queue.onSubmittedWorkDone();
  device.destroy();
  return {preparationMs, rounds, errors, retainedPipelines: retained?.filter(Boolean).length || 0, adapter: {...adapter.info.toJSON?.(),
    vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device}};
}
(async () => {
  const report = {date: new Date().toISOString(), input, pass: false, runs: [], errors: [],
    disableDiskCache: process.argv.includes('--no-disk-cache'),
    concurrency, retainPipelines, usedOnly, sourcePipelineCount, replayPipelineCount: captured.pipelines.length,
    boundary: 'Same captured WebGPU shader sources, pipeline states and device limits. Idle document with configurable request concurrency, no UE render loop.'};
  const output = path.join(__dirname, 'results', tag + '.json');
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
  // Reopen the browser twice, retaining the existing profile and its disk cache.
  try {
    for (let browserIndex = 0; browserIndex < browserRounds; ++browserIndex) {
      const context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/stutters'), {
        channel: 'msedge', headless: false, viewport: {width: 1280, height: 720},
        args: report.disableDiskCache ? ['--disable-gpu-shader-disk-cache'] : []});
      try {
        await context.route('**/pso-replay-diagnostic.html', route => route.fulfill({status: 200, contentType: 'text/html',
          headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'},
          body: '<!doctype html><title>PSO cache diagnostic</title><p>PSO cache diagnostic</p>'}));
        const page = await context.newPage(), cdp = await context.newCDPSession(page);
        report.browser = await cdp.send('Browser.getVersion');
        const trace = [];
        if (tracing) {
          cdp.on('Tracing.dataCollected', event => trace.push(...event.value));
          await cdp.send('Tracing.start', {categories: 'disabled-by-default-gpu.dawn,gpu,toplevel', options: 'record-until-full'});
        }
        const hist = async () => (await cdp.send('Browser.getHistograms', {})).histograms.filter(h => /dawn|webgpu/i.test(h.name));
        await page.goto('http://127.0.0.1:8765/pso-replay-diagnostic.html'); await page.bringToFront();
        const result = await page.evaluate(replay, {capture: captured, concurrency, retainPipelines});
        if (tracing) {
          const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
          await cdp.send('Tracing.end'); await done;
          result.traceFile = path.join(__dirname, 'results', tag + '-' + browserIndex + '-trace.json');
          fs.writeFileSync(result.traceFile, JSON.stringify({traceEvents: trace}));
          const tasks = trace.filter(e => e.name === 'DawnPlatformImpl::RunWorkerTask' && e.ph === 'X');
          result.traceSummary = {cacheReadHitEvents: trace.filter(e => e.name === 'DawnCachingInterface::CacheHit').length,
            pipelineWorkerTasks: tasks.length, workerCpuSumMs: tasks.reduce((sum, e) => sum + (e.tdur || 0), 0) / 1000,
            workerWallSumMs: tasks.reduce((sum, e) => sum + e.dur, 0) / 1000};
        }
        result.browserIndex = browserIndex;
        result.histograms = await hist(); report.runs.push(result);
        if (process.argv.includes('--histogram-page')) {
          const histPage = await context.newPage();
          await histPage.goto('edge://histograms');
          await histPage.getByLabel('Include histograms from subprocesses').check();
          await histPage.getByRole('button', {name: 'Refresh', exact: true}).click();
          await histPage.waitForTimeout(2000);
          result.histogramPage = await histPage.locator('body').innerText();
          await histPage.close();
        }
        assert.deepEqual(result.errors, []);
        if (retainPipelines) assert.equal(result.retainedPipelines, captured.pipelines.filter(p => p.success).length);
        for (const round of result.rounds) {
          assert.equal(round.requests, captured.pipelines.length);
          assert.deepEqual(round.times.filter(p => p.error).map(p => p.index).sort((a,b) => a-b),
            captured.pipelines.flatMap((p,i) => p.success ? [] : [i]));
        }
        save(); console.log(JSON.stringify({browserIndex, concurrency, preparationMs: result.preparationMs,
          rounds: result.rounds.map(({times, ...rest}) => rest), histogramNames: result.histograms.map(h => h.name)}));
      } finally {await context.close();}
    }
    report.pass = true;
  } catch (error) {report.errors.push(error.stack || String(error)); throw error;}
  finally {save();}
})().catch(error => {console.error(error); process.exitCode = 1;});
