const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10) || 'triplex-house-villa';
assert(/^[a-z0-9-]+$/.test(id));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), runs: []};
let browser;
(async () => {
  try {
    const packagedFile = path.join(directory, `web-project-${id}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packagedFile, 'utf8'));
    assert(packaged.pass && packaged.disabledSkyLight === false);
    assert(packaged.products.every(item => audit(item.file).sha256 === item.sha256));
    report.packageReport = audit(packagedFile);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 640, height: 360}});
      const run = {browser: name, pass: false, omitted: 0, logs: []};
      report.runs.push(run);
      page.on('console', message => {
        run.logs.push(message.text());
        if (run.logs.length > 150) run.logs.shift();
      });
      await page.route('**/content-files.json', async route => {
        const response = await route.fetch(), manifest = await response.json();
        const count = manifest.files.length;
        manifest.files = manifest.files.filter(file => !file.path.endsWith('/WebSkyCaptures.bin'));
        run.omitted = count - manifest.files.length;
        await route.fulfill({response, json: manifest});
      });
      await page.goto(`http://127.0.0.1:8765/build/${id}/index.html`, {waitUntil: 'commit'});
      await page.waitForFunction(() => !!globalThis.__webEngineFailure, null, {timeout: 120000});
      run.failure = await page.evaluate(() => globalThis.__webEngineFailure);
      run.frames = await page.evaluate(() => globalThis.__webEngineFrames || 0);
      assert.equal(run.omitted, 1);
      assert(run.logs.some(line => line.includes('Specified-cubemap SkyLight requires native WebSkyCaptures.bin preparation.')));
      assert(run.frames < 2, 'Missing SkyLight data must fail before presenting a dark playable scene');
      run.pass = true;
      await browser.close();
      browser = null;
      console.log(JSON.stringify({browser: name, pass: run.pass, frames: run.frames}));
    }
    report.pass = report.runs.length === 2 && report.runs.every(run => run.pass);
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (browser) await browser.close();
    const file = path.join(directory, `web-project-${id}-skylight-cache-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
  }
})();
