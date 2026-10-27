const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, runs: [], sourceFiles: [audit(__filename)]};
(async () => {
  let browser;
  try {
    const cookFile = path.join(directory, 'web-engine-webgpu-sm5-default-cook-results.json');
    const cook = read(cookFile);
    assert(cook.pass);
    const conversion = path.join(cook.output, 'ShaderConversion');
    const job = fs.readdirSync(conversion).map(name => path.join(conversion, name))
      .find(folder => {
        const file = path.join(folder, 'input.json');
        if (!fs.existsSync(file) || !fs.existsSync(path.join(folder, 'output.wgsl'))) return false;
        const input = read(file);
        return input.shader === 'Global/FFilterVS/32:/Engine/Private/FilterVertexShader.usf|MainVS';
      });
    assert(job, 'The actual desktop Bloom 32-sample vertex shader is required');
    const input = read(path.join(job, 'input.json'));
    const shader = path.join(job, 'output.wgsl');
    report.cookReport = audit(cookFile);
    report.input = audit(path.join(job, 'input.json'));
    report.shader = audit(shader);
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/interpolant-regression', route => route.fulfill({
        contentType: 'text/html', body: '<!doctype html><title>Bloom interpolant regression</title>'
      }));
      await page.goto('http://127.0.0.1:8765/interpolant-regression');
      const run = {browser: name, version: browser.version()};
      report.runs.push(run);
      run.result = await page.evaluate(async ({code, entry}) => {
        let supported;
        const cases = [];
        for (const negotiated of [false, true]) {
          const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
          supported = adapter.limits.maxInterStageShaderVariables;
          const requested = negotiated ? Math.min(28, supported) : 16;
          const device = await adapter.requestDevice({
            requiredLimits: {maxInterStageShaderVariables: requested}
          });
          const unexpected = [];
          device.addEventListener('uncapturederror', event => unexpected.push(event.error.message));
          const module = device.createShaderModule({code});
          const compilation = await module.getCompilationInfo();
          const fragment = device.createShaderModule({
            code: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1); }'
          });
          let failure = null;
          try {
            await device.createRenderPipelineAsync({
              layout: 'auto',
              vertex: {module, entryPoint: entry, buffers: [
                {arrayStride: 8, attributes: [{shaderLocation: 0, offset: 0, format: 'float32x2'}]}
              ]},
              fragment: {module: fragment, entryPoint: 'main', targets: [{format: 'rgba8unorm'}]}
            });
          } catch (error) { failure = error.message; }
          cases.push({requested, actual: device.limits.maxInterStageShaderVariables, failure,
            moduleErrors: compilation.messages.filter(message => message.type === 'error')
              .map(message => message.message), unexpected});
          device.destroy();
        }
        return {supported, cases};
      }, {code: fs.readFileSync(shader, 'utf8'), entry: input.metadata.webEntry});
      assert(run.result.supported >= 17);
      const [low, high] = run.result.cases;
      assert.equal(low.actual, 16);
      assert.match(low.failure, /(?:output variables count|location)/);
      assert.equal(high.actual, Math.min(28, run.result.supported));
      assert.equal(high.failure, null);
      assert(run.result.cases.every(item => item.moduleErrors.length === 0 && item.unexpected.length === 0));
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.pass = true;
    report.boundary = 'Compiles the real cooked Bloom vertex shader into a pipeline with low-limit rejection and negotiated-limit success. Full rendering and high-DPI startup are verified separately.';
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    await browser?.close();
    fs.writeFileSync(path.join(directory, 'web-desktop-interpolants-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
