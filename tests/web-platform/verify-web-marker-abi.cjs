const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const results = path.join(__dirname, 'results');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const report = {date: new Date().toISOString(), pass: false, browserRuns: [], sources: [
  __filename, path.join(__dirname, 'web-marker-abi.html'), path.join(__dirname, 'capture-web-canvas.cjs')
].map(audit)};
(async () => {
  let browser;
  try {
    const buildFile = path.join(results, 'web-marker-abi-build-results.json');
    const build = read(buildFile);
    assert(build.pass && build.sources.every(valid) && build.variants.length === 2 &&
      build.variants.every(item => item.products.every(valid) && valid(item.log)));
    report.build = audit(buildFile);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      for (const variant of ['before', 'fixed']) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.stack || error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.addInitScript(require('./capture-web-canvas.cjs'));
        await page.goto(`http://127.0.0.1:8765/web-marker-abi.html?variant=${variant}`);
        await page.waitForFunction(() => globalThis.__markerABIOK || globalThis.__markerABIError, null, {timeout: 15000});
        const state = await page.evaluate(() => ({ok: !!globalThis.__markerABIOK,
          failure: globalThis.__markerABIError || null, markers: globalThis.__webCanvas.debugMarkers}));
        if (variant === 'before') {
          assert(!state.ok && state.failure?.includes('Cannot mix BigInt'));
          assert.equal(state.markers.length, 0);
        } else {
          assert(state.ok && !state.failure && errors.length === 0, JSON.stringify({state, errors}));
          assert.deepEqual(state.markers, ['command', 'renderPass'].flatMap(kind =>
            ['bounded', 'marker/\u6807\u8bb0', ''].map(label => ({kind, label}))));
        }
        report.browserRuns.push({browser: name, version: browser.version(), variant, ...state, errors, pass: true});
        await page.close();
      }
      await browser.close();
      browser = null;
    }
    report.pass = true;
    report.boundary = 'Actual wasm64 C++ calls through the unchanged pinned Emdawn implementations into browser command/render-pass debug markers. Unpatched builds must reproduce BigInt failure; patched builds preserve bounded byte lengths, UTF-8 and empty strings, submit a real clear pass and receive queue completion without validation errors. This does not verify Engine scene rendering.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-marker-abi-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browserRuns: report.browserRuns.map(run =>
      ({browser: run.browser, variant: run.variant, markers: run.markers.length, pass: run.pass})),
    failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
