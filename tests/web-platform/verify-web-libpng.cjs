const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && item.sha256 === sha(item.file);
const report = {pass: false, date: new Date().toISOString(), architecture: 'wasm64',
  completeBrowserUERuntime: false, browserRuns: []};
const expected = {pass: true, cases: 4, depths: [8, 16], metadata: true, corruptRejected: true, checks: 8};

(async () => {
  let browser;
  try {
    const buildFile = path.join(__dirname, 'results/web-libpng-build-results.json');
    const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
    assert(build.pass && build.portable && build.version === '1.6.44');
    assert(valid(build.library) && build.objects.length === 15 && build.objects.every(valid));
    assert(build.sourceFiles.length >= 24 && build.sourceFiles.every(valid) && build.products.every(valid));
    const pngSource = path.resolve(__dirname, '../../reference-engine/Engine/Source/ThirdParty/libPNG/libPNG-1.6.44');
    report.compatibleHeaders = ['png.h', 'pngconf.h', 'pnglibconf.h', 'pnginfo.h', 'pngstruct.h'].map(name => {
      const source = path.join(pngSource, name);
      const installed = path.join(process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine',
        'Source/ThirdParty/libPNG/libPNG-1.6.44', name);
      assert.equal(fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n'),
        fs.readFileSync(installed, 'utf8').replace(/\r\n/g, '\n'), `Header/configuration mismatch: ${name}`);
      return {source: audit(source), installed: audit(installed)};
    });
    const run = cp.spawnSync(process.execPath, [build.products.find(item => item.file.endsWith('.js')).file],
      {encoding: 'utf8', timeout: 30000, windowsHide: true});
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    const prefix = 'P3_LIBPNG_RESULT ';
    const output = run.stdout.split(/\r?\n/).find(line => line.startsWith(prefix));
    assert(output);
    report.node = JSON.parse(output.slice(prefix.length));
    assert.deepEqual(report.node, expected);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto('http://127.0.0.1:8765/web-libpng.html');
      await page.waitForFunction(() => globalThis.__webLibPng, null, {timeout: 30000});
      const state = await page.evaluate(() => globalThis.__webLibPng);
      assert.deepEqual(state, expected);
      assert.deepEqual(errors, []);
      report.browserRuns.push({browser: name, version: browser.version(), ...state, errors});
      await browser.close();
      browser = null;
    }
    Object.assign(report, {pass: true, buildReport: audit(buildFile), library: build.library,
      sourceFiles: [__filename, path.join(__dirname, 'web-libpng.html')].map(audit),
      boundary: 'Target engine libPNG 1.6.44 portable wasm64 archive, with matching installed-engine public/private headers and configuration. Four RGBA images, 8/16-bit pixels, metadata, exact pixel round trips and damaged IDAT rejection pass in Node, Chrome and Edge. This does not execute UE ImageWrapper, Engine, Cook textures or a scene.'});
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-libpng-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
