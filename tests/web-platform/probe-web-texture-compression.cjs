const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const id = process.argv.find(item => item.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const packageFile = path.join(directory, `web-project-${id}-package-results.json`);
const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
assert(packaged.pass && packaged.textureCompression === 'BC');
for (const item of [...packaged.products, ...packaged.sourceFiles])
  assert.equal(audit(item.file).sha256, item.sha256, 'Package evidence must match the current files');
const report = {date: new Date().toISOString(), pass: false, runs: [],
  source: audit(__filename), packageReport: audit(packageFile)};
(async () => {
  try {
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      const browser = await chromium.launch({headless: true, executablePath});
      try {
        for (const missing of [false, true]) {
          const page = await browser.newPage({viewport: {width: 360, height: 626}});
          const run = {browser: name, version: browser.version(), missingBCSimulated: missing,
            errors: [], requests: [], pass: false};
          report.runs.push(run);
          page.on('pageerror', error => run.errors.push(error.message));
          page.on('request', request => run.requests.push(new URL(request.url()).pathname));
          if (missing) await page.addInitScript(() => {
            const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
            navigator.gpu.requestAdapter = async options => {
              const adapter = await requestAdapter(options);
              return new Proxy(adapter, {get(target, key) {
                if (key === 'features') return new Set(Array.from(target.features)
                  .filter(value => value !== 'texture-compression-bc'));
                return Reflect.get(target, key, target);
              }});
            };
          });
          await page.goto(`http://127.0.0.1:8765/build/${id}/index.html${missing ? '' : '?diagnostics=1'}`);
          await page.waitForFunction(() => globalThis.__webEngineFailure ||
            globalThis.__webStartupDiagnostics?.stage === 'diagnostics-complete', null, {timeout: 30000});
          run.snapshot = await page.evaluate(() => startupSnapshot());
          assert.equal(run.errors.length, 0);
          if (missing) {
            assert.match(run.snapshot.failure, /texture-compression-bc/);
            assert(!run.requests.some(url => /UEWebEngine\.(?:js|wasm)$|content\.bin$/.test(url)),
              'Unsupported device must stop before engine/content downloads');
            await page.waitForFunction(() => {
              const error = document.getElementById('loading-error');
              return !error.hidden && error.textContent.includes('texture-compression-bc');
            });
            run.layout = await page.evaluate(() => ({
              viewport: innerWidth, content: document.documentElement.scrollWidth,
              error: document.getElementById('loading-error').getBoundingClientRect().toJSON()
            }));
            assert(run.layout.content <= run.layout.viewport &&
              run.layout.error.x >= 0 && run.layout.error.right <= run.layout.viewport);
            const screenshot = path.join(directory, `${id}-${name.toLowerCase()}-bc-required.png`);
            await page.screenshot({path: screenshot});
            run.screenshot = audit(screenshot);
          } else {
            assert.equal(run.snapshot.failure, null);
            assert(run.snapshot.gpu.features.includes('texture-compression-bc'));
            assert(run.snapshot.gpu.checks.every(item => item.pass));
          }
          run.pass = true;
          await page.close();
        }
      } finally { await browser.close(); }
    }
    report.pass = report.runs.length === 4 && report.runs.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    report.boundary = 'Actual desktop feature/device diagnostics and simulated missing BC. Does not test a physical phone.';
    fs.writeFileSync(path.join(directory, `web-project-${id}-bc-preflight-results.json`), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, runs: report.runs.length, failure: report.failure}, null, 2));
  }
})();
