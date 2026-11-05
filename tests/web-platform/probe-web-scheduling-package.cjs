'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = option('folder'), tag = option('tag'), archive = option('archive');
assert(folder && tag && [folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const base = path.join(__dirname, 'build', folder);
const output = path.join(__dirname, 'results', tag);
const evidence = path.join(__dirname, 'evidence', tag + '.json');
assert(!fs.existsSync(output + '.json') && !fs.existsSync(evidence), 'Preserve earlier verification');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, folder,
  source: audit(__filename), archive: archive ? audit(path.resolve(archive)) : undefined,
  packageInfo: read(path.join(base, 'package-info.json')), files: [], runs: [],
  boundary: 'Imported package integrity and functional startup checks only. No recook or configuration changes. Headless browser probes are not performance comparisons or visual parity acceptance.'};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2) + '\n');
let context, log;
(async () => {
  try {
    const versions = read(path.join(base, 'asset-versions.json'));
    for (const [name, expected] of Object.entries(versions)) {
      assert.equal(path.basename(name), name);
      const file = path.join(base, name), actual = audit(file);
      assert.equal(fs.statSync(file).size, expected.size, name);
      assert.equal(actual.sha256, expected.sha256, name);
      report.files.push({...actual, size: expected.size});
    }
    for (const name of ['asset-versions.json', 'comparison.html', 'package-info.json'])
      report.files.push(audit(path.join(base, name)));
    const comparisonURL = `http://127.0.0.1:8765/build/${folder}/comparison.html`;
    const comparison = await fetch(comparisonURL);
    assert.equal(comparison.status, 200);
    assert.equal(comparison.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(comparison.headers.get('cross-origin-embedder-policy'), 'require-corp');
    report.comparisonURL = comparisonURL;
    save();
    for (const clock of ['owner', 'local']) {
      const run = {clock, errors: [], url:
        `http://127.0.0.1:8765/build/${folder}/index.html?occlusion=history&clock=${clock}&rhiwake=priority`};
      report.runs.push(run); save();
      const profile = path.join(os.tmpdir(), 'ue-web-import-profiles', tag + '-' + clock);
      assert(!fs.existsSync(profile), 'Use a fresh browser profile');
      context = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
        viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
      const page = context.pages()[0];
      log = fs.createWriteStream(output + '-' + clock + '.log');
      page.on('console', message => {
        const text = message.text(); log.write(text + '\n');
        if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text))
          run.errors.push(text);
      });
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('crash', () => run.errors.push('Renderer crashed'));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
      await page.goto(run.url, {waitUntil: 'commit'});
      const advance = async count => {
        const before = await page.evaluate(() => globalThis.__webEngineFrames || 0);
        await page.waitForFunction(frame => globalThis.__webEngineFailure ||
          globalThis.__webEngineFrames >= frame, before + count, {timeout: 180000});
        const failure = await page.evaluate(() => globalThis.__webEngineFailure);
        assert(!failure, JSON.stringify(failure));
        assert.deepEqual(run.errors, []);
      };
      await advance(90);
      const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      assert(owner);
      const cameraBefore = await owner.evaluate(() => globalThis.__webDefaultCamera);
      await page.locator('canvas').focus();
      await page.mouse.move(700, 400);
      await page.mouse.down({button: 'right'});
      await page.mouse.move(850, 420, {steps: 24});
      await page.mouse.up({button: 'right'});
      await advance(30);
      run.state = await owner.evaluate(() => ({
        clock: globalThis.__webGameFrameClock, rhiWake: globalThis.__webRHIWakeScheduler,
        history: globalThis.__webOcclusionHistory, settings: globalThis.__webProjectSettings,
        view: globalThis.__webRenderView, camera: globalThis.__webDefaultCamera,
        arguments: Module.arguments, frames: globalThis.__webEngineFrames,
      }));
      assert.equal(run.state.clock.mode, clock);
      assert.equal(run.state.history.enabled, true);
      assert.equal(run.state.rhiWake.requested, 'priority');
      assert.equal(run.state.rhiWake.active, run.state.rhiWake.prioritySupported ? 'priority' : 'channel');
      assert.equal(run.state.arguments.includes('-WebGameLocalClock'), clock === 'local');
      assert.equal(run.state.settings.gi, 0, 'Imported v71 package must retain Lumen OFF');
      assert.equal(run.state.settings.reflections, 0);
      assert(Math.abs(run.state.camera.yaw - cameraBefore.yaw) > 0.1 ||
        Math.abs(run.state.camera.pitch - cameraBefore.pitch) > 0.1, 'Mouse must rotate the camera');
      run.input = await page.evaluate(() => globalThis.__webInputBridge);
      assert(run.input.acknowledged > 0);
      const image = output + '-' + clock + '.png';
      await page.locator('canvas').screenshot({path: image, timeout: 60000});
      const png = PNG.sync.read(fs.readFileSync(image));
      let lit = 0;
      for (let offset = 0; offset < png.data.length; offset += 4)
        if (png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 24) lit++;
      assert(lit / (png.width * png.height) > 0.3, 'Villa scene must be visible');
      run.image = audit(image);
      run.pass = true; save();
      console.log(JSON.stringify({clock, pass: true, state: run.state.clock, url: run.url}));
      await context.close(); context = null;
      await new Promise(resolve => log.end(resolve)); log = null;
    }
    assert.deepEqual(report.runs[0].state.settings, report.runs[1].state.settings);
    for (const file of report.files)
      assert.equal(audit(file.file).sha256, file.sha256, 'Package files must remain unchanged');
    report.pass = true;
    fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    report.failure = error.stack; process.exitCode = 1;
    if (context) report.startup = await context.pages()[0]?.evaluate(() => ({
      failure: globalThis.__webEngineFailure, diagnostics: globalThis.__webStartupDiagnostics,
    })).catch(() => null);
  } finally {
    save();
    await context?.close();
    if (log) await new Promise(resolve => log.end(resolve));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, evidence, output}));
  }
})();
