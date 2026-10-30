const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder') || 'triplex-house-villa-df-distance-fields-threads';
const channel = process.argv.includes('--chrome') ? 'chrome' : 'msedge';
const runs = Number(option('runs') || 4);
const tag = option('tag') || 'baseline';
const extraArgs = option('browser-args') ? JSON.parse(option('browser-args')) : [];
assert(/^[a-z0-9-]+$/.test(folder) && /^[a-z0-9-]+$/.test(tag));
assert(Number.isInteger(runs) && runs > 0 && runs <= 20);
assert(Array.isArray(extraArgs) && extraArgs.every(value => typeof value === 'string'));
const results = path.join(__dirname, 'results');
const report = {date: new Date().toISOString(), pass: false, folder, channel, runs, extraArgs,
  source: audit(__filename), samples: [], crashes: [], errors: [], logs: [],
  boundary: 'Own browser profile; normal engine clock and unmodified shaders. Passing repeated starts is not proof that the reported intermittent crash is fixed.'};
let context, page;
const snapshot = () => page.evaluate(() => ({frames: globalThis.__webEngineFrames || 0,
  failure: globalThis.__webEngineFailure, ready: globalThis.__webEngineReady,
  surface: globalThis.__webEngineSurface, runtime: globalThis.__webEngineRuntime,
  memory: globalThis.__webTextureStreaming, io: globalThis.__webLocalContentStats}));
(async () => {
  try {
    const packageFile = path.join(results, folder.startsWith('ue-default-template') ?
      `web-default-template${folder.slice('ue-default-template'.length)}-package-results.json` :
      `web-project-${folder}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass);
    for (const item of packaged.products) assert.equal(audit(item.file).sha256, item.sha256);
    report.package = audit(packageFile);
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles/lifecycle-' + channel),
      {channel, headless: !process.argv.includes('--headful'), viewport: {width: 1638, height: 810},
        deviceScaleFactor: 1.25, args: extraArgs});
    page = context.pages()[0] || await context.newPage();
    const session = await context.newCDPSession(page);
    report.browser = await session.send('Browser.getVersion');
    await session.detach();
    page.on('crash', () => report.crashes.push({run: report.operation, time: new Date().toISOString()}));
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', message => {
      const text = message.text();
      if (report.logs.length >= 160) report.logs.shift();
      report.logs.push(text);
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|WebGPU device lost/.test(text))
        report.errors.push(text);
    });
    for (let run = 0; run < runs; ++run) {
      report.operation = {run, phase: 'navigate'};
      const url = `http://127.0.0.1:8765/build/${folder}/index.html`;
      if (run) await page.reload({waitUntil: 'commit'});
      else await page.goto(url, {waitUntil: 'commit'});
      report.operation.phase = 'startup';
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 180,
        undefined, {timeout: 180000});
      const value = await snapshot();
      report.samples.push({run, ...value});
      assert(!value.failure, value.failure);
      assert.equal(value.ready?.shaderPlatform, 47);
      assert.deepEqual(report.crashes, []);
      assert.deepEqual(report.errors, []);
      console.log(JSON.stringify({run, frames: value.frames, surface: value.surface}));
      report.operation.phase = 'resize';
      await page.setViewportSize(run % 2 ? {width: 1638, height: 810} : {width: 1280, height: 720});
      await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
        value.frames + 90, {timeout: 90000});
      const resized = await snapshot();
      report.samples.push({run, phase: 'resized', ...resized});
      assert(!resized.failure, resized.failure);
      assert.deepEqual(report.crashes, []);
      assert.deepEqual(report.errors, []);
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    if (page) report.final = await snapshot().catch(() => null);
  } finally {
    await context?.close();
    const file = path.join(results, `web-browser-lifecycle-${channel}-${tag}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
