'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('../content-file-metadata.cjs');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const base = path.resolve(__dirname, '..'), tag = option('tag'), kind = option('kind') || 'timing';
const variantsFile = path.resolve(option('variants')), variants = JSON.parse(fs.readFileSync(variantsFile, 'utf8'));
const folder = 'villa-shadow-on-20261111-sparse';
const order = (option('order') || (kind === 'timing' ? '0,1,1,0' : '0,1')).split(',').map(Number);
const seconds = Number(option('seconds') || 30);
assert(tag && /^[a-z0-9-]+$/.test(tag));
assert(['gpu', 'timing'].includes(kind));
assert(variants.pass && variants.diagnosticOnly);
assert(order.length >= 2 && order.length <= 8 && order.every(n => [0, 1].includes(n)));
assert(order.includes(0) && order.includes(1));
assert(Number.isInteger(seconds) && seconds >= 15 && seconds <= 60);
const directory = path.join(base, 'results', tag);
assert(!fs.existsSync(directory)); fs.mkdirSync(directory);
const sourceSnapshot = path.join(directory, 'benchmark-source.cjs');
fs.copyFileSync(__filename, sourceSnapshot);
process.env.TEMP = process.env.TMP = path.join(base, 'build/test-tmp');
const report = {date: new Date().toISOString(), pass: false, kind, order, seconds,
  source: audit(sourceSnapshot), variants: audit(variantsFile),
  package: audit(path.join(base, 'build', folder, 'asset-versions.json')),
  overrides: {'r.Shadow.Virtual.SMRT.AdaptiveRayCount': 1, ...(kind === 'gpu' ? {'r.WebGPU.ReuseComputePass': 0} : {})},
  boundary: 'Diagnostic browser-memory shader substitution, not a release. Baseline uses packaged shaders; adaptive uses two probed projection modules with verified matching bindings. Both prewarm and runtime creation use the same replacement. The original prewarm keys are retained only for this experiment. GPU mode splits compute passes for attribution and is not an FPS benchmark. Timing mode preserves normal pass reuse.',
  runs: [], startupFailures: [], comparisons: []};
const save = () => fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
function install(variants, enabled, timing) {
  const probe = globalThis.__vsmAdaptiveProbe = {enabled, matched: {}, replaced: {}, errors: [], features: [],
    active: false, times: [], creations: []};
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(descriptor) {
    const device = await request.call(this, descriptor);
    probe.features = [...device.features];
    if (enabled && !device.features.has('subgroups')) throw Error('Adaptive probe requires subgroups');
    device.addEventListener('uncapturederror', event => probe.errors.push(event.error.message));
    device.lost.then(info => {if (info.reason !== 'destroyed') probe.errors.push(info.message);});
    return device;
  };
  const createModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    if (probe.active) probe.creations.push('createShaderModule');
    const variant = variants.find(v => descriptor.code.includes('fn ' + v.entry + '('));
    if (variant) {
      const code = descriptor.code.replaceAll('\r\n', '\n').trim();
      const replacement = variant.replacements.find(r => r.original === code);
      if (!replacement) throw Error('Unrecognized runtime shader variant: ' + variant.entry);
      probe.matched[variant.entry] = (probe.matched[variant.entry] || 0) + 1;
      if (enabled) {
        descriptor = {...descriptor, code: replacement.adaptive};
        probe.replaced[variant.entry] = (probe.replaced[variant.entry] || 0) + 1;
      }
    }
    return createModule.call(this, descriptor);
  };
  for (const name of ['createComputePipeline', 'createComputePipelineAsync', 'createRenderPipeline', 'createRenderPipelineAsync']) {
    const create = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function(descriptor) {
      if (probe.active) probe.creations.push(name);
      const result = create.call(this, descriptor);
      if (!descriptor.compute) return result;
      const label = pipeline => {pipeline.label = descriptor.compute.entryPoint; return pipeline;};
      return result?.then ? result.then(label) : label(result);
    };
  }
  if (timing) {
    let frame = 0;
    Object.defineProperty(globalThis, '__webRHIFrames', {configurable: true, get: () => frame, set(value) {
      if (probe.active && value > frame) probe.times.push(performance.now());
      frame = value;
    }});
  }
}
function summarize(intervals) {
  assert(intervals.length >= 100 && intervals.every(n => Number.isFinite(n) && n > 0));
  const sorted = [...intervals].sort((a, b) => a - b), slow = sorted.slice(-Math.ceil(sorted.length * .01));
  return {intervals: intervals.length, fps: 1000 * intervals.length / intervals.reduce((a, b) => a + b),
    low1Fps: 1000 * slow.length / slow.reduce((a, b) => a + b),
    p99Ms: sorted[Math.floor(sorted.length * .99)], maxMs: sorted.at(-1),
    over50Ms: intervals.filter(n => n > 50).length};
}
const intervals = phase => phase.capture.times.slice(1).map((t, i) => t - phase.capture.times[i]);
let context, log, run;
(async () => {
  try {
    for (let runIndex = 0; runIndex < order.length; ++runIndex) {
      const adaptive = order[runIndex];
      run = {index: report.runs.length + 1, adaptive, phases: [], errors: []};
      report.runs.push(run); save();
      context = await chromium.launchPersistentContext(path.join(base, 'build/browser-profiles/villa-shadow-page-20261111'), {
        channel: 'msedge', headless: false, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1.5,
        args: ['--window-position=-32000,-32000', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
      });
      report.browser = context.browser().version();
      await context.route('**/web-engine-worker.js?*', async route => {
        const response = await route.fetch();
        let body = await response.text();
        const marker = "        removeRunDependency('worker-content');";
        assert.equal(body.split(marker).length, 2);
        const settings = Object.entries(report.overrides).map(([key, value]) => key + '=' + value).join('\n');
        body = body.replace(marker, `
        const adaptiveProbeIni = '/Engine/Platforms/Web/Config/WebEngine.ini';
        FS.writeFile(adaptiveProbeIni, FS.readFile(adaptiveProbeIni, {encoding:'utf8'}) +
          ${JSON.stringify('\n[SystemSettings]\n' + settings + '\n')});
${marker}`);
        const observer = kind === 'gpu' ? '(' + require('../web-performance-capture-observer.cjs').toString() + ')();\n' : '';
        await route.fulfill({response, body: '(' + install.toString() + ')(' +
          JSON.stringify(variants.variants) + ',' + !!run.adaptive + ',' + (kind === 'timing') + ');\n' + observer + body});
      });
      const page = context.pages()[0] || await context.newPage();
      run.restoredPagesClosed = context.pages().length - 1;
      for (const previous of context.pages()) if (previous !== page) await previous.close();
      assert.equal(context.pages().length, 1);
      await page.goto('about:blank');
      run.logFile = path.join(directory, 'run-' + run.index + '-attempt-' + (report.startupFailures.length + 1) + '.log');
      log = fs.createWriteStream(run.logFile);
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost|Failed to create (compute|graphics) pipeline|Missing global shader/.test(text))
          run.errors.push(text);
      });
      page.on('pageerror', error => run.errors.push(error.message));
      console.log(JSON.stringify({run: run.index, adaptive, stage: 'starting'}));
      await page.goto('http://127.0.0.1:8765/build/' + folder + '/index.html');
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= 60 && __webPSOPrecacheReady && document.getElementById('loading')?.hidden,
      null, {timeout: 180000});
      run.startupFailure = await page.evaluate(() => globalThis.__webEngineFailure || null);
      if (run.startupFailure) {
        run.startupDiagnostics = await page.workers().find(w => w.url().includes('web-engine-worker.js'))?.evaluate(() => ({
          probe: globalThis.__vsmAdaptiveProbe, prewarm: globalThis.__webPipelinePrewarm,
          retainedAdapters: globalThis.__webGPUKeepAlive?.adapters.length
        })).catch(error => ({error: error.message}));
        if (run.startupFailure.includes('A valid external Instance reference no longer exists.') &&
            report.startupFailures.length < 3) {
          report.startupFailures.push({...run, excluded: 'No timed frames; exact startup error only'});
          report.runs.pop(); save();
          console.log(JSON.stringify({run: run.index, adaptive, startupRetry: run.startupFailure}));
          await page.goto('about:blank'); await context.close(); context = null;
          log.end(); log = null; --runIndex; continue;
        }
      }
      assert(!run.startupFailure, JSON.stringify({failure: run.startupFailure, errors: run.errors}));
      const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
      const state = () => owner.evaluate(() => ({frames: __webRHIFrames, camera: __webDefaultCamera,
        view: __webRenderView, settings: __webProjectSettings, stages: __webThreadStages,
        prewarm: __webPipelinePrewarm, occlusion: __webOcclusionRHI, motion: globalThis.__webMotionBenchmark,
        failure: globalThis.__webEngineFailure, probe: {matched: __vsmAdaptiveProbe.matched,
          replaced: __vsmAdaptiveProbe.replaced, errors: __vsmAdaptiveProbe.errors, features: __vsmAdaptiveProbe.features}}));
      const check = s => {
        assert(!s.failure && !run.errors.length && !s.probe.errors.length, JSON.stringify([...run.errors, ...s.probe.errors]));
        assert.equal(s.settings.virtualShadows, 1); assert(s.settings.virtualShadowPathActive);
        for (const key of ['gi', 'reflections', 'virtualTextures']) assert.equal(s.settings[key], 1);
        assert.equal(s.view.width, 1400); assert.equal(s.view.height, 788);
        assert.equal(s.view.outputWidth, 1920); assert.equal(s.view.outputHeight, 1080);
        assert.equal(s.view.antiAliasing, 4); assert(s.prewarm.ready && s.prewarm.adopted);
        assert.equal(s.occlusion.reuseComputePass, kind === 'timing');
        for (const v of variants.variants) {
          assert(s.probe.matched[v.entry] > 0);
          assert.equal(!!s.probe.replaced[v.entry], !!adaptive);
        }
      };
      const motion = (duration, mode = 2) => page.evaluate(({duration, mode}) =>
        __webEngineRPC('WebMotionBenchmarkControl', mode, duration), {duration, mode});
      run.initial = await state(); check(run.initial);
      console.log(JSON.stringify({run: run.index, adaptive, stage: 'warming-routes', probe: run.initial.probe}));
      for (const mode of [2, 1]) {
        const serial = await motion(15, mode); assert(serial > 0);
        await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
          __webMotionBenchmark.completed, serial, {timeout: 45000});
      }
      for (const [name, mode] of (kind === 'gpu' ? [['standing', 0], ['turning', 2]] :
        [['standing', 0], ['turning', 2], ['moving', 1]])) {
        await motion(0); await page.waitForTimeout(3000);
        const phase = {name, before: await state(), samples: []}; check(phase.before);
        run.phases.push(phase); save();
        if (name === 'standing') {
          await page.locator('canvas').first().screenshot({path: path.join(directory, 'run-' + run.index + '-standing.png')});
        }
        if (kind === 'gpu') {
          phase.gpuFrames = [];
          if (mode) {
            phase.motionSerial = await motion(60, mode);
            await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
              !__webMotionBenchmark.completed, phase.motionSerial, {timeout: 15000});
          }
          for (let sample = 0; sample < 6; ++sample) {
            await page.waitForTimeout(1000);
            phase.gpuFrames.push({state: await state(), capture: await owner.evaluate(() => __webCaptureGPUFrame())});
          }
        } else {
          await owner.evaluate(() => Object.assign(__vsmAdaptiveProbe, {active: true, times: [], creations: []}));
          phase.motionSerial = mode ? await motion(seconds, mode) : 0;
          const end = Date.now() + seconds * 1000;
          while (Date.now() < end) {
            await page.waitForTimeout(Math.min(1000, Math.max(1, end - Date.now())));
            phase.samples.push(await state());
          }
          phase.capture = await owner.evaluate(() => {
            __vsmAdaptiveProbe.active = false;
            return {times: __vsmAdaptiveProbe.times, creations: __vsmAdaptiveProbe.creations};
          });
          assert.equal(phase.capture.creations.length, 0);
          phase.summary = summarize(intervals(phase));
        }
        phase.after = await state(); check(phase.after);
        assert.equal(phase.after.prewarm.counts.misses, phase.before.prewarm.counts.misses);
        assert.deepEqual(phase.after.settings, phase.before.settings);
        if (mode && kind === 'gpu') assert(!phase.after.motion.completed);
        if (mode && kind === 'timing') {
          await page.waitForFunction(serial => globalThis.__webMotionBenchmark?.serial === serial &&
            __webMotionBenchmark.completed, phase.motionSerial, {timeout: 15000});
          let degrees = 0, distance = 0;
          for (let i = 1; i < phase.samples.length; ++i) {
            const a = phase.samples[i - 1].camera, b = phase.samples[i].camera;
            degrees += Math.abs(((b.yaw - a.yaw + 540) % 360) - 180);
            distance += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          }
          phase.route = {degrees, distance};
          assert(mode === 2 ? degrees > 250 : distance > 600);
        }
        save(); console.log(JSON.stringify({run: run.index, adaptive, name, summary: phase.summary,
          gpuSamples: phase.gpuFrames?.length}));
      }
      if (kind === 'gpu') {
        run.gpuErrors = await owner.evaluate(() => __webPerformanceCapture.errors);
        run.adapter = await owner.evaluate(() => __webPerformanceCapture.adapter);
        assert.equal(run.gpuErrors.length, 0);
      } else {
        await motion(0);
        await page.addStyleTag({content: '#web-performance-hud { visibility: hidden !important; }'});
        run.images = [];
        for (const [name, camera] of [
          ['interior', [-175, -80, 160, -5, 50]],
          ['living', [-20, 200, 130, 12, -35]],
          ['kitchen', [-175, -80, 160, -5, 230]]
        ]) {
          assert.equal(await page.evaluate(camera => __webEngineRPC('WebProjectViewTest', ...camera), camera), 1);
          await page.waitForTimeout(5000);
          const file = path.join(directory, 'run-' + run.index + '-' + name + '.png');
          await page.locator('canvas').first().screenshot({path: file});
          const snapshot = await state(); check(snapshot);
          run.images.push({name, image: audit(file), state: snapshot});
        }
      }
      await page.goto('about:blank');
      await context.close(); context = null;
      log.end(); log = null;
    }
    for (const name of kind === 'gpu' ? ['standing', 'turning'] : ['standing', 'turning', 'moving']) {
      const comparison = {name};
      for (const adaptive of [0, 1]) {
        const phases = report.runs.filter(r => r.adaptive === adaptive).map(r => r.phases.find(p => p.name === name));
        comparison[adaptive ? 'adaptive' : 'baseline'] = kind === 'timing' ? summarize(phases.flatMap(intervals)) :
          Object.fromEntries(variants.variants.map(v => [v.entry, phases.flatMap(p => p.gpuFrames)
            .map(f => f.capture.entries.filter(e => e.pipeline === v.entry).reduce((sum, e) => sum + e.gpuMs, 0))
            .reduce((sum, n, i, a) => sum + n / a.length, 0)]));
      }
      report.comparisons.push(comparison);
    }
    assert.equal(audit(report.package.file).sha256, report.package.sha256);
    report.pass = true; console.log(JSON.stringify(report.comparisons));
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {save(); log?.end(); await context?.close();}
})();
