const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, runs: [],
  sources: [__filename, path.join(__dirname, 'web-bindgroup-lifetime.cpp')].map(audit)};
let browser;
(async () => {
  try {
    const buildFile = path.join(__dirname, 'results/web-bindgroup-lifetime-build-results.json');
    const build = read(buildFile);
    assert(build.pass && build.sources.every(valid) && build.variants.every(variant =>
      variant.products.every(valid) && valid(variant.log)));
    report.build = audit(buildFile);
    for (const name of ['Edge', 'Chrome']) {
      browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
        'C:/Program Files/Google/Chrome/Application/chrome.exe' :
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
      for (const [variant, fault, mode = 'debug'] of [['before', 0], ['fixed', 0],
        ['before', 1], ['fixed', 1], ['before', 2], ['fixed', 2],
        ['fixed', 0, 'normal'], ['fixed', 1, 'normal']]) {
        const page = await browser.newPage();
        const run = {browser: name, version: browser.version(), variant, fault, mode, errors: [], log: []};
        report.runs.push(run);
        page.on('pageerror', error => run.errors.push(error.stack || error.message));
        page.on('console', message => {
          run.log.push(message.text());
          if (/HANDLE_LIFETIME_OK/.test(message.text())) run.ok = true;
          if (/HANDLE_LIFETIME_FAILED/.test(message.text())) run.errors.push(message.text());
        });
        await page.route('**/handle-lifetime-test', route => route.fulfill({contentType: 'text/html',
          headers: {'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp'},
          body: `<script>globalThis.__webStartupDiagnostics={mode:"${mode}"};globalThis.__handleFault=${fault};` +
            'var Module = {print: console.log, printErr: console.error};</script>' +
            `<script src="/build/web-bindgroup-lifetime/${variant}.js"></script>`}));
        const started = Date.now();
        await page.goto('http://127.0.0.1:8765/handle-lifetime-test');
        for (let attempt = 0; attempt < 180 && !run.ok && !run.errors.length; ++attempt) {
          await page.waitForTimeout(1000);
          run.batches = await page.evaluate(() => globalThis.__handleBatches || 0);
          if (attempt % 20 === 0) console.log(JSON.stringify({browser: name, batches: run.batches}));
        }
        run.state = await page.evaluate(() => ({batches: globalThis.__handleBatches,
          reserve: globalThis.__handleReserve, heapBytes: HEAPU8.length,
          failure: globalThis.__webGPUHandleDiagnostics?.failure || null,
          enabled: globalThis.__webGPUHandleDiagnostics?.enabled ?? null}));
        run.elapsedMs = Date.now() - started;
        if (!fault) assert(run.ok && !run.errors.length && run.state.batches === 1000, JSON.stringify(run));
        else if (variant === 'before') {
          assert(!run.ok && run.errors.some(error => error.includes('Assertion failed')) && !run.state.failure);
        } else {
          const failure = run.state.failure;
          assert(!run.ok && run.errors.some(error => error.includes('WebGPU object handle')));
          assert(failure && failure.recent.length === (mode === 'normal' ? 0 : 256) &&
            failure.heapBytes > 300 * 1024 * 1024);
          if (mode === 'normal') assert.equal(run.state.enabled, false);
          else if (fault === 1) {
            const matching = failure.recent.filter(event => event.pointer === failure.pointer);
            assert.equal(matching.at(-1)?.action, 'release');
            assert.equal(matching.at(-1)?.kind, 'GPUBindGroup');
          } else {
            assert.equal(failure.pointer, String(0x1000000400));
            assert(!failure.recent.some(event => event.pointer === failure.pointer));
          }
        }
        run.pass = true;
        await page.close();
      }
      await browser.close();
      browser = null;
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    const file = path.join(__dirname, 'results/web-bindgroup-lifetime-results.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
