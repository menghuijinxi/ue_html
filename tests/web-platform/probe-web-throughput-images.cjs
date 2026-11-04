'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(x => x.startsWith('--' + name + '='))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag');
assert([folder, tag].every(x => x && /^[a-z0-9-]+$/.test(x)));
const output = path.join(__dirname, 'results', tag); assert(!fs.existsSync(output + '.json'));
const report = {date: new Date().toISOString(), pass: false, folder, source: audit(__filename), views: [], errors: [],
  boundary: 'Visual diagnostic after tour warmup. Every candidate is bracketed by controls at the same camera. Render time frozen, original quality and pool, full threading. Descriptor validation disabled here; validated separately. Temporal control drift is retained for image comparison.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context; const log = fs.createWriteStream(output + '.log');
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: false, viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.route('**/index.html', async route => {
      const response = await route.fetch(); let html = await response.text();
      const match = html.match(/arguments: (\[[^\n]+\]),/); assert(match);
      const args = JSON.parse(match[1]); args.push('-WebVisualTestClock', '-WebThreadingTest=full');
      html = html.replace(match[0], 'arguments: ' + JSON.stringify(args) + ',');
      await route.fulfill({response, body: html});
    });
    const page = context.pages()[0], cdp = await context.newCDPSession(page);
    await cdp.send('Input.setIgnoreInputEvents', {ignore: true});
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    page.on('pageerror', e => report.errors.push(e.message));
    page.on('console', m => {const text = m.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed|Ensure condition failed/.test(text)) report.errors.push(text);});
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90, null, {timeout: 180000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(w => w.url().includes('web-engine-worker.js')); assert(owner);
    const rpc = async (name, ...args) => assert.equal(await page.evaluate(p => __webEngineRPC(p.name, ...p.args), {name, args}), 1);
    const state = () => owner.evaluate(() => ({frame: __webRHIFrames, camera: globalThis.__webDefaultCamera,
      streaming: globalThis.__webTextureStreaming, view: globalThis.__webRenderView,
      settings: globalThis.__webProjectSettings, occlusion: globalThis.__webOcclusionRHI, failure: globalThis.__webEngineFailure}));
    const initial = report.initial = await state(), camera = initial.camera;
    const views = [camera, ...[90, 180, 270].map(yaw => ({...camera, yaw: camera.yaw + yaw})),
      {x: -175, y: -80, z: 160, pitch: -5, yaw: 50}];
    for (const view of views) {
      await rpc('WebProjectViewTest', view.x, view.y, view.z, view.pitch, view.yaw);
      await page.waitForTimeout(2500);
    }
    for (let index = 0; index < views.length; ++index) {
      const view = views[index]; await rpc('WebProjectViewTest', view.x, view.y, view.z, view.pitch, view.yaw);
      await page.waitForTimeout(5000);
      const entry = {view, images: []}; report.views.push(entry);
      for (const mode of ['control', 'binding', 'control', 'tlv', 'control', 'combined', 'control']) {
        await rpc('WebLightingQualityTest', 16, Number(mode === 'binding' || mode === 'combined'));
        await rpc('WebLightingQualityTest', 17, Number(mode === 'tlv' || mode === 'combined'));
        await page.waitForTimeout(2000);
        const snapshot = await state();
        assert(!report.errors.length && !snapshot.failure, report.errors.join('\n'));
        assert.deepEqual(snapshot.settings, initial.settings);
        if (entry.images.length) {
          assert.deepEqual(snapshot.camera, entry.images[0].snapshot.camera);
          assert.equal(snapshot.streaming.residentBytes, entry.images[0].snapshot.streaming.residentBytes);
        }
        assert.equal(snapshot.streaming.pending, 0);
        const file = `${output}-${index}-${entry.images.length}-${mode}.png`;
        await page.locator('canvas').screenshot({path: file});
        entry.images.push({mode, snapshot, screenshot: audit(file)}); save();
      }
      console.log(JSON.stringify({view: index, images: entry.images.length}));
    }
    report.pass = true;
  } catch (error) {report.error = error.stack; process.exitCode = 1; console.error(error.stack);}
  finally {save(); await context?.close(); log.end();}
})();
