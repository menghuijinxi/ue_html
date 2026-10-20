const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');

const variants = process.argv.slice(2);
if (!variants.length) variants.push('gpu32', 'gpu64', 'gpu32-thread', 'gpu64-thread',
  'abi32', 'abi64', 'abi32-thread', 'abi64-thread');
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, {recursive: true});

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.P0_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  const results = [];
  const artifactPrefix = path.basename(process.env.P0_RESULTS || 'browser-results.json', '.json');
  for (const variant of variants) {
    const shaderPage = ['shaders', 'ue-shaders', 'ue-material'].includes(variant);
    const graphics = variant.startsWith('gpu') || shaderPage;
    for (const viewport of graphics ? [{width: 1280, height: 900}, {width: 390, height: 844}] : [{width: 1280, height: 900}]) {
      const page = await browser.newPage({viewport});
      const diagnostics = [];
      page.on('pageerror', error => diagnostics.push(error.message));
      page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
      const result = {variant, viewport, browser: browser.version(), diagnostics};
      try {
        await page.goto(shaderPage ?
          `http://127.0.0.1:8765/${variant}.html?features=${encodeURIComponent(process.env.P0_SHADER_FEATURES || 'tier2')}&source=${encodeURIComponent(process.env.P1_SHADER_SOURCE || 'standalone')}` :
          `http://127.0.0.1:8765/?variant=${variant}`, {waitUntil: 'load'});
        result.environment = await page.evaluate(() => ({
          secureContext: isSecureContext, crossOriginIsolated,
          webgpu: !!navigator.gpu, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
        }));
        await page.waitForFunction(() => !!globalThis.__p0Report, null, {timeout: 50000});
        result.report = await page.evaluate(() => globalThis.__p0Report);
        result.screenshot = `${artifactPrefix}-${variant}-${viewport.width}.png`;
        await page.screenshot({path: path.join(resultsDir, result.screenshot)});
        if (graphics && result.report.pass) {
          const canvas = page.locator('#scene');
          const png = PNG.sync.read(await canvas.screenshot());
          const expected = result.report.canvasExpectedPixels || (shaderPage ? Array(4).fill([64, 128, 191, 255]) :
            [[255, 0, 0, 255], [0, 128, 0, 255], [0, 0, 255, 255], [255, 128, 255, 255]]);
          const pixels = [];
          for (let q = 0; q < 4; ++q) {
            const x = Math.floor(png.width * (q % 2 ? 0.75 : 0.25));
            const y = Math.floor(png.height * (q >= 2 ? 0.75 : 0.25));
            pixels.push([...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)]);
          }
          result.canvasPixels = pixels;
          result.canvasPass = pixels.every((pixel, q) =>
            pixel.every((channel, c) => Math.abs(channel - expected[q][c]) <= 3));
          result.layoutPass = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
        }
      } catch (error) {
        result.failure = error.message;
      } finally {
        await page.close();
      }
      result.pass = !!result.report?.pass && !result.failure &&
        diagnostics.length === 0 &&
        (!graphics || (result.canvasPass && result.layoutPass));
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(resultsDir, process.env.P0_RESULTS || 'browser-results.json'), JSON.stringify(results, null, 2));
  process.exitCode = results.every(result => result.pass) ? 0 : 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
