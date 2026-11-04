'use strict';
// Correctness and GPU diagnostics are deliberately outside normal FPS windows.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const observeVolumes = require('./web-tlv-observer.cjs');
const observeGPU = require('./web-performance-capture-observer.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(x => x && /^[a-z0-9-]+$/.test(x)));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
const report = {date: new Date().toISOString(), pass: false, folder, errors: [], phases: [], logs: [],
  sources: [__filename, require.resolve('./web-tlv-observer.cjs'), require.resolve('./web-performance-capture-observer.cjs')].map(audit),
  diagnosticOverrides: {renderTimeFrozen: true, bindingValidation: true, streamingBudgetsMiB: [64, 256, 1000]},
  boundary: 'Correctness/GPU diagnostic only. Same Cook and quality, frozen render time. GPU timestamps and volume readbacks never enter the normal FPS benchmark. The combined mode checks interactions only.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;
const log = fs.createWriteStream(output + '.log');
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.route('**/index.html', async route => {
      const response = await route.fetch(); let html = await response.text();
      const match = html.match(/arguments: (\[[^\n]+\]),/); assert(match);
      const args = JSON.parse(match[1]);
      assert(!args.some(x => /WebVisualTestClock|WebThreadingTest/.test(x)));
      args.push('-WebVisualTestClock', '-WebThreadingTest=full');
      html = html.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',');
      await route.fulfill({response, body: html});
    });
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observeGPU.toString()})();\n(${observeVolumes.toString()})({});\n` + await response.text()});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', m => {
      const text = m.text(); log.write(text + '\n');
      if (/WebGPU TLV experiment:/.test(text)) report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(text)) report.errors.push(text);
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90,
      null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    const rpc = async (name, ...args) => assert.equal(await page.evaluate(p => __webEngineRPC(p.name, ...p.args), {name, args}), 1);
    const state = () => owner.evaluate(() => ({frame: __webRHIFrames, camera: globalThis.__webDefaultCamera,
      view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings, occlusion: globalThis.__webOcclusionRHI,
      streaming: globalThis.__webTextureStreaming, gpuErrors: __webPerformanceCapture.errors,
      failure: globalThis.__webEngineFailure, clock: globalThis.__webVisualTestClock}));
    report.initial = await state(); report.browser = context.browser().version();
    const initial = report.initial.camera;
    const views = [initial, ...[90, 180, 270].map(yaw => ({...initial, yaw: initial.yaw + yaw})),
      {x: -175, y: -80, z: 160, pitch: -5, yaw: 50}];
    for (const mode of ['control', 'binding', 'tlv', 'combined']) {
      await rpc('WebLightingQualityTest', 16, Number(mode === 'binding' || mode === 'combined'));
      await rpc('WebLightingQualityTest', 17, Number(mode === 'tlv' || mode === 'combined'));
      await rpc('WebLightingQualityTest', 18, Number(mode === 'binding' || mode === 'combined'));
      const phase = {mode, views: []}; report.phases.push(phase);
      for (let index = 0; index < views.length; ++index) {
        const view = views[index]; await rpc('WebProjectViewTest', view.x, view.y, view.z, view.pitch, view.yaw);
        await page.waitForTimeout(3500);
        const snapshot = await state();
        assert(!snapshot.failure && !snapshot.gpuErrors.length && !report.errors.length, report.errors.join('\n'));
        assert.deepEqual(snapshot.settings, report.initial.settings);
        const volumes = await owner.evaluate(() => __webReadTLV());
        assert(volumes.length >= 4 && volumes.every(v => v.invalid === 0) && volumes.some(v => v.energy > 1));
        const file = `${output}-${mode}-${index}.png`;
        await page.locator('canvas').screenshot({path: file});
        phase.views.push({view, snapshot, volumes, screenshot: audit(file)}); save();
      }
      phase.gpuFrames = [];
      for (let i = 0; i < 3; ++i) phase.gpuFrames.push(await owner.evaluate(() => __webCaptureGPUFrame()));
      console.log(JSON.stringify({mode, views: phase.views.length, validation: phase.views.at(-1).snapshot.occlusion.bindingPlanValidations}));
      save();
    }
    // Exercise actual TextureReference retargeting, resource retirement and resize
    // with full descriptor rebuilding enabled. Restore the original pool afterwards.
    report.churn = [];
    for (const budget of [64, 256, 64, 1000]) {
      await rpc('WebTextureStreamingTestBudget', budget);
      let previous, stable = 0;
      for (let i = 0; i < 80 && stable < 3; ++i) {
        await page.waitForTimeout(350);
        const sample = await state(), streaming = sample.streaming;
        assert(!report.errors.length && !sample.gpuErrors.length && !sample.failure, report.errors.join('\n'));
        if (streaming.poolBytes === budget * 1048576 && !streaming.pending &&
          streaming.requestedMips === streaming.residentMips && streaming.residentBytes === previous?.streaming.residentBytes) ++stable;
        else stable = 0;
        previous = sample;
      }
      assert(stable >= 3, 'Texture streaming failed to settle'); report.churn.push({budget, ...previous}); save();
    }
    assert(report.churn.at(-1).streaming.residentBytes > report.churn[0].streaming.residentBytes,
      'The resource lifecycle check must actually restore streamed mips');
    for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}]) {
      await page.setViewportSize(size); await page.waitForTimeout(3000);
    }
    report.final = await state();
    assert(report.final.occlusion.bindingPlanValidations > report.initial.occlusion.bindingPlanValidations);
    assert(report.final.occlusion.bindingEntriesValidated > report.initial.occlusion.bindingEntriesValidated);
    assert(!report.errors.length && !report.final.gpuErrors.length && !report.final.failure);
    report.pass = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error.stack); }
  finally {save(); await context?.close(); log.end();}
})();
