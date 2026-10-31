'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'villa-insights-candidate', tag = option('tag') || 'villa-insights';
const seconds = Number(option('seconds') || 8), repeats = Number(option('repeats') || 2);
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
assert(seconds >= 1 && seconds <= 30 && Number.isInteger(repeats) && repeats >= 1 && repeats <= 3);
const output = path.join(__dirname, 'results', tag), errors = [];
const report = {date: new Date().toISOString(), folder, seconds, settingsOverrides: [], captures: [], errors, pass: false};
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/ue-trace'),
      {channel: 'msedge', headless: false, viewport: {width: 1863, height: 1030}, deviceScaleFactor: 1.25,
        acceptDownloads: true});
    const page = context.pages()[0];
    log = fs.createWriteStream(output + '.log');
    page.on('pageerror', error => errors.push(error.message));
    page.on('crash', () => errors.push('Renderer crashed'));
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) errors.push(text);
    });
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90,
      null, {timeout: 900000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner);
    const state = () => owner.evaluate(() => ({frames: __webRHIFrames, gameFrames: __webEngineFrames,
      threads: __webEngineThreads, camera: __webDefaultCamera, view: __webRenderView,
      settings: __webProjectSettings, streaming: __webTextureStreaming}));
    report.before = await state();
    const start = performance.now();
    await page.waitForTimeout(10000);
    report.baseline = {frames: (await state()).frames - report.before.frames, milliseconds: performance.now() - start};
    report.baseline.fps = report.baseline.frames / report.baseline.milliseconds * 1000;
    for (let index = 0; index < repeats; ++index) {
      const before = await state(), start = performance.now();
      let size;
      if (index === 0 && seconds === 8) {
        // Exercise the same button and browser download used by a human.
        const downloadReady = page.waitForEvent('download', {timeout: 90000});
        await page.locator('#capture-ue-trace').click();
        const download = await downloadReady;
        await download.saveAs(output + `-${index}.utrace`);
        size = fs.statSync(output + `-${index}.utrace`).size;
      } else {
        size = await page.evaluate(seconds => __webCaptureUETrace(seconds), seconds);
        const downloadReady = page.waitForEvent('download');
        await page.evaluate(() => __webDownloadUETrace());
        await (await downloadReady).saveAs(output + `-${index}.utrace`);
      }
      const milliseconds = performance.now() - start, after = await state();
      const bytes = fs.readFileSync(output + `-${index}.utrace`);
      assert(bytes.length === size && size > 1024);
      report.captures.push({file: output + `-${index}.utrace`, bytes: size,
        headerHex: bytes.subarray(0, 16).toString('hex'), before, after,
        milliseconds, frames: after.frames - before.frames, fps: (after.frames - before.frames) / milliseconds * 1000});
      console.log(JSON.stringify(report.captures.at(-1)));
    }
    await page.locator('canvas').screenshot({path: output + '-scene.png', timeout: 60000});
    assert(!errors.length);
    report.pass = true;
  } finally {
    fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
    await context?.close(); log?.end();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
