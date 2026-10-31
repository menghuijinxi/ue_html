'use strict';
// Verify captured data and the actual standalone chart controls in Edge.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {writeReport} = require('./render-web-performance-report.cjs');
const file = path.resolve(process.argv[2]);
const report = JSON.parse(fs.readFileSync(file));
assert(report.pass && !report.errors.length);
assert(report.baseline.frames > 0 && report.instrumentedMeasurement.frames > 0);
for (const worker of report.profiles) {
  const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(file), worker.file)));
  assert.equal(profile.samples.length, profile.timeDeltas.length);
  const ids = new Set(profile.nodes.map(node => node.id));
  assert(profile.samples.every(id => ids.has(id)));
  assert(profile.timeDeltas.every(value => Number.isFinite(value)));
  // V8 can deliver a few slightly out-of-order samples. Keep raw data intact;
  // the flame chart clamps those small negative deltas for display.
  const outOfOrderUs = profile.timeDeltas.reduce((sum, value) => sum + Math.max(0, -value), 0);
  assert(outOfOrderUs < (profile.endTime - profile.startTime) * .001,
    'Out-of-order samples must affect less than 0.1% of the profile window');
}
const trace = JSON.parse(fs.readFileSync(path.join(path.dirname(file), report.browserTrace)));
assert(trace.traceEvents.length > 0);
for (const frame of report.gpuFrames.filter(frame => !frame.unsupported)) {
  assert(frame.entries.length > 0 && Number.isFinite(frame.totalPassMs));
  assert(frame.entries.every(entry => entry.gpuMs >= 0 && Number.isFinite(entry.gpuStartMs)));
}
writeReport(file);
(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const errors = [];
  try {
    const page = await browser.newPage({viewport: {width: 1560, height: 1000}});
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:8765/results/' + path.basename(file, '.json') + '.html');
    await page.locator('#hotspots tr').nth(1).waitFor();
    assert.equal(await page.locator('#thread option').count(), 3);
    const images = [];
    for (const role of ['RHI', 'Draw / Render', 'Game']) {
      await page.locator('#thread').selectOption({label: await page.locator('#thread option')
        .filter({hasText: role}).textContent()});
      await page.locator('#window').selectOption('250');
      await page.locator('#start').fill('500');
      images.push(await page.locator('#flame').evaluate(canvas => canvas.toDataURL()));
    }
    assert.equal(new Set(images).size, 3, 'Thread selection must redraw the chart');
    await page.locator('#thread').selectOption({label: await page.locator('#thread option')
      .filter({hasText: 'RHI'}).textContent()});
    await page.locator('#ranking').selectOption('self');
    await page.locator('#filter').fill('VertexBuffer');
    assert((await page.locator('#hotspots').innerText()).includes('VertexBuffer'));
    await page.locator('#filter').fill('');
    await page.locator('#window').selectOption('0');
    await page.locator('#start').fill('0');
    const download = page.waitForEvent('download');
    await page.locator('#png').click();
    const png = await download;
    const pngFile = file.replace(/\.json$/, '-flame.png');
    await png.saveAs(pngFile);
    assert.equal(fs.readFileSync(pngFile).subarray(1, 4).toString(), 'PNG');
    if (report.gpuFrames.some(frame => !frame.unsupported)) {
      await page.locator('#gpuFrame').selectOption('2');
      assert((await page.locator('#gpuStats').innerText()).includes('GPU pass'));
    }
    await page.locator('h1').scrollIntoViewIfNeeded();
    await page.screenshot({path: file.replace(/\.json$/, '-report.png')});
    await page.locator('#gpu').scrollIntoViewIfNeeded();
    await page.screenshot({path: file.replace(/\.json$/, '-gpu-report.png')});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({pass: true, workers: report.profiles.length,
      traceEvents: trace.traceEvents.length, gpuFrames: report.gpuFrames.length, file}));
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
