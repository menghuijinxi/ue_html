'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const ledger = require('./web-resource-ledger.cjs');
const performanceObserver = require('./web-performance-capture-observer.cjs');
const processMemory = require('./gpu-process-memory.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const baseline = process.argv.includes('--baseline');
const seconds = Number(option('seconds') || 12);
assert(seconds >= 5 && seconds <= 60);
const entries = {};
const conversion = option('conversion');
if (conversion) {
  const cookRoot = path.dirname(path.dirname(path.resolve(conversion)));
  for (const item of fs.readdirSync(cookRoot, {withFileTypes: true})) {
    if (!item.isDirectory()) continue;
    const directory = path.join(cookRoot, item.name, 'ShaderConversion');
    if (!fs.existsSync(directory)) continue;
    for (const job of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!job.isDirectory()) continue;
      const input = path.join(directory, job.name, 'input.json');
      if (!fs.existsSync(input)) continue;
      const shader = JSON.parse(fs.readFileSync(input, 'utf8'));
      if (/Translucent.*(Inject|VolumeCS)|InjectAmbientCubemapCS/.test(shader.shaderName))
        entries[shader.metadata.webEntry] = shader.shaderName;
    }
  }
}
assert(baseline || Object.values(entries).includes('FWebTranslucentLightingInjectCS'), 'Use --conversion with the actual new Cook');
const output = path.join(__dirname, 'results', 'web-translucency-' + tag);
const profile = path.join(__dirname, 'build/browser-profiles', 'tlv-' + tag);
const report = {date: new Date().toISOString(), folder, baseline, seconds, pass: false, errors: [], runs: [],
  qualityOverrides: [], diagnosticOverrides: baseline ? [] : [{'r.TranslucencyLightingVolume': [1, 0, 0, 1]}],
  boundary: '1280x720, same fixed camera and runtime settings. Allocation/dispatch counters remain active; detailed API timing is disabled during present-rate windows. Separate GPU timestamp samples. Logical allocations and WDDM dedicated bytes are reported separately.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));

// Observe real compute dispatches and read the generated 3D lighting, not just shader availability.
const observeVolumes = require('./web-tlv-observer.cjs');

let context;
const log = fs.createWriteStream(output + '.log');
(async () => {
  try {
    context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: [ledger, performanceObserver]
        .map(fn => `(${fn.toString()})();\n`).join('') +
        `(${observeVolumes.toString()})(${JSON.stringify(entries)});\n` + await response.text()});
    });
    const page = context.pages()[0];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) report.errors.push(text);
    });
    const start = performance.now();
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 60,
      null, {timeout: 900000});
    report.startupMs = performance.now() - start;
    report.startupFailure = await page.evaluate(() => globalThis.__webEngineFailure || null);
    assert(!report.startupFailure, String(report.startupFailure));
    await page.waitForFunction(() => !globalThis.__webPSOPrecacheExpected || globalThis.__webPSOPrecacheReady,
      null, {timeout: 180000});
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    const snapshot = () => owner.evaluate(() => ({frame: globalThis.__webRHIFrames,
      gameFrame: globalThis.__webEngineFrames, camera: globalThis.__webDefaultCamera,
      settings: globalThis.__webProjectSettings, view: globalThis.__webRenderView,
      stages: globalThis.__webThreadStages, probe: globalThis.__webTLVProbe,
      memory: globalThis.__webResourceLedger(), adapter: globalThis.__webPerformanceCapture.adapter,
      gpuErrors: globalThis.__webPerformanceCapture.errors, failure: globalThis.__webEngineFailure}));
    report.initial = await snapshot();
    assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', -175, -80, 160, -5, 50)), 1);
    await page.waitForTimeout(5000);
    report.defaultVolumes = await owner.evaluate(() => __webReadTLV());
    assert(report.defaultVolumes.length >= 4, 'Read back both cascades and both SH textures');
    assert(report.defaultVolumes.every(texture => texture.invalid === 0));
    if (baseline) assert(report.defaultVolumes.every(texture => texture.energy < 1e-5), 'Old runtime must reproduce missing injection');
    else assert(report.defaultVolumes.some(texture => texture.energy > 1), 'Actual generated TLV must contain lighting');
    for (const [index, enabled] of (baseline ? [null, null] : [1, 0, 0, 1]).entries()) {
      if (enabled !== null)
        assert.equal(await page.evaluate(value => __webEngineRPC('WebLightingQualityTest', 15, value), enabled), 1);
      await page.waitForTimeout(5000);
      const before = await snapshot(), time = performance.now();
      await page.waitForTimeout(seconds * 1000);
      const after = await snapshot(), elapsedMs = performance.now() - time;
      assert(!after.failure && !report.errors.length && !after.gpuErrors.length, JSON.stringify(report.errors));
      assert.deepEqual(after.camera, before.camera);
      assert.deepEqual(after.settings, report.initial.settings);
      const frames = after.frame - before.frame;
      assert(frames > 5);
      if (!baseline) {
        for (const name of ['FWebTranslucentLightingInjectCS', 'FFilterTranslucentVolumeCS']) {
          const dispatched = (after.probe.dispatches[name] || 0) - (before.probe.dispatches[name] || 0);
          assert(enabled ? dispatched > frames : dispatched === 0, `${name}: enabled=${enabled}, dispatches=${dispatched}`);
        }
      }
      const run = {index, enabled, frames, elapsedMs, fps: frames * 1000 / elapsedMs,
        msPerFrame: elapsedMs / frames,
        rhiMs: (after.stages.rhiWorkMilliseconds - before.stages.rhiWorkMilliseconds) / frames,
        before, after, gpuFrames: [], wddm: processMemory({profile})};
      report.runs.push(run); save();
      for (let sample = 0; sample < 3; ++sample)
        run.gpuFrames.push(await owner.evaluate(() => __webCaptureGPUFrame()));
      await page.locator('canvas').screenshot({path: `${output}-${index}.png`, timeout: 60000});
      console.log(JSON.stringify({index, enabled, fps: run.fps, msPerFrame: run.msPerFrame,
        rhiMs: run.rhiMs, logicalTextureMiB: after.memory.textureBytes / 1048576,
        wddmMiB: run.wddm.dedicated / 1048576}));
      save();
    }
    if (!baseline) {
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 15, 1)), 1);
      await page.waitForTimeout(2000);
      report.restoredVolumes = await owner.evaluate(() => __webReadTLV());
      assert(report.restoredVolumes.some(texture => texture.energy > 1));
      assert(report.restoredVolumes.every(texture => texture.invalid === 0));
      await page.setViewportSize({width: 960, height: 540});
      await page.waitForTimeout(3000);
      assert.equal(await page.evaluate(() => __webEngineRPC('WebProjectViewTest', -175, -80, 160, -5, 230)), 1);
      await page.waitForTimeout(3000);
      await page.setViewportSize({width: 1280, height: 720});
      await page.waitForTimeout(3000);
    }
    report.final = await snapshot();
    assert(!report.errors.length && !report.final.gpuErrors.length && !report.final.failure);
    assert.deepEqual(report.final.memory.unknownFormats, []);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (context) {
      report.lastPageState = await context.pages()[0]?.evaluate(() => ({
        failure: globalThis.__webEngineFailure, frames: globalThis.__webEngineFrames,
        startup: globalThis.__webStartupDiagnostics
      })).catch(() => null);
    }
    save(); await context?.close(); log.end();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));
  }
})();
