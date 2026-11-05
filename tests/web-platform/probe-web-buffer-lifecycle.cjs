'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observe = require('./web-buffer-lifecycle-observer.cjs');
const stutters = require('./web-stutter-observer.cjs');
const validate = require('./web-upload-staging-validator.cjs');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(x => x && /^[a-z0-9-]+$/.test(x)));
const output = path.join(__dirname, 'results', tag);
assert(!fs.existsSync(output + '.json'), 'Use a fresh tag');
const staging = process.argv.includes('--staging');
const compare = process.argv.includes('--compare');
const stress = process.argv.includes('--stress');
assert(!compare || staging);
const report = {date: new Date().toISOString(), folder, staging, pass: false, errors: [], phases: [],
  sources: [__filename, require.resolve('./web-buffer-lifecycle-observer.cjs'), require.resolve('./web-stutter-observer.cjs'), require.resolve('./web-upload-staging-validator.cjs')].map(audit),
  boundary: 'Allocation/lifetime diagnostic with sampled callstacks. No resource retention, fences or rendering overrides. Descriptor bytes are not driver memory. Not a normal FPS acceptance run.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;
const log = fs.createWriteStream(output + '.log');
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, viewport: {width: 2289, height: 1287}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${stutters.toString()})();\n(${observe.toString()})();\n(${validate.toString()})();\n` + await response.text()});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', m => {const text = m.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) report.errors.push(text);});
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90,
      null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    report.browser = context.browser().version();
    const snapshot = () => owner.evaluate(() => ({frame: __webRHIFrames, lifecycle: __webBufferLifecycle,
      camera: globalThis.__webDefaultCamera, view: globalThis.__webRenderView, settings: globalThis.__webProjectSettings,
      stages: globalThis.__webThreadStages, streaming: globalThis.__webTextureStreaming,
      retirement: globalThis.__webGPUHandleDiagnostics, uploadStaging: globalThis.__webUploadStaging, errors: __webStutters.errors}));
    if (staging && !compare) assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 19, 1)), 1);
    await page.waitForTimeout(15000);
    report.initial = await snapshot();
    async function capture(name, action) {
      const before = await snapshot(); await action(); const after = await snapshot();
      const frames = after.frame - before.frame;
      const groups = Object.entries(after.lifecycle.groups).map(([key, g]) => ({...g,
        newCount: g.created - (before.lifecycle.groups[key]?.created || 0),
        freedCount: g.destroyed - (before.lifecycle.groups[key]?.destroyed || 0)})).filter(g => g.newCount || g.freedCount)
        .sort((a, b) => b.newCount - a.newCount);
      report.phases.push({name, before, after, frames, createdPerFrame: (after.lifecycle.created - before.lifecycle.created) / frames, groups});
      console.log(JSON.stringify({name, frames, createdPerFrame: report.phases.at(-1).createdPerFrame,
        groups: groups.slice(0, 14).map(({size, usage, newCount, freedCount}) => ({size, usage, newCount, freedCount}))}));
      assert(!after.errors.length && !report.errors.length, report.errors.join('\n')); save();
    }
    if (compare) {
      await capture('control-standing', () => page.waitForTimeout(10000));
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 19, 1)), 1);
      await page.waitForTimeout(5000);
    }
    await capture('standing', () => page.waitForTimeout(10000));
    const initial = report.initial.camera;
    await capture('tour', async () => {
      for (const yaw of [initial.yaw + 90, initial.yaw + 180, initial.yaw + 270, initial.yaw]) {
        assert.equal(await page.evaluate(p => __webEngineRPC('WebProjectViewTest', p.x, p.y, p.z, p.pitch, p.yaw), {...initial, yaw}), 1);
        await page.waitForTimeout(2500);
      }
    });
    await page.locator('canvas').screenshot({path: output + '.png'});
    report.validation = [];
    for (const enabled of staging ? [1, 0, 1] : []) {
      assert.equal(await page.evaluate(value => __webEngineRPC('WebLightingQualityTest', 19, value), enabled), 1);
      await page.waitForTimeout(1000);
      const result = await owner.evaluate(() => __webValidateUploadCopies(1024));
      assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
      assert.equal(result.completed, 1024);
      assert.equal(result.nonzeroOffsets > 0, !!enabled);
      const state = await snapshot();
      assert(!state.errors.length && !report.errors.length, JSON.stringify([...state.errors, ...report.errors]));
      assert.equal(state.uploadStaging.enabled, !!enabled);
      assert(state.uploadStaging.retainedBytes <= 4 * 1048576);
      if (!enabled) assert.equal(state.uploadStaging.retainedBytes, 0);
      report.validation.push({enabled, result, state}); save();
    }
    report.churn = [];
    if (stress) {
      for (const budget of [64, 256, 64, 1000]) {
        assert.equal(await page.evaluate(value => __webEngineRPC('WebTextureStreamingTestBudget', value), budget), 1);
        let previous, stable = 0;
        for (let i = 0; i < 80 && stable < 3; ++i) {
          await page.waitForTimeout(350);
          const sample = await snapshot(), stream = sample.streaming;
          stable = stream.poolBytes === budget * 1048576 && !stream.pending &&
            stream.requestedMips === stream.residentMips && stream.residentBytes === previous?.streaming.residentBytes ? stable + 1 : 0;
          previous = sample;
        }
        assert(stable >= 3, 'Texture streaming failed to settle');
        report.churn.push({budget, state: previous}); save();
      }
      assert(report.churn.at(-1).state.streaming.residentBytes > report.churn[0].state.streaming.residentBytes);
      report.resizes = [];
      for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}]) {
        await page.setViewportSize(size); await page.waitForTimeout(2000);
        const result = await owner.evaluate(() => __webValidateUploadCopies(512));
        const state = await snapshot();
        assert(!result.errors.length && result.completed === 512 && !state.errors.length && !report.errors.length);
        report.resizes.push({size, result, state}); save();
      }
    }
    report.final = await snapshot();
    assert(!report.final.errors.length && !report.errors.length);
    report.pass = true;
  } catch (error) {report.error = error.stack; process.exitCode = 1; console.error(error.stack);}
  finally {save(); await context?.close(); log.end();}
})();
