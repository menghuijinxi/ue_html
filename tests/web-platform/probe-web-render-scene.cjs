const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const directory = path.join(__dirname, 'results');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
function inspectPixels(file) {
  const image = PNG.sync.read(fs.readFileSync(file));
  const background = [...image.data.subarray(0, 3)];
  let foreground = 0, centerForeground = 0;
  const bounds = {left: image.width, top: image.height, right: -1, bottom: -1};
  for (let y = 0; y < image.height; ++y) {
    for (let x = 0; x < image.width; ++x) {
      const offset = (y * image.width + x) * 4;
      if (background.every((value, channel) => Math.abs(image.data[offset + channel] - value) <= 12))
        continue;
      ++foreground;
      if (x > image.width / 4 && x < image.width * 3 / 4 &&
          y > image.height / 4 && y < image.height * 3 / 4) ++centerForeground;
      bounds.left = Math.min(bounds.left, x);
      bounds.right = Math.max(bounds.right, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  }
  const fraction = foreground / (image.width * image.height);
  return {width: image.width, height: image.height, background, foreground, centerForeground, fraction, bounds,
    pass: fraction > 0.005 && fraction < 0.7 && centerForeground > foreground * 0.8 &&
      bounds.left > 0 && bounds.top > 0 && bounds.right < image.width - 1 && bounds.bottom < image.height - 1};
}
const report = {date: new Date().toISOString(), pass: false, sceneRendered: false, browserRuns: [],
  fullNormalUBTBuildVerified: false, sources: [audit(__filename)]};
(async () => {
  let browser;
  try {
    const buildFile = path.join(directory, 'web-engine-webgpu-link-results.json');
    const build = JSON.parse(fs.readFileSync(buildFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(build.pass && build.products.every(item => sha(item.file) === item.sha256));
    report.buildReport = audit(buildFile);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1100, height: 760}});
      const run = {browser: name, pass: false, errors: [], log: []};
      report.browserRuns.push(run);
      page.on('console', message => run.log.push(message.text()));
      page.on('pageerror', error => run.errors.push(error.stack || error.message));
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.goto('http://127.0.0.1:8765/web-engine.html?rhi=webgpu&incremental=1&cook=es31&scene=1',
        {waitUntil: 'commit'});
      try {
        await page.waitForFunction(() => globalThis.__webEngineFailure ||
          (globalThis.__webEngineFrames >= 15), null, {timeout: 60000});
      } catch (error) { run.waitFailure = error.message; }
      Object.assign(run, await page.evaluate(() => ({
        frames: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure || null,
        ready: globalThis.__webEngineReady || null, canvas: globalThis.__webCanvas,
        scene: globalThis.__webRenderScene || null
      })));
      run.queue = await page.evaluate(() => globalThis.__webCanvasWaitIdle());
      const screenshot = path.join(directory, `web-render-scene-${name.toLowerCase()}.png`);
      await page.locator('canvas').screenshot({path: screenshot});
      run.screenshot = audit(screenshot);
      run.pixels = inspectPixels(screenshot);
      run.pass = run.frames >= 15 && !run.failure && !run.waitFailure && run.errors.length === 0 &&
        run.scene?.meshes === 1 && run.scene.unlit && run.scene.camera && run.queue.pass &&
        run.canvas.depthTextures.length > 0 && run.canvas.depthPasses.length > 0 &&
        run.canvas.drawCalls > 2 && run.pixels.pass;
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.length === 2 && report.browserRuns.every(run => run.pass),
      'Both real browser engines must draw the UE scene and complete consecutive ticks.');
    report.sceneRendered = true;
    report.pass = true;
  } catch (error) { report.failure = error.stack; }
  finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, 'web-render-scene-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, sceneRendered: report.sceneRendered,
      runs: report.browserRuns.map(run => ({browser: run.browser, frames: run.frames, failure: run.failure,
        errors: run.errors.map(error => error.slice(0, 5000)), pass: run.pass})), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
