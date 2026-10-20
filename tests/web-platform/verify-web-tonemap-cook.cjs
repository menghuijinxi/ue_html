const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-tonemap-20261019-1149.json');
const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const priorCookFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-feature-gates-20261019-1339.json');
const priorReportFile = path.join(results, 'web-tonemap-cook-regression-results-before-feature-gates-20261019-1339.json');
const report = {date: new Date().toISOString(), pass: false, tonemapConversionVerified: false,
  webgpuShaderCookVerified: false, hardwareEngineTickVerified: false, completeUEScene: false,
  sourceFiles: [audit(__filename)], browserRuns: []};

function nonfiniteConstants(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length % 4, 0);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  assert.equal(words[0], 0x07230203);
  const types = new Map();
  const constants = [];
  for (let offset = 5; offset < words.length;) {
    const count = words[offset] >>> 16;
    const opcode = words[offset] & 65535;
    assert(count > 0 && offset + count <= words.length);
    if (opcode === 22) types.set(words[offset + 1], words[offset + 2]);
    if ((opcode === 43 || opcode === 50) && types.get(words[offset + 1]) === 32) {
      const bits = words[offset + 3];
      if ((bits & 0x7f800000) === 0x7f800000) constants.push({id: words[offset + 2], bits});
    }
    offset += count;
  }
  return constants;
}

(async () => {
  let browser;
  try {
    const baseline = read(baselineFile);
    const cook = read(cookFile);
    assert(valid(baseline.log) && valid(cook.log));
    assert(cook.sourceFiles.every(valid) && cook.hostProducts.every(valid));
    const sources = read(cook.shaderSourcesReport.file);
    assert(valid(cook.shaderSourcesReport) && sources.pass && sources.sourceFiles.every(valid));
    assert(sources.files.every(item => sha(path.join(sources.output, item.relative)) === item.sha256));
    assert(valid(sources.installedEngineUnmodified));
    report.baseline = audit(baselineFile);
    report.cook = audit(cookFile);
    report.shaderSources = cook.shaderSourcesReport;
    report.installedShaderUnmodified = true;
    const prior = baseline.shaderFailures.filter(item => item.detail.shaderName === 'FTonemapPS');
    assert(prior.length > 0 && prior.every(item => valid(item.diagnostic) &&
      item.detail.error.includes('std::isfinite')));
    const jobs = [...new Set(prior.map(item => item.detail.shader))];
    assert.equal(jobs.length, 96);
    const directory = path.join(cook.output, 'ShaderConversion');
    const current = new Map();
    for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!item.isDirectory()) continue;
      const dir = path.join(directory, item.name);
      const input = path.join(dir, 'input.json');
      if (!fs.existsSync(input)) continue;
      const detail = read(input);
      if (detail.shaderName !== 'FTonemapPS') continue;
      if (fs.existsSync(path.join(dir, 'failure.json'))) continue;
      const spirv = path.join(dir, 'input.spv');
      const wgsl = path.join(dir, 'output.wgsl');
      assert.deepEqual(nonfiniteConstants(spirv), [], detail.shader);
      assert(fs.existsSync(wgsl), detail.shader);
      current.set(detail.shader, {shader: detail.shader, spirv: audit(spirv), wgsl: audit(wgsl)});
    }
    const recompiled = jobs.filter(shader => current.has(shader));
    const missing = jobs.filter(shader => !current.has(shader));
    if (missing.length) {
      const prior = read(priorReportFile), priorCook = read(priorCookFile);
      assert(prior.pass && prior.tonemapConversionVerified && prior.cook.sha256 === sha(priorCookFile));
      assert(valid(priorCook.log) && prior.shaderSources.sha256 === cook.shaderSourcesReport.sha256);
      const relevant = priorCook.sourceFiles.filter(item => item.file.includes('WebGPUShaderFormat') ||
        item.file.endsWith('PostProcessTonemap.usf'));
      assert(relevant.length > 0 && relevant.every(valid));
      for (const shader of missing) {
        const item = prior.recoveredJobs.find(candidate => candidate.shader === shader);
        assert(item && valid(item.spirv) && valid(item.wgsl), `Missing historical evidence: ${shader}`);
        assert.deepEqual(nonfiniteConstants(item.spirv.file), [], shader);
        assert(!cook.shaderFailures.some(failure => failure.detail.shader === shader), shader);
        current.set(shader, item);
      }
      report.historicalCook = audit(priorCookFile);
      report.historicalReport = audit(priorReportFile);
      report.unchangedShaderInputs = relevant;
    }
    report.previouslyFailedJobs = jobs.length;
    report.currentRecompiledRecoveredJobs = recompiled.length;
    report.historicalRecoveredJobs = missing.length;
    report.currentTonemapFailures = [...new Set(cook.shaderFailures
      .filter(item => item.detail.source === '/Engine/Private/PostProcessTonemap.usf')
      .map(item => item.detail.shader))];
    report.recoveredJobs = jobs.map(shader => current.get(shader));
    report.tonemapConversionVerified = true;
    report.webgpuShaderCookVerified = cook.pass;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/tonemap-cook-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Tonemap Cook validation</title>'}));
      await page.goto('http://127.0.0.1:8765/tonemap-cook-validation');
      const modules = report.recoveredJobs.map(item => ({
        shader: item.shader, code: fs.readFileSync(item.wgsl.file, 'utf8'),
      }));
      const state = await page.evaluate(async modules => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU adapter unavailable');
        const device = await adapter.requestDevice();
        const errors = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        for (const item of modules) {
          device.pushErrorScope('validation');
          const module = device.createShaderModule({label: item.shader, code: item.code});
          const info = await module.getCompilationInfo();
          for (const message of info.messages) {
            if (message.type === 'error') errors.push(`${item.shader}: ${message.message}`);
          }
          const error = await device.popErrorScope();
          if (error) errors.push(`${item.shader}: ${error.message}`);
        }
        device.destroy();
        return {modules: modules.length, errors};
      }, modules);
      report.browserRuns.push({browser: name, version: browser.version(), ...state,
        pass: state.modules === jobs.length && state.errors.length === 0});
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.every(item => item.pass));
    report.pass = true;
    report.boundary = 'Revalidates the 96 finite-constant tonemap fixes in both browsers. Artifacts absent from the current Cook are explicitly taken from the preserved successful conversion batch, with unchanged shader inputs and hashed provenance; cache absence is not fresh compilation. Other current tonemap failures remain separate. This is shader-module validation, not a render-pipeline, scene, complete Global library or Engine Tick test. The browser runtime remains SM5.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-tonemap-cook-regression-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, tonemapConversionVerified: report.tonemapConversionVerified,
      previouslyFailedJobs: report.previouslyFailedJobs,
      currentRecompiledRecoveredJobs: report.currentRecompiledRecoveredJobs,
      historicalRecoveredJobs: report.historicalRecoveredJobs,
      currentTonemapFailures: report.currentTonemapFailures?.length,
      browserRuns: report.browserRuns, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
