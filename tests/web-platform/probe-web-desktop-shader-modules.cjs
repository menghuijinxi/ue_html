const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const root = process.argv.find(value => value.startsWith('--input='))?.slice(8);
assert(root, '--input must name a ShaderConversion directory');
const directory = path.resolve(root);
const edge = process.argv.includes('--edge');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, directory, browser: edge ? 'Edge' : 'Chrome',
  completeUEScene: false, shaders: [], sourceFiles: [audit(__filename)]};

(async () => {
  let browser;
  try {
    const jobs = fs.readdirSync(directory).filter(name =>
      fs.existsSync(path.join(directory, name, 'output.wgsl')) &&
      !fs.existsSync(path.join(directory, name, 'failure.json')));
    assert(jobs.length > 0, 'No successfully converted shaders');
    browser = await chromium.launch({headless: true, executablePath: edge ?
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' :
      'C:/Program Files/Google/Chrome/Application/chrome.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/desktop-shader-validation', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Desktop shader validation</title>'
    }));
    await page.goto('http://127.0.0.1:8765/desktop-shader-validation');
    report.device = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const features = ['texture-compression-bc', 'texture-formats-tier1', 'rg11b10ufloat-renderable', 'subgroups']
        .filter(name => adapter.features.has(name));
      globalThis.desktopValidationDevice = await adapter.requestDevice({requiredFeatures: features});
      return {features, adapter: adapter.info};
    });
    for (const job of jobs) {
      const file = path.join(directory, job, 'output.wgsl');
      const input = JSON.parse(fs.readFileSync(path.join(directory, job, 'input.json'), 'utf8'));
      const messages = await page.evaluate(async code => {
        const info = await desktopValidationDevice.createShaderModule({code}).getCompilationInfo();
        return info.messages.filter(message => message.type === 'error').map(message => ({
          line: message.lineNum, column: message.linePos, message: message.message
        }));
      }, fs.readFileSync(file, 'utf8'));
      report.shaders.push({name: input.shaderName, artifact: audit(file), errors: messages});
    }
    report.failed = report.shaders.filter(shader => shader.errors.length);
    report.pass = report.failed.length === 0;
    report.boundary = 'Actual browser shader-module validation only; pipelines, resource bindings and scene pixels require the packaged runtime probe.';
    await page.evaluate(() => desktopValidationDevice.destroy());
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    const output = path.join(__dirname, `results/web-desktop-shader-modules${edge ? '-edge' : ''}-results.json`);
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, checked: report.shaders.length,
      failed: report.failed, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
