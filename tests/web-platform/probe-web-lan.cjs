const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');

const option = process.argv.find(value => value.startsWith('--origin='));
const origin = new URL(option ? option.slice('--origin='.length) : 'http://10.1.1.200:8765');
assert.equal(origin.protocol, 'http:');
assert(!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname),
  'Use a LAN origin to reproduce the insecure-context restriction.');
const directory = path.join(__dirname, 'results');
const packageDirectory = path.join(__dirname, 'build/ue-default-template');
const report = {date: new Date().toISOString(), pass: false,
  url: new URL('/build/ue-default-template/index.html', origin).href, assets: [], browsers: []};
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});

function headers(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {method: 'HEAD', timeout: 10000}, response => {
      response.resume();
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers}));
    });
    request.on('timeout', () => request.destroy(new Error('HTTP request timed out')));
    request.on('error', reject);
    request.end();
  });
}

let browser;
(async () => {
  try {
    const packageReport = path.join(directory, 'web-default-template-package-results.json');
    const packaged = JSON.parse(fs.readFileSync(packageReport, 'utf8'));
    assert(packaged.pass && packaged.products.every(item => audit(item.file).sha256 === item.sha256));
    report.packageReport = audit(packageReport);
    for (const base of [`http://127.0.0.1:${origin.port || 80}`, origin.origin]) {
      for (const file of fs.readdirSync(packageDirectory)) {
        const result = await headers(new URL(file, new URL(report.url).href.replace(origin.origin, base)));
        assert.equal(result.status, 200);
        assert.equal(Number(result.headers['content-length']), fs.statSync(path.join(packageDirectory, file)).size);
        assert.equal(result.headers['cross-origin-opener-policy'], 'same-origin');
        assert.equal(result.headers['cross-origin-embedder-policy'], 'require-corp');
        if (file.endsWith('.wasm')) assert.equal(result.headers['content-type'], 'application/wasm');
        report.assets.push({origin: base, file, ...result});
      }
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      const run = {name, pass: false, errors: []};
      report.browsers.push(run);
      browser = await chromium.launch({headless: true, executablePath});
      let page = await browser.newPage();
      const insecureRequests = [];
      page.on('request', request => insecureRequests.push(request.url()));
      page.on('pageerror', error => run.errors.push(error.message));
      await page.goto(report.url);
      run.insecure = await page.evaluate(() => ({secure: isSecureContext, isolated: crossOriginIsolated,
        gpu: !!navigator.gpu, subtle: !!globalThis.crypto?.subtle,
        failure: globalThis.__webEngineFailure, ready: !!globalThis.__webEngineReady,
        frames: globalThis.__webEngineFrames || 0, messageVisible: !document.getElementById('failure').hidden}));
      assert(!run.insecure.secure && !run.insecure.gpu && !run.insecure.subtle && !run.insecure.isolated);
      assert(run.insecure.messageVisible && run.insecure.failure.includes(origin.origin) &&
        run.insecure.failure.includes('unsafely-treat-insecure-origin-as-secure'));
      assert(!run.insecure.ready && run.insecure.frames === 0);
      assert(!insecureRequests.some(url => /UEWebEngine\.(?:js|wasm)|content\.bin/.test(url)));
      await browser.close();

      browser = await chromium.launch({headless: true, executablePath,
        args: [`--unsafely-treat-insecure-origin-as-secure=${origin.origin}`]});
      page = await browser.newPage({viewport: {width: 1100, height: 760}});
      page.on('pageerror', error => run.errors.push(error.message));
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.goto(report.url, {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 120,
        null, {timeout: 180000});
      const sample = () => page.evaluate(() => ({secure: isSecureContext, isolated: crossOriginIsolated,
        gpu: !!navigator.gpu, subtle: !!globalThis.crypto?.subtle, frames: globalThis.__webEngineFrames || 0,
        ready: globalThis.__webEngineReady, world: globalThis.__webEngineWorld,
        failure: globalThis.__webEngineFailure || null, camera: globalThis.__webDefaultCamera,
        gpuErrors: globalThis.__webCanvas?.gpuErrors}));
      run.initial = await sample();
      assert.equal(run.initial.failure, null);
      assert(run.initial.secure && run.initial.isolated && run.initial.gpu &&
        run.initial.subtle && run.initial.ready && run.initial.camera && run.initial.frames >= 120);
      const bounds = await page.locator('canvas').boundingBox();
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      const before = await sample();
      await page.keyboard.down('w');
      try {
        await page.waitForFunction(frame => globalThis.__webEngineFailure ||
          globalThis.__webEngineFrames >= frame + 60, before.frames, {timeout: 60000});
      } finally { await page.keyboard.up('w'); }
      run.after = await sample();
      run.distance = Math.hypot(...['x', 'y', 'z'].map(key => run.after.camera[key] - before.camera[key]));
      assert(run.distance > 50);
      assert.equal(run.after.failure, null);
      assert.equal(run.after.gpuErrors.length, 0);
      assert.equal(run.errors.length, 0);
      assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      const screenshot = path.join(directory, `web-lan-${name.toLowerCase()}.png`);
      const image = await page.locator('canvas').screenshot({path: screenshot});
      const png = PNG.sync.read(image);
      run.nonBlack = 0;
      for (let i = 0; i < png.data.length; i += 4)
        if (png.data[i] + png.data[i + 1] + png.data[i + 2] > 30) ++run.nonBlack;
      assert(run.nonBlack > png.width * png.height * 0.9);
      run.screenshot = audit(screenshot);
      run.pass = true;
      console.log(JSON.stringify({browser: name, pass: true, frames: run.after.frames, movement: run.distance}));
      await browser.close();
      browser = null;
    }
    report.sourceFiles = [__filename, 'serve.cjs', 'web-default-template.html']
      .map(file => audit(path.isAbsolute(file) ? file : path.join(__dirname, file)));
    report.boundary = 'LAN IP tested from this host with an explicit trusted development origin. Separate LAN devices and router connectivity are not verified.';
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(path.join(directory, 'web-lan-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, assets: report.assets.length,
      browsers: report.browsers.length, failure: report.failure}));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
