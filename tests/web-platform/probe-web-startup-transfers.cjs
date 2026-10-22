const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const source = path.join(__dirname, 'web-default-template.html');
const suffix = process.argv.find(value => value.startsWith('--report='))?.slice(9) || 'current';
assert(/^[a-z0-9-]+$/.test(suffix));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
// A valid module with a custom section lets the server pause after the Wasm header.
const wasm = Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 129, 128, 4, 0]),
  Buffer.alloc(65536)]);
assert(WebAssembly.validate(wasm));
const script = `
globalThis.__fixtureOperation = (async () => {
  if (globalThis.__fixtureCancel) {
    const response = await fetch('UEWebEngine.wasm');
    await response.body.cancel('TEST_CANCEL');
  } else {
    try {
      await WebAssembly.instantiateStreaming(fetch('UEWebEngine.wasm'), {});
    } catch (error) {
      record('wasm streaming compile failed: ' + error);
      const response = await fetch('UEWebEngine.wasm');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    await fetchFile('content.bin');
  }
  Module.onRuntimeInitialized();
  record('P3_ENGINE_READY {"fixture":true}');
  globalThis.__fixtureDone = true;
})().catch(error => { Module.onAbort(error); globalThis.__fixtureDone = true; });
`;
const cases = [
  {name: 'debug-stream-progress', hold: true},
  {name: 'streaming-mime-fallback', mime: 'application/octet-stream'},
  {name: 'wasm-compile-error', invalid: true},
  {name: 'wasm-transfer-interrupted', drop: true},
  {name: 'wasm-http-404', status: 404},
  {name: 'wasm-body-cancelled', cancel: true},
  {name: 'normal-stream-progress', normal: true, hold: true},
  {name: 'desktop-stream-progress', normal: true, hold: true, viewport: {width: 1280, height: 720}},
  {name: 'landscape-stream-progress', normal: true, hold: true, viewport: {width: 844, height: 390}},
  {name: 'unknown-length-progress', normal: true, hold: true, unknownLength: true},
  {name: 'script-wait', normal: true, holdScript: true},
  {name: 'normal-http-error', normal: true, status: 404}
];
const report = {date: new Date().toISOString(), pass: false, fixtureOnly: true,
  sources: [__filename, source].map(audit), runs: []};
let active;
let browser;
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (url.pathname === '/index.html') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(fs.readFileSync(source));
  } else if (url.pathname === '/UEWebEngine.js') {
    response.setHeader('Content-Type', 'text/javascript');
    if (active.test.holdScript) active.release = () => { active.release = null; response.end(script); };
    else response.end(script);
  } else if (url.pathname === '/UEWebEngine.wasm' || url.pathname === '/content.bin') {
    const binary = url.pathname.endsWith('.wasm');
    active.requests.push(url.pathname);
    const bytes = binary ? active.test.invalid ? Buffer.alloc(32, 255) : wasm : Buffer.alloc(16384, 7);
    response.setHeader('Content-Type', binary ? active.test.mime || 'application/wasm' : 'application/octet-stream');
    if (!active.test.unknownLength) response.setHeader('Content-Length', bytes.length);
    response.writeHead(binary ? active.test.status || 200 : 200);
    if (active.test.hold || binary && active.test.drop) {
      const length = active.test.normal ? Math.floor(bytes.length * 0.37) : binary ? 8 : 1;
      response.write(bytes.subarray(0, length));
      if (active.test.drop) setTimeout(() => response.destroy(), 100);
      else active.release = () => { active.release = null; response.end(bytes.subarray(length)); };
    } else response.end(bytes);
  } else response.writeHead(404).end();
});
const resource = (state, name) => state.resources.find(item =>
  new URL(item.url).pathname === '/' + name && item.method === 'GET');
(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({headless: true, executablePath});
      for (const test of cases) {
        active = {test, requests: []};
        const viewport = test.viewport || {width: 360, height: 626};
        const context = await browser.newContext({viewport, isMobile: viewport.width < 1000, hasTouch: true});
        const page = await context.newPage();
        const run = {browser: name, version: browser.version(), name: test.name, pass: false};
        report.runs.push(run);
        try {
          await page.addInitScript(cancel => {
            globalThis.__fixtureCancel = cancel;
            globalThis.__fixtureOriginalFetch = fetch;
            globalThis.__fixtureOriginalStreaming = WebAssembly.instantiateStreaming;
            globalThis.__fixtureOriginalInstantiate = WebAssembly.instantiate;
          }, !!test.cancel);
          await page.goto(root + '/index.html' + (test.normal ? '' : '?debug=1'),
            {waitUntil: 'domcontentloaded'});
          if (test.holdScript) {
            await page.waitForFunction(() => document.getElementById('loading-stage').textContent === '加载引擎脚本');
            assert(await page.locator('#loading').isVisible());
            assert.equal(await page.locator('#loading-progress').getAttribute('value'), null);
            await page.waitForFunction(() => !document.getElementById('loading-elapsed').textContent.includes(' 0 秒'));
            run.scriptWait = await page.locator('#loading-content').innerText();
            active.release();
          }
          if (test.hold) {
            if (await page.locator('#close-diagnostics').isVisible()) await page.locator('#close-diagnostics').click();
            for (const [file, total, stage, title] of [
              ['UEWebEngine.wasm', wasm.length, 'wasm-downloading', '下载引擎'],
              ['content.bin', 16384, 'content-loading', '下载场景资源']
            ]) {
              const length = test.normal ? Math.floor(total * 0.37) : file.endsWith('.wasm') ? 8 : 1;
              await page.waitForFunction(({file, length}) =>
                globalThis.__webStartupDiagnostics.resources.some(item =>
                  item.url.endsWith('/' + file) && item.receivedBytes >= length),
              {file, length}, {timeout: 3000});
              const snapshot = await page.evaluate(() => startupSnapshot());
              const transfer = resource(snapshot, file);
              assert.equal(transfer.receivedBytes, length);
              assert.equal(transfer.bodyComplete, false);
              assert(snapshot.pending > 0 && !snapshot.settled);
              assert.equal(snapshot.stage, stage);
              assert(snapshot.elapsedMs >= 0 && transfer.lastProgressAt);
              await page.waitForFunction(title =>
                document.getElementById('loading-stage').textContent === title, title);
              assert(await page.locator('#loading').isVisible());
              assert.match(await page.locator('#loading-detail').innerText(), /MiB/);
              assert.equal(await page.locator('#loading-percent').innerText(),
                test.unknownLength ? '' : Math.floor(length / total * 100) + '%');
              assert.equal(await page.locator('#loading-progress').getAttribute('value'),
                test.unknownLength ? null : String(length));
              const layout = await page.locator('#loading-content').evaluate(element => ({
                left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
                width: document.documentElement.clientWidth,
                overflow: element.scrollWidth > element.clientWidth
              }));
              assert(layout.left >= 0 && layout.right <= layout.width && !layout.overflow);
              if (test.normal && !test.unknownLength && file.endsWith('.wasm')) {
                run.screenshot = path.join(__dirname, 'results', `web-loading-${name.toLowerCase()}-${viewport.width}.png`);
                await page.screenshot({path: run.screenshot});
                run.screenshotAudit = audit(run.screenshot);
              }
              (run.progress ||= []).push(snapshot);
              assert(active.release);
              active.release();
            }
          }
          await page.waitForFunction(() => globalThis.__fixtureDone, null, {timeout: 10000});
          run.state = await page.evaluate(() => ({...startupSnapshot(),
            observingTransfers: fetch !== globalThis.__fixtureOriginalFetch &&
              WebAssembly.instantiateStreaming !== globalThis.__fixtureOriginalStreaming &&
              WebAssembly.instantiate !== globalThis.__fixtureOriginalInstantiate}));
          run.requests = [...active.requests];
          const state = run.state;
          assert.equal(state.pending, 0);
          assert(state.settled);
          assert(state.observingTransfers);
          {
            const transfer = resource(state, 'UEWebEngine.wasm');
            assert(transfer && transfer.durationMs >= 0);
            assert.equal(state.version, 3);
            assert(transfer.startedAt && transfer.responseUrl);
            if (test.cancel) {
              assert.equal(transfer.outcome, 'cancelled');
              assert.equal(transfer.bodyComplete, false);
            } else if (test.status) {
              assert.equal(transfer.status, test.status);
              assert.match(transfer.error, /HTTP 404/);
              assert(state.wasm.some(item => item.outcome === 'error'));
            } else if (test.drop) {
              assert.equal(transfer.bodyComplete, false);
              assert(transfer.error && transfer.receivedBytes >= 8);
              assert(state.wasm.some(item => item.error));
            } else if (test.invalid) {
              assert(state.wasm.some(item => item.errorName === 'CompileError' && item.stack));
            } else {
              assert(state.wasm.some(item => item.outcome === 'complete'));
              if (test.mime) {
                assert(state.wasm.some(item => item.method === 'instantiateStreaming' &&
                  item.errorName === 'TypeError'));
                assert(state.wasm.some(item => item.method === 'instantiate' &&
                  item.outcome === 'complete'));
              } else {
                assert.equal(transfer.receivedBytes, wasm.length);
                assert(transfer.bodyComplete);
                if (!test.unknownLength) assert(transfer.lengthMatches);
              }
              const content = resource(state, 'content.bin');
              assert.equal(content.receivedBytes, 16384);
              assert(content.bodyComplete);
              if (!test.unknownLength) assert(content.lengthMatches);
            }
          }
          if (test.invalid || test.drop || test.status) {
            assert(state.failure && state.stage === 'failed');
            if (await page.locator('#close-diagnostics').isVisible()) await page.locator('#close-diagnostics').click();
            await page.waitForFunction(() => document.getElementById('loading-stage').textContent === '加载失败');
            assert(await page.locator('#loading-retry').isVisible());
            assert.equal(await page.locator('#loading-error').innerText(), state.failure);
            await page.locator('#loading-diagnostics').click();
            assert(await page.locator('#diagnostics').isVisible());
          } else {
            assert.equal(state.failure, null);
            assert.equal(state.stage, 'running');
            if (await page.locator('#close-diagnostics').isVisible()) await page.locator('#close-diagnostics').click();
            await page.waitForFunction(() => document.getElementById('loading-stage').textContent === '准备首帧画面');
            assert(await page.locator('#loading').isVisible(), 'ready without frames must keep loading visible');
            await page.evaluate(() => { globalThis.__webEngineFrames = 2; });
            await page.waitForFunction(() => document.getElementById('loading').hidden);
            assert.equal(await page.locator('#canvas').getAttribute('aria-busy'), 'false');
          }
          assert.equal(active.requests.filter(url => url.endsWith('.wasm')).length,
            test.mime || test.invalid || test.drop || test.status ? 2 : 1);
          run.pass = true;
        } catch (error) {
          run.failure = error.stack || String(error);
          run.state ||= await page.evaluate(() => startupSnapshot()).catch(() => null);
        } finally {
          active.release?.();
          await context.close();
        }
        console.log(JSON.stringify({browser: name, name: test.name, pass: run.pass, failure: run.failure}));
      }
      await browser.close();
      browser = null;
    }
    report.pass = report.runs.length === cases.length * 2 && report.runs.every(run => run.pass);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const file = path.join(__dirname, 'results', `web-startup-transfers-${suffix}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, checks: report.runs.length,
      passed: report.runs.filter(run => run.pass).length}));
    if (!report.pass) process.exitCode = 1;
  }
})();
