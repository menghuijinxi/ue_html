const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, browserRuns: [],
  sources: [__filename, path.join(__dirname, 'capture-web-canvas.cjs')].map(audit)};

function capturePostprocess() {
  const state = {textures: [], draws: {}, dispatches: {}};
  const textures = new Set();
  const pipelines = new WeakMap();
  const bound = new WeakMap();
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = createTexture.call(this, descriptor);
    const key = JSON.stringify([texture.label, texture.format, texture.width, texture.height, texture.depthOrArrayLayers]);
    if (!textures.has(key)) {
      textures.add(key);
      state.textures.push({label: texture.label, format: texture.format, width: texture.width,
        height: texture.height, depth: texture.depthOrArrayLayers});
    }
    return texture;
  };
  for (const [method, stage, encoder, commands, field] of [
    ['createRenderPipeline', 'fragment', GPURenderPassEncoder.prototype, ['draw', 'drawIndexed'], 'draws'],
    ['createComputePipeline', 'compute', GPUComputePassEncoder.prototype, ['dispatchWorkgroups'], 'dispatches']
  ]) {
    const create = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      const pipeline = create.call(this, descriptor);
      pipelines.set(pipeline, descriptor[stage]?.entryPoint || '');
      return pipeline;
    };
    const set = encoder.setPipeline;
    encoder.setPipeline = function(pipeline) {
      bound.set(this, pipelines.get(pipeline));
      return set.call(this, pipeline);
    };
    for (const command of commands) {
      const execute = encoder[command];
      encoder[command] = function(...args) {
        const entry = bound.get(this);
        if (entry) state[field][entry] = (state[field][entry] || 0) + 1;
        return execute.apply(this, args);
      };
    }
  }
  globalThis.__webPostprocess = state;
}

(async () => {
  let browser;
  try {
    const packageFile = path.join(directory, 'web-default-template-package-results.json');
    const packaged = read(packageFile);
    assert(packaged.pass && packaged.products.every(valid) && valid(packaged.buildReport) && valid(packaged.stageReport));
    report.package = audit(packageFile);
    const cookFile = path.join(directory, 'web-engine-webgpu-es31-default-cook-results.json');
    const cook = read(cookFile);
    assert(cook.pass && cook.minimalRendererSettingsVerified && valid(cook.minimalRendererConfig));
    for (const name of ['r.MobileHDR', 'r.Mobile.AntiAliasing']) {
      const setting = cook.shaderInventory.detail.settings[name];
      assert(setting.host === '1' && setting.target === '1', `${name} must match Cook and runtime`);
    }
    report.cook = audit(cookFile);
    const shaders = new Map();
    // DDC hits can reuse a shader compiled by an earlier Cook. Entry names include its code hash.
    const cooks = path.join(__dirname, 'build/web-engine-webgpu-es31-default-cook');
    for (const entry of fs.readdirSync(cooks, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const conversions = path.join(cooks, entry.name, 'ShaderConversion');
      if (!fs.existsSync(conversions)) continue;
      for (const job of fs.readdirSync(conversions, {withFileTypes: true})) {
        if (!job.isDirectory()) continue;
        const input = path.join(conversions, job.name, 'input.json');
        const output = path.join(conversions, job.name, 'output.wgsl');
        if (!fs.existsSync(input) || !fs.existsSync(output)) continue;
        const detail = read(input);
        shaders.set(detail.metadata.webEntry, {name: detail.shaderName, shader: detail.shader,
          input, output});
      }
    }
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 1100, height: 760}});
      const run = {browser: name, pass: false, errors: [], log: []};
      report.browserRuns.push(run);
      page.on('pageerror', error => run.errors.push(error.stack || error.message));
      page.on('console', message => {
        run.log.push(message.text());
        if (run.log.length > 24) run.log.shift();
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.addInitScript(capturePostprocess);
      await page.goto('http://127.0.0.1:8765/build/ue-default-template/index.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 120,
        null, {timeout: 90000});
      const result = await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure || null, frames: globalThis.__webEngineFrames || 0,
        gpuErrors: globalThis.__webCanvas.gpuErrors, state: globalThis.__webPostprocess
      }));
      Object.assign(run, result);
      assert.equal(result.failure, null);
      assert.equal(run.errors.length, 0);
      assert.equal(result.gpuErrors.length, 0);
      assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
      run.executedShaders = {};
      for (const field of ['draws', 'dispatches']) {
        run.executedShaders[field] = Object.entries(result.state[field]).map(([entry, count]) => {
          const shader = shaders.get(entry);
          return {entry, count, name: shader?.name || null, shader: shader?.shader || null,
            ...(shader ? {input: audit(shader.input), output: audit(shader.output)} : {})};
        });
      }
      const executed = run.executedShaders.draws;
      run.hdrSceneColor = result.state.textures.filter(texture =>
        /SceneColor/.test(texture.label) && texture.format === 'rgba16float');
      run.tonemap = executed.filter(shader => shader.name === 'FTonemapPS');
      run.fxaa = executed.filter(shader => /FXAA/i.test(shader.name || ''));
      run.bloom = executed.filter(shader => /FMobileBloom(?:Setup|Down|Up)PS/.test(shader.name || ''));
      run.colorLUT = run.executedShaders.dispatches.filter(shader => shader.name === 'FLUTBlenderCS');
      assert(run.hdrSceneColor.length, 'The scene must render into an actual HDR floating-point texture');
      assert(run.tonemap.length, 'The UE tonemapper must actually draw');
      assert(run.fxaa.length, 'The UE FXAA pass must actually draw');
      assert.equal(run.bloom.length, 3, 'The UE bloom setup, downsample and upsample passes must actually draw');
      assert(run.colorLUT.length, 'The UE color grading LUT must actually dispatch');
      const screenshot = path.join(directory, `web-default-postprocess-${name.toLowerCase()}.png`);
      await page.locator('canvas').screenshot({path: screenshot});
      run.screenshot = audit(screenshot);
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.pass = report.browserRuns.length === 2 && report.browserRuns.every(run => run.pass);
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(directory, 'web-default-postprocess-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure,
      runs: report.browserRuns.map(run => ({browser: run.browser, pass: run.pass, frames: run.frames,
        failure: run.failure, errors: run.errors, gpuErrors: run.gpuErrors, log: run.log,
        hdrSceneColor: run.hdrSceneColor, tonemap: run.tonemap, fxaa: run.fxaa}))}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
