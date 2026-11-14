'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const profile = require('./villa-engine-comparison-no-lumen.json');
const tag = process.argv.find(value => value.startsWith('--tag='))?.slice(6);
assert(tag && /^[a-z0-9-]+$/.test(tag));
const out = path.join(__dirname, 'results/ue59-no-lumen-' + tag);
assert(!fs.existsSync(out)); fs.mkdirSync(out);
const temporary = path.join(__dirname, 'build/test-tmp');
fs.mkdirSync(temporary, {recursive: true}); process.env.TEMP = process.env.TMP = temporary;
const report = {date: new Date().toISOString(), profile, errors: [], pass: false};
let context;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/ue59-no-lumen-' + tag), {
      channel: 'chrome', headless: false, viewport: {width: 1600, height: 1000}, deviceScaleFactor: 1.5,
      args: ['--window-position=-32000,-32000', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--disable-background-timer-throttling']
    });
    await context.route('**/villa-engine-comparison.html?lighting=off', async route => {
      const response = await route.fetch(), html = await response.text();
      assert(html.includes("official.searchParams.set('prewarm', '1');"));
      await route.fulfill({response, body: html.replace("official.searchParams.set('prewarm', '1');",
        "official.searchParams.set('prewarm', 'capture'); official.searchParams.set('prewarm_capture_s', '30');")});
    });
    const page = context.pages()[0];
    page.on('console', message => {
      const text = message.text(); fs.appendFileSync(path.join(out, 'console.log'), text + '\n');
      if (/GPU validation:|GPUValidationError|Fatal error:|Assertion failed:|WebGPU device lost|HARNESS ABORT/.test(text))
        report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto('http://127.0.0.1:8766/villa-engine-comparison.html?lighting=off#official');
    await page.waitForSelector('iframe');
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    await frame.waitForFunction(() => globalThis.__ue59Performance?.submitted > 120, null, {timeout: 120000});
    await frame.evaluate(keys => {
      for (const key of keys) window.ueExec(key);
      window.ueExec('LogLoc'); window.ueExec('FlushLog');
    }, Object.keys(profile.settings));
    await frame.locator('canvas').focus();
    for (const key of ['w', 'd', 's', 'a']) {
      await page.keyboard.down(key); await page.waitForTimeout(2000); await page.keyboard.up(key);
    }
    let captured;
    for (let attempt = 0; attempt < 50 && !captured; ++attempt) {
      captured = await frame.evaluate(async () => {
        try {
          const logs = await (await navigator.storage.getDirectory()).getDirectoryHandle('logs');
          return await (await (await logs.getFileHandle('webgpu-capture.json')).getFile()).text();
        } catch { return null; }
      });
      if (!captured) await page.waitForTimeout(1000);
    }
    assert(captured, 'Official capture missing');
    const log = await frame.evaluate(async () => {
      const logs = await (await navigator.storage.getDirectory()).getDirectoryHandle('logs');
      return (await (await logs.getFileHandle((window.ueLogFile || 'triplexhousevilla.log').toLowerCase())).getFile()).text();
    });
    fs.writeFileSync(path.join(out, 'engine.log'), log);
    report.actualSettings = {};
    for (const [key, expected] of Object.entries(profile.settings)) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const values = [...log.matchAll(new RegExp(escaped + '\\s*=\\s*"?(-?\\d+(?:\\.\\d+)?)', 'g'))];
      assert(values.length, 'No value for ' + key);
      report.actualSettings[key] = Number(values.at(-1)[1]);
      assert.equal(report.actualSettings[key], expected, key);
    }
    report.metrics = await frame.evaluate(() => __ue59Performance);
    assert.deepEqual(report.metrics.scene, {width: profile.width, height: profile.height});
    assert.deepEqual(report.errors, []);
    fs.writeFileSync(path.join(out, 'webgpu-capture.json'), captured);
    await page.screenshot({path: path.join(out, 'scene.png')});
    report.pass = true;
    console.log(JSON.stringify({pass: true, out, counts: JSON.parse(captured).counts}));
  } catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
  finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    await context?.close();
  }
})();
