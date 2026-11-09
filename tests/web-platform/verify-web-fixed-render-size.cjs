'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true
  });
  try {
    for (const dpr of [1, 1.5, 2]) {
      const context = await browser.newContext({viewport: {width: 1280, height: 800}, deviceScaleFactor: dpr});
      try {
        for (const fixed of [false, true]) {
          const page = await context.newPage();
          await page.goto('http://127.0.0.1:8766/');
          await page.setContent('<canvas id="canvas" width="1920" height="1080" tabindex="0" style="width:960px;height:540px"></canvas>');
          await page.evaluate(() => {
            globalThis.messages = [];
            // Exercise the real host's startup, resize and input paths without a GPU runtime.
            globalThis.Worker = class {
              postMessage(message) {
                messages.push(message);
                if (message.type === 'start') globalThis.lastBrowser = message.browser;
                if (message.type === 'browser') globalThis.lastBrowser = message.state;
                if (message.type === 'inputs') queueMicrotask(() => this.onmessage?.({
                  data: {type: 'input-ack', sequence: message.sequence}
                }));
              }
              terminate() {}
            };
          });
          await page.addScriptTag({path: path.join(__dirname, 'web-engine-host.js')});
          await page.evaluate(fixed => startWebEngineWorker({
            assets: {versions: {'web-engine-worker.js': 'test'}, ...(fixed ?
              {fixedRenderSize: {width: 1920, height: 1080}} : {})},
            module: {canvas: document.getElementById('canvas'), arguments: []},
            record() {}, failed(error) {throw Error(error);}, stage() {},
            diagnostics: {mode: 'normal'}, render() {}
          }), fixed);
          assert.deepEqual(await page.evaluate(() => messages.find(m => m.type === 'start').browser),
            fixed ? {width: 1920, height: 1080, dpr: 1} : {width: 960, height: 540, dpr});
          for (const width of [960, 480]) {
            await page.evaluate(width => {
              const canvas = document.getElementById('canvas');
              canvas.style.width = width + 'px'; canvas.style.height = width * 9 / 16 + 'px';
              window.dispatchEvent(new Event('resize'));
              canvas.focus(); messages.length = 0;
              const rect = canvas.getBoundingClientRect();
              const point = {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true};
              canvas.dispatchEvent(new MouseEvent('mousemove', point));
              canvas.dispatchEvent(new WheelEvent('wheel', {...point, deltaY: 0}));
            }, width);
            await page.waitForFunction(() => [8, 9].every(type => messages.some(m =>
              m.type === 'inputs' && m.events.some(event => event[0] === type))));
            const events = await page.evaluate(() => messages.filter(m => m.type === 'inputs').flatMap(m => m.events));
            const expected = fixed ? [960, 540] : [Math.round(width / 2 * dpr), Math.round(width * 9 / 32 * dpr)];
            assert.deepEqual(await page.evaluate(() => lastBrowser),
              fixed ? {width: 1920, height: 1080, dpr: 1} : {width, height: width * 9 / 16, dpr});
            for (const event of events.filter(event => [8, 9].includes(event[0])))
              assert.deepEqual(event.slice(3, 5), expected);
          }
          await page.close();
          console.log(JSON.stringify({dpr, fixed, pass: true}));
        }
      } finally { await context.close(); }
    }
    const page = await browser.newPage();
    await page.route('**/build/*/index.html', route => route.fulfill({
      contentType: 'text/html',
      headers: {'Cross-Origin-Embedder-Policy': 'require-corp'},
      body: '<canvas id="canvas" width="2880" height="1620"></canvas>' +
        '<script>globalThis.__webRenderView={width:2880,height:1620}</script>'
    }));
    await page.goto('http://127.0.0.1:8766/villa-engine-comparison.html#ours');
    await page.waitForFunction(() => document.getElementById('render-status').dataset.state === 'mismatch');
    assert((await page.locator('#render-status').textContent()).includes('尺寸不一致'));
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame();
    await frame.evaluate(() => {
      __webRenderView = {width: 1920, height: 1080};
      document.getElementById('canvas').width = 1920;
      document.getElementById('canvas').height = 1080;
    });
    await page.waitForFunction(() => document.getElementById('render-status').dataset.state === 'match');
    await page.close();
    console.log(JSON.stringify({resolutionMismatchWarningAndRecovery: true}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
