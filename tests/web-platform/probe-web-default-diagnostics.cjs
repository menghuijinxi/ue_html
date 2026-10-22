const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const directory = path.join(__dirname, 'results');
const suffix = process.argv.find(value => value.startsWith('--report='))?.slice(9) || 'current';
const runtime = process.argv.includes('--runtime');
assert(/^[a-z0-9-]+$/.test(suffix));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const source = path.join(__dirname, 'web-default-template.html');
const root = 'http://127.0.0.1:8765/build/ue-default-template/';
const script = root + 'UEWebEngine.js';
const redirectedScript = script + '?diagnostic-redirect=1';
const stub = 'globalThis.__diagnosticScriptLoaded = true;';
const scriptBody = state => state.diagnostics.resources.find(item => item.url === script && item.method === 'GET');
const cases = [
  {name: 'script-http-404', response: {status: 404, body: 'Not found'},
    check: state => {
      assert.match(state.failure, /UEWebEngine\.js/);
      assert(state.diagnostics.resources.some(item => item.url === script && item.status === 404));
    }},
  {name: 'script-network-failure', abort: true,
    check: state => {
      assert.match(state.failure, /UEWebEngine\.js/);
      assert(state.diagnostics.resources.some(item => item.url === script && item.error));
    }},
  {name: 'head-ok-script-get-failed', abortScript: true, abortGet: true,
    check: state => {
      assert.match(state.failure, /UEWebEngine\.js/);
      assert(state.diagnostics.resources.some(item => item.method === 'HEAD' && item.status === 200));
      assert(scriptBody(state)?.error);
      assert.equal(state.diagnostics.engineScript.outcome, 'error');
      assert(state.diagnostics.engineScript.durationMs >= 0);
    }},
  {name: 'head-ok-script-get-404', abortScript: true, getResponse: {status: 404, body: 'Not found'},
    check: state => {
      assert(state.diagnostics.resources.some(item => item.method === 'HEAD' && item.status === 200));
      assert.equal(scriptBody(state)?.status, 404);
    }},
  {name: 'script-blocked-body-reachable', abortScript: true,
    check: state => {
      assert.match(state.failure, /UEWebEngine\.js/);
      const item = scriptBody(state);
      assert.equal(item?.receivedBytes, Buffer.byteLength(stub));
      assert.equal(item?.sha256, crypto.createHash('sha256').update(stub).digest('hex'));
      assert(item?.bodyComplete && !item.error);
      assert(item.durationMs >= 0 && item.responseUrl === script);
    }},
  {name: 'script-security-policy-block',
    csp: "script-src 'unsafe-inline'; connect-src 'self'",
    check: state => {
      assert(state.failure);
      assert(state.diagnostics.errors.some(item => item.kind === 'security-policy' &&
        item.blockedURI === script && /script-src/.test(item.directive)));
      assert(scriptBody(state)?.bodyComplete && !scriptBody(state).error);
    }},
  {name: 'script-syntax-error', response: {body: 'function broken( {'},
    check: state => {
      assert(state.diagnostics.errors.some(item => item.kind === 'javascript' &&
        item.filename === script && item.line > 0));
    }},
  {name: 'first-cause-preserved', response: {body:
    "setTimeout(() => dispatchEvent(new Event('error')), 20); throw new Error('TEST_FIRST_CAUSE');"},
    check: state => assert.match(state.failure, /TEST_FIRST_CAUSE/)},
  {name: 'wasm64-unavailable', init: () => {
    const validate = WebAssembly.validate;
    WebAssembly.validate = bytes => bytes[8] === 5 && bytes[11] === 4 ? false : validate(bytes);
  }, check: state => {
    assert.match(state.failure, /memory64/i);
    assert(!state.scriptRequested);
    assert.equal(state.diagnostics.capabilities.memory64, false);
  }},
  {name: 'bigint-arrays-unavailable', init: () => {
    Object.defineProperty(globalThis, 'BigInt64Array', {value: undefined, configurable: true});
  }, check: state => {
    assert.match(state.failure, /BigInt/);
    assert(!state.scriptRequested);
  }},
  {name: 'webgpu-unavailable', init: () => {
    Object.defineProperty(navigator, 'gpu', {value: undefined, configurable: true});
  }, check: state => {
    assert.match(state.failure, /WebGPU/);
    assert(!state.scriptRequested);
  }},
  {name: 'diagnostics-only', only: true,
    check: state => {
      assert.equal(state.failure, null);
      assert.equal(state.diagnostics.stage, 'diagnostics-complete');
      assert(state.diagnostics.gpu.deviceCreated);
      assert(state.diagnostics.gpu.limits.maxTextureDimension3D > 0);
      assert(state.diagnostics.resources.some(item => /UEWebEngine\.wasm$/.test(item.url) && item.status === 200));
      assert(scriptBody(state)?.bodyComplete && !scriptBody(state).error);
      assert(!state.scriptRequested && !state.largeDownload);
    }},
  {name: 'script-body-is-html', only: true,
    getResponse: {contentType: 'text/html', body: '<!doctype html><title>Login required</title>'},
    check: state => {
      assert(state.failure);
      assert(scriptBody(state)?.looksLikeHTML);
      assert(scriptBody(state)?.error);
      assert(!state.scriptRequested && !state.largeDownload);
    }},
  {name: 'script-body-too-large', only: true, getResponse: {body: ' '.repeat(1024 * 1024 + 1)},
    check: state => {
      assert(state.failure);
      assert.match(scriptBody(state)?.error || '', /1048576/);
      assert(!state.scriptRequested && !state.largeDownload);
    }},
  {name: 'script-body-redirect', only: true,
    getResponse: {status: 302, headers: {location: redirectedScript}},
    check: state => {
      assert.equal(state.failure, null);
      assert.equal(scriptBody(state)?.responseUrl, redirectedScript);
      assert(scriptBody(state)?.redirected && scriptBody(state)?.bodyComplete);
      assert(!state.scriptRequested && !state.largeDownload);
    }},
  {name: 'adapter-unavailable', only: true, init: () => {
    navigator.gpu.requestAdapter = async () => null;
  }, check: state => {
    assert.match(state.failure, /适配器|adapter/i);
    assert(!state.scriptRequested);
  }},
  {name: 'device-rejected', only: true, init: () => {
    GPUAdapter.prototype.requestDevice = async () => { throw new TypeError('TEST_DEVICE_REJECTED'); };
  }, check: state => {
    assert.match(state.failure, /TEST_DEVICE_REJECTED/);
    assert(!state.scriptRequested);
  }},
  {name: 'diagnostic-resource-500', only: true, response: {status: 500, body: 'Server error'},
    check: state => {
      assert.match(state.failure, /HTTP/);
      assert(state.diagnostics.resources.some(item => item.url === script && item.status === 500));
      assert(!state.scriptRequested);
    }},
  {name: 'wasm-rejection', response: {body:
    "Promise.reject(new WebAssembly.CompileError('TEST_WASM_MEMORY64'));"},
    check: state => {
      assert.match(state.failure, /TEST_WASM_MEMORY64/);
      assert(state.diagnostics.errors.some(item => item.name === 'CompileError' && item.stack));
    }},
  {name: 'export-and-mobile-layout', export: true, check: state => {
    assert.equal(state.failure, null);
    assert(state.diagnostics.capabilities.memory64);
    assert(state.panelVisible);
    assert(state.panelBounds.width <= 360 && state.panelBounds.x >= 0);
    assert(state.panelScrollWidth <= state.panelBounds.width + 1);
  }}
];
const report = {date: new Date().toISOString(), pass: false, runtime,
  sources: [audit(__filename), audit(source), audit(path.join(__dirname, 'serve.cjs'))], runs: [], runtimeRuns: []};
let browser;
(async () => {
  try {
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({headless: true, executablePath});
      for (const test of cases) {
        const context = await browser.newContext({viewport: {width: 360, height: 626}});
        const page = await context.newPage();
        const run = {browser: name, version: browser.version(), name: test.name, pass: false};
        report.runs.push(run);
        const requests = [];
        page.on('request', request => requests.push({
          url: request.url(), method: request.method(), resourceType: request.resourceType()}));
        if (test.init) await page.addInitScript(test.init);
        await page.route(root + 'index.html*', route => route.fulfill({
          contentType: 'text/html; charset=utf-8', body: fs.readFileSync(source, 'utf8'),
          headers: {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp',
            ...(test.csp ? {'Content-Security-Policy': test.csp} : {})}
        }));
        await page.route(script, route => {
          const request = route.request();
          const isScript = request.resourceType() === 'script';
          const isGet = request.method() === 'GET';
          if (test.abort || isScript && test.abortScript || isGet && !isScript && test.abortGet)
            return route.abort('failed');
          return route.fulfill({contentType: 'text/javascript', body: stub, ...test.response,
            ...(isGet && !isScript ? test.getResponse : {})});
        });
        try {
          await page.goto(root + 'index.html?' + (test.only ? 'diagnostics=1' : 'debug=1'));
          await page.waitForFunction(() =>
            globalThis.__webStartupDiagnostics?.settled && !globalThis.__webStartupDiagnostics.pending ||
            !globalThis.__webStartupDiagnostics && (globalThis.__webEngineFailure || globalThis.__diagnosticScriptLoaded),
          null, {timeout: 10000});
          // Include errors dispatched after the initial synchronous script exception.
          await page.waitForTimeout(100);
          run.state = await page.evaluate(() => {
            const panel = document.getElementById('diagnostics');
            return {failure: globalThis.__webEngineFailure || null, diagnostics: globalThis.__webStartupDiagnostics,
              panelVisible: panel ? !panel.hidden : false, panelBounds: panel?.getBoundingClientRect().toJSON(),
              panelScrollWidth: panel?.scrollWidth};
          });
          run.state.scriptRequested = requests.some(item => item.resourceType === 'script' && item.url === script);
          run.state.largeDownload = requests.some(item => item.method !== 'HEAD' &&
            /UEWebEngine\.wasm|content\.bin/.test(item.url));
          test.check(run.state);
          if (test.export) {
            const pending = page.waitForEvent('download');
            await page.locator('#download-diagnostics').click();
            const download = await pending;
            const file = path.join(directory, `web-startup-diagnostics-${name.toLowerCase()}-${suffix}.json`);
            await download.saveAs(file);
            const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.equal(exported.capabilities.memory64, true);
            assert.equal(exported.failure, null);
            assert(Array.isArray(exported.engineLog));
            run.export = audit(file);
            await page.screenshot({path: path.join(directory,
              `web-startup-diagnostics-${name.toLowerCase()}-${suffix}.png`)});
          }
          run.pass = true;
        } catch (error) { run.failure = error.stack || String(error); }
        finally { await context.close(); }
        console.log(JSON.stringify({browser: name, name: test.name, pass: run.pass, failure: run.failure}));
      }
      if (runtime) {
        const file = path.join(directory, 'web-default-template-package-results.json');
        const packaged = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert(packaged.pass && packaged.products.every(item => audit(item.file).sha256 === item.sha256));
        report.packageReport = audit(file);
        for (const query of ['diagnostics=1', 'debug=1']) {
          const context = await browser.newContext({viewport: {width: 360, height: 626}});
          const page = await context.newPage();
          const run = {browser: name, query, pass: false, errors: [], requests: []};
          report.runtimeRuns.push(run);
          page.on('pageerror', error => run.errors.push(error.stack || error.message));
          page.on('request', request => run.requests.push({
            url: request.url(), method: request.method(), resourceType: request.resourceType()}));
          try {
            await page.goto(root + 'index.html?' + query, {waitUntil: 'commit'});
            await page.waitForFunction(query => globalThis.__webEngineFailure ||
              (query === 'diagnostics=1' ? globalThis.__webStartupDiagnostics.stage === 'diagnostics-complete' :
                globalThis.__webEngineFrames >= 120), query, {timeout: 120000});
            run.state = await page.evaluate(() => startupSnapshot());
            assert.equal(run.state.failure, null);
            assert.equal(run.errors.length, 0);
            assert(run.state.capabilities.memory64 && run.state.gpu.deviceCreated);
            assert.equal(run.state.errors.length, 0);
            if (query === 'diagnostics=1') {
              assert.equal(run.state.gpu.checks.length, 7);
              assert(run.state.gpu.checks.every(check => check.pass));
              assert(!run.requests.some(item => item.resourceType === 'script'));
              assert(!run.requests.some(item => item.method !== 'HEAD' &&
                /UEWebEngine\.wasm|content\.bin/.test(item.url)));
              const item = scriptBody({diagnostics: run.state});
              assert.equal(item.sha256, audit(path.join(__dirname, 'build/ue-default-template/UEWebEngine.js')).sha256);
              assert(item.bodyComplete && item.receivedBytes > 300000);
            } else {
              assert.equal(run.state.stage, 'running');
              assert(run.state.frames >= 120 && run.state.ready);
              assert(run.state.gpu.deviceLimits.maxTextureDimension3D > 0);
              assert(run.state.engineLog.length > 0);
            }
            run.pass = true;
          } catch (error) { run.failure = error.stack || String(error); }
          finally { await context.close(); }
          console.log(JSON.stringify({browser: name, query, pass: run.pass, failure: run.failure}));
        }
      }
      await browser.close();
      browser = null;
    }
    report.pass = report.runs.length === cases.length * 2 && report.runs.every(run => run.pass) &&
      (!runtime || report.runtimeRuns.length === 4 && report.runtimeRuns.every(run => run.pass));
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, `web-default-diagnostics-${suffix}-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, checks: report.runs.length,
      passed: report.runs.filter(run => run.pass).length}));
    if (!report.pass) process.exitCode = 1;
  }
})();
