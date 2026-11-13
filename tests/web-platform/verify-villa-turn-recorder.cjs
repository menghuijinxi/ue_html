'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('./project-output.cjs');
initializeProjectOutput();
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {createRecorder} = require('./villa-turn-recorder.js');
const server = require('./serve.cjs');
const recorder = createRecorder(), origin = 100000;
recorder.start({mode: 'pages'}, origin + 10);
const batch = {timeOrigin: origin, at: 60, times: [0, 12, 28, 44], events: []};
recorder.ingest(batch, {camera: {yaw: 20}});
recorder.ingest(batch, {camera: {yaw: 20}});
recorder.ingest({timeOrigin: origin, at: 190, times: [161, 177], events: [{name: 'createComputePipeline', start: 90, end: 150}]},
  {camera: {yaw: 160}, io: {diskReads: 4}});
assert.deepEqual(recorder.active.frames.map(frame => frame.ms), [null, 16, 16, 117, 16]);
assert.equal(recorder.summary().maxMs, 117); assert.equal(recorder.summary().over100, 1);
assert.equal(recorder.active.frames[3].context, 1); assert.equal(recorder.active.contexts.length, 2);
recorder.stop();
assert.equal(recorder.records[0].summary.worst[0].ms, 117);
recorder.start({mode: 'large'}, origin + 200);
recorder.ingest({timeOrigin: origin, at: 260, times: [210, 230, 250]}, {});
recorder.interrupt('version-switch');
assert.equal(recorder.records.length, 2); assert.equal(recorder.records[1].frames[0].ms, null);
assert.equal(recorder.records[1].reason, 'version-switch');
const report = {date: new Date().toISOString(), pass: false, scope: 'Recorder and export functionality with synthetic timestamps. No engine run or performance comparison.'};
let browser;
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.1:' + server.address().port;
    const post = (data, headers = {}) => fetch(address + '/__diagnostics/villa-turn', {method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: address, ...headers}, body: JSON.stringify(data)});
    assert.equal((await post(recorder.export(), {Origin: 'http://other.invalid'})).status, 403);
    assert.equal((await post({version: 1, kind: 'villa-manual-turn', records: []})).status, 400);
    const {chromium} = require('playwright');
    const profile = assertProjectOutputTree(path.join(__dirname, 'build/browser-profiles/turn-recorder-ui'));
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      viewport: {width: 1500, height: 900}, downloadsPath: assertProjectOutput(path.join(profile, 'downloads'))});
    const page = browser.pages()[0] || await browser.newPage(), errors = report.errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Exercise real UI and HTTP export without starting another UE instance.
    await page.route('**/villa-smoothness-live.js', route => route.fulfill({contentType: 'text/javascript', body: `
      const frame=document.createElement('iframe');frame.src='/recorder-fixture.html';document.getElementById('stage').prepend(frame);
      frame.onload=()=>{window.__villaGitHistory={ready:true,busy:false,mode:'pages'};
        document.getElementById('loading').hidden=true;};`}));
    await page.route('**/recorder-fixture.html', route => route.fulfill({contentType: 'text/html',
      headers: {'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Opener-Policy': 'same-origin'}, body: `
      <canvas id="canvas" tabindex="0" style="width:100%;height:100%;background:#223a30"></canvas>
      <script>const localRuntimeAssets={"wasm":{"sha256":"fixture-wasm"},"versions":{"web-engine-worker.js":"fixture-worker"}};
      const options={arguments: ["-webgpu","-ForceRes"],};
      window.__webDefaultCamera={x:1,y:2,z:3,yaw:50,pitch:-5};
      window.__webLivePerformance={submitted:{maxMs:117}};
      window.__webPipelinePrewarm={ready:true,adopted:true,counts:{hits:320,misses:0}};
      </script>`}));
    await page.goto(address + '/villa-git-history-live.html#pages');
    await page.waitForFunction(() => !document.getElementById('record').disabled);
    await page.locator('#record').click();
    await page.evaluate(() => {
      const scene = document.querySelector('iframe').contentWindow, epoch = performance.timeOrigin + performance.now();
      scene.__webFramePacing = {timeOrigin: epoch, at: 150, times: [1, 17, 134], events: []};
    });
    await page.waitForFunction(() => __villaTurnRecorder.summary().over100 === 1);
    await page.locator('#record').click();
    assert((await page.locator('#capture-status').textContent()).includes('117.0 ms'));
    assert.equal(await page.evaluate(() => __villaTurnRecorder.records[0].metadata.wasm), 'fixture-wasm');
    assert.deepEqual(await page.evaluate(() => __villaTurnRecorder.records[0].metadata.arguments), ['-webgpu', '-ForceRes']);
    await page.locator('#record').click();
    await page.evaluate(() => __villaGitHistory.mode = 'large');
    await page.waitForFunction(() => !__villaTurnRecorder.active);
    assert.equal(await page.evaluate(() => __villaTurnRecorder.records[1].reason), 'version-switch-or-scene-unavailable');
    await page.locator('#save-capture').click();
    await page.waitForFunction(() => document.getElementById('capture-file').hasAttribute('href'), null, {timeout: 30000});
    const saved = await fetch(new URL(await page.locator('#capture-file').getAttribute('href'), address)).then(response => response.json());
    assert.equal(saved.records[0].summary.maxMs, 117);
    assert.equal(saved.records[0].contexts[0].prewarm.misses, 0);
    report.saved = await page.locator('#capture-file').getAttribute('href');
    for (const width of [1500, 390]) {
      await page.setViewportSize({width, height: 900});
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const file = assertProjectOutput(path.join(__dirname, 'results', 'turn-recorder-ui-' + width + '.png'));
      await page.screenshot({path: file});
    }
    assert.deepEqual(errors, []);
    report.pass = true; report.exportRoundTrip = true; report.nativeInputUntouched = true;
    report.singleFrameRetained = true; report.versionBoundaries = true; report.layouts = [1500, 390];
    console.log(JSON.stringify(report));
  } catch (error) {report.failure = error.stack; throw error;}
  finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(assertProjectOutput(path.join(__dirname, 'results/turn-recorder-verification.json')), JSON.stringify(report, null, 2));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
