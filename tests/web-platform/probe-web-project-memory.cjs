const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observe = require('./web-gpu-memory-observer.cjs');
const memory = require('./gpu-process-memory.cjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
const seconds = Number(option('seconds') || 90);
assert(seconds >= 10 && seconds <= 600);
const profile = path.join(__dirname, 'build/browser-profiles', 'memory-' + tag);
const output = path.join(__dirname, 'results', 'project-memory-' + tag);
const consoleLog = fs.createWriteStream(output + '.log');
const report = {date: new Date().toISOString(), folder, tag, seconds, samples: [], errors: [],
  settingsOverrides: [], pass: false, width: 1280, height: 720};
let context, page;
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
(async () => {
  try {
    context = await chromium.launchPersistentContext(profile, {channel: 'msedge',
      headless: !process.argv.includes('--visible'), viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.addInitScript(observe);
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
    });
    page = context.pages()[0];
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const value = message.text();
      consoleLog.write(value + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(value))
        report.errors.push(value);
      (report.logs ||= []).push(value);
      if (report.logs.length > 50) report.logs.shift();
    });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 60,
      null, {timeout: 900000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure),
      await page.evaluate(() => String(globalThis.__webEngineFailure)));
    report.startupMilliseconds = Date.now() - start;
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js')) || page;
    const snapshot = async label => {
      const state = await owner.evaluate(() => ({memory: __webGPUMemorySnapshot(),
        frame: __webEngineFrames, camera: globalThis.__webDefaultCamera,
        view: globalThis.__webRenderView, streaming: globalThis.__webTextureStreaming,
        occlusion: globalThis.__webOcclusionRHI, lighting: globalThis.__webDistanceFieldsLighting,
        distanceFields: globalThis.__webDistanceFields, settings: globalThis.__webProjectSettings,
        retirement: globalThis.__webGPUHandleDiagnostics}));
      const sample = {label, elapsedMilliseconds: Date.now() - start, ...state, wddm: memory({profile})};
      report.samples.push(sample);
      assert(!state.memory.errors.length, state.memory.errors.join('\n'));
      assert(!report.errors.length, report.errors.join('\n'));
      save();
      console.log(JSON.stringify({label, frame: sample.frame, liveBytes: sample.memory.totals,
        dedicatedMiB: sample.wddm.dedicated / 1048576, liveCount: sample.memory.live.length}));
    };
    await snapshot('startup');
    const views = [[-175, -80, 160, -5, 50], [-175, -80, 160, -5, 230],
      [-175, -80, 160, -5, 50]];
    const before = report.samples[0].frame;
    for (let step = 0; step < 3; ++step) {
      const result = await page.evaluate(async values => typeof __webEngineRPC === 'function' ?
        __webEngineRPC('WebProjectViewTest', ...values) : Module._WebProjectViewTest(...values), views[step]);
      assert.equal(result, 1);
      await page.waitForTimeout(seconds * 1000 / 3);
      await snapshot(['room', 'wall', 'room-return'][step]);
      await page.locator('canvas').screenshot({path: output + '-' + step + '.png', timeout: 60000});
    }
    assert(report.samples.at(-1).frame > before + 30, 'The game must keep rendering throughout the test');
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    save();
    await context?.close();
    consoleLog.end();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));
  }
})();
