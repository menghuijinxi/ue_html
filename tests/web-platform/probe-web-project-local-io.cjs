const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const name = process.argv.find(value => value.startsWith('--browser='))?.slice(10) || 'Chrome';
assert(['Chrome', 'Edge'].includes(name));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const packageFile = path.join(directory, 'web-project-triplex-house-villa-package-results.json');
const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
assert(packaged.pass && packaged.products.every(item => audit(item.file).sha256 === item.sha256));
const profileRoot = path.join(__dirname, 'build/local-io-profiles');
fs.mkdirSync(profileRoot, {recursive: true});
const profile = fs.mkdtempSync(path.join(profileRoot, name.toLowerCase() + '-'));
const report = {date: new Date().toISOString(), pass: false, browser: name, profile,
  source: audit(__filename), packageReport: audit(packageFile), runs: []};
let context, page;
async function settle(label, budget, view) {
  if (budget) assert(await page.evaluate(value => Module._WebTextureStreamingTestBudget(value), budget));
  if (view) assert(await page.evaluate(value => Module._WebProjectViewTest(...value), view));
  let previous, stable = 0;
  for (let attempt = 0; attempt < 60; ++attempt) {
    const first = await page.evaluate(() => globalThis.__webEngineFrames || 0);
    await page.waitForFunction(frame => globalThis.__webEngineFailure ||
      globalThis.__webEngineFrames >= frame, first + 30, {timeout: 120000});
    const value = await page.evaluate(async () => {
      await __webContentIO.call('stats');
      return {frame: __webEngineFrames, failure: globalThis.__webEngineFailure,
        streaming: globalThis.__webTextureStreaming, local: __webContentIO.stats,
        bulkFiles: __webContentIO.files.size, bulkMemfsBytes: [...__webContentIO.files.keys()]
          .reduce((sum, file) => sum + FS.lookupPath(file).node.contents.byteLength, 0)};
    });
    assert(!value.failure, value.failure);
    const stream = value.streaming;
    if (stream && !stream.pending && stream.residentMips === stream.requestedMips &&
        stream.residentBytes === previous?.streaming.residentBytes &&
        (!budget || stream.poolBytes === budget * 1024 * 1024)) ++stable;
    else stable = 0;
    previous = value;
    if (stable >= 3) break;
  }
  assert(stable >= 3, `${label} did not settle`);
  assert(previous.local.memoryBytes <= previous.local.memoryLimit && !previous.bulkMemfsBytes);
  console.log(JSON.stringify({label, frame: previous.frame, residentBytes: previous.streaming.residentBytes,
    diskReads: previous.local.diskReads, downloadedBytes: previous.local.downloadedBytes}));
  return {label, ...previous};
}
async function launch(warm) {
  context = await chromium.launchPersistentContext(profile, {headless: true,
    executablePath: name === 'Chrome' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    viewport: {width: 1280, height: 720}});
  page = context.pages()[0];
  const run = {warm, phases: [], requests: [], errors: [], log: []};
  report.runs.push(run);
  context.on('request', request => {
    if (/\/(?:content\.bin|UEWebEngine\.wasm)(?:\?|$)/.test(request.url()))
      run.requests.push({url: request.url(), method: request.method()});
  });
  page.on('pageerror', error => run.errors.push(error.stack));
  page.on('console', message => {
    const text = message.text();
    if (run.log.length >= 60) run.log.shift();
    run.log.push(text);
    if (/GPU validation:|Fatal error:|Assertion failed|Ensure condition failed|Local bulk IO failed/.test(text))
      run.errors.push(text);
  });
  await page.goto('http://127.0.0.1:8765/build/triplex-house-villa/index.html', {waitUntil: 'commit'});
  run.phases.push(await settle('spawn'));
  assert.equal(run.phases[0].bulkFiles, 621);
  if (warm) {
    assert.equal(run.phases[0].local.downloads, 0);
    assert(run.phases[0].local.persistentHits >= 2 && run.requests.length === 0,
      'Reload downloaded a previously cached engine or content pack');
  } else {
    assert.equal(run.phases[0].local.downloads, 2);
    assert.equal(run.requests.length, 2);
  }
  run.phases.push(await settle('room', 256, [-175, -80, 160, -5, 50]));
  // The running engine must recover mips using local disk with all network access disabled.
  await context.setOffline(true);
  const high = run.phases.at(-1);
  const low = await settle('offline-64', 64);
  run.phases.push(low);
  await page.evaluate(() => __webContentIO.call('clear-memory'));
  const recovered = await settle('offline-recovered-256', 256);
  run.phases.push(recovered);
  assert(low.streaming.residentBytes < high.streaming.residentBytes * 0.8);
  assert(recovered.streaming.residentBytes > low.streaming.residentBytes * 1.25);
  assert(recovered.local.diskReads > low.local.diskReads);
  assert.equal(recovered.local.downloadedBytes, high.local.downloadedBytes);
  assert(!run.errors.length, run.errors.join('\n'));
  await context.setOffline(false);
  const screenshot = path.join(directory, `web-project-local-io-${name.toLowerCase()}-${warm ? 'warm' : 'cold'}.png`);
  await page.locator('canvas').screenshot({path: screenshot});
  run.screenshot = audit(screenshot);
  await context.close();
  context = null;
}
(async () => {
  try {
    await launch(false);
    await launch(true);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    if (context) await context.close();
    const file = path.join(directory, `web-project-local-io-${name.toLowerCase()}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
  }
})();
