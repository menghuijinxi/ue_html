const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const suffix = option('report') || 'stability';
const name = option('browser') || 'Edge';
const seconds = Number(option('seconds') || 120);
const dpr = Number(option('dpr') || 1.5);
const width = Number(option('width') || 1854), height = Number(option('height') || 909);
const mode = option('mode') || 'tour';
assert(/^[a-z0-9-]+$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
assert(['Chrome', 'Edge'].includes(name) && ['tour', 'spawn'].includes(mode));
assert(seconds >= 1 && seconds <= 1800 && dpr >= 1 && dpr <= 3);
assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0);
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, project: id, browser: name,
  seconds, mode, viewport: {width, height, dpr}, samples: [], errors: [], engineErrors: [], source: audit(__filename)};
let browser, page;

function instrument() {
  const state = globalThis.__stability = {errors: [], deviceLosses: [], shadowTextures: [], shadowLayouts: [],
    shadowShaderDeclarations: [], draws: 0, submissions: 0};
  const views = new WeakMap(), layouts = new WeakMap(), pipelineLayouts = new WeakMap(), pipelines = new WeakMap();
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => {
      if (state.errors.length < 40) state.errors.push({frame: globalThis.__webEngineFrames, message: event.error.message});
    });
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.deviceLosses.push({reason: info.reason, message: info.message});
    });
    globalThis.__stabilityIdle = () => device.queue.onSubmittedWorkDone();
    return device;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    if (/MobileCSMAndSpotLightShadowmap/.test(descriptor.label))
      state.shadowTextures.push({frame: globalThis.__webEngineFrames, format: descriptor.format, size: descriptor.size});
    return createTexture.call(this, descriptor);
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(...args) {
    const view = createView.apply(this, args);
    views.set(view, this.label);
    return view;
  };
  const createLayout = GPUDevice.prototype.createBindGroupLayout;
  GPUDevice.prototype.createBindGroupLayout = function(descriptor) {
    const layout = createLayout.call(this, descriptor);
    layouts.set(layout, descriptor.entries);
    return layout;
  };
  const createPipelineLayout = GPUDevice.prototype.createPipelineLayout;
  GPUDevice.prototype.createPipelineLayout = function(descriptor) {
    const layout = createPipelineLayout.call(this, descriptor);
    pipelineLayouts.set(layout, descriptor.bindGroupLayouts.map(item => layouts.get(item)));
    return layout;
  };
  for (const [method, prototype] of [
    ['createRenderPipeline', GPURenderPipeline.prototype], ['createComputePipeline', GPUComputePipeline.prototype]
  ]) {
    const createPipeline = GPUDevice.prototype[method];
    GPUDevice.prototype[method] = function(descriptor) {
      const pipeline = createPipeline.call(this, descriptor);
      pipelines.set(pipeline, pipelineLayouts.get(descriptor.layout));
      return pipeline;
    };
    const getLayout = prototype.getBindGroupLayout;
    prototype.getBindGroupLayout = function(index) {
      const layout = getLayout.call(this, index);
      layouts.set(layout, pipelines.get(this)?.[index]);
      return layout;
    };
  }
  const createShader = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    if (state.shadowShaderDeclarations.length < 4 && descriptor.code.includes('DirectionalLightShadowTexture'))
      state.shadowShaderDeclarations.push(descriptor.code.split('\n').filter(line =>
        /@binding.*DirectionalLightShadow(?:Texture|Sampler)/.test(line)));
    return createShader.call(this, descriptor);
  };
  const createBindGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(descriptor) {
    const entries = descriptor.entries.filter(entry =>
      /MobileCSMAndSpotLightShadowmap/.test(views.get(entry.resource) || ''));
    if (entries.length) {
      const layout = layouts.get(descriptor.layout);
      const info = entries.map(entry => ({binding: entry.binding,
        layout: layout?.find(item => item.binding === entry.binding),
        samplers: layout?.filter(item => item.sampler)}));
      if (!state.shadowLayouts.some(previous => JSON.stringify(previous) === JSON.stringify(info)))
        state.shadowLayouts.push(info);
    }
    return createBindGroup.call(this, descriptor);
  };
  for (const [prototype, method, counter] of [
    [GPUQueue.prototype, 'submit', 'submissions'],
    [GPURenderPassEncoder.prototype, 'draw', 'draws'],
    [GPURenderPassEncoder.prototype, 'drawIndexed', 'draws']
  ]) {
    const original = prototype[method];
    prototype[method] = function(...args) {
      ++state[counter];
      return original.apply(this, args);
    };
  }
}

async function sample(label) {
  const value = await page.evaluate(() => ({
    frame: globalThis.__webEngineFrames || 0, failure: globalThis.__webEngineFailure || null,
    camera: globalThis.__webDefaultCamera || null, runtime: globalThis.__webEngineRuntime || null,
    streaming: globalThis.__webTextureStreaming || null,
    gpu: globalThis.__stability,
    canvas: {width: Module.canvas.width, height: Module.canvas.height}
  }));
  report.samples.push({label, elapsedSeconds: (Date.now() - report.started) / 1000, ...value});
  assert(!value.failure && !value.gpu.errors.length && !value.gpu.deviceLosses.length &&
    !report.errors.length && !report.engineErrors.length,
  value.failure || value.gpu.errors[0]?.message || report.errors[0] || report.engineErrors[0] || 'Device lost');
  return value;
}

async function frames(count) {
  const start = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(target => globalThis.__webEngineFailure ||
    globalThis.__stability.errors.length || globalThis.__stability.deviceLosses.length ||
    globalThis.__webEngineFrames >= target, start + count, {timeout: 120000});
}

(async () => {
  try {
    const packageFile = path.join(directory, `web-project-${id}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass && packaged.products.every(item =>
      fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256));
    report.packageReport = audit(packageFile);
    browser = await chromium.launch({headless: true, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: dpr});
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    const log = [];
    page.on('console', message => {
      const text = message.text();
      if (log.length >= 120) log.shift();
      log.push(text);
      if (/GPU validation:|Ensure condition failed|Assertion failed|Fatal error:/.test(text) &&
          report.engineErrors.length < 40) report.engineErrors.push(text);
    });
    await page.addInitScript(instrument);
    report.started = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${id}/index.html`, {waitUntil: 'commit'});
    await frames(60);
    report.initial = await sample('spawn');
    const started = Date.now();
    // Exercise changing visibility and directional shadow cascades without freezing time or disabling lighting.
    const spawn = report.initial.camera;
    const views = [
      [spawn.x, spawn.y, spawn.z, 0, 180], [spawn.x, spawn.y, spawn.z, 0, 270],
      [spawn.x, spawn.y, spawn.z, 0, 0], [-175, -80, 160, -5, 50],
      [-175, -80, 160, -5, 230], [410, -200, 450, -15, 180]
    ];
    let step = 0;
    while (Date.now() - started < seconds * 1000) {
      if (mode === 'tour') {
        const view = views[step % views.length];
        assert(await page.evaluate(view => Module._WebProjectViewTest(...view), view));
      }
      await frames(60);
      await sample(`${mode}-${++step}`);
      if (step % 10 === 0) console.log(JSON.stringify({browser: name, step, frame: report.samples.at(-1).frame}));
    }
    await page.evaluate(() => globalThis.__stabilityIdle());
    report.final = await sample('final');
    assert(report.final.frame > report.initial.frame + 60, 'Engine stopped advancing');
    if (mode === 'tour') {
      assert(report.final.gpu.shadowShaderDeclarations.length, 'Mobile CSM shader was not exercised');
      const shadows = report.final.gpu.shadowLayouts.flat();
      assert(shadows.some(item => item.binding === 6 &&
        item.layout?.texture?.sampleType === 'unfilterable-float' &&
        item.samplers?.some(sampler => sampler.binding === 10 && sampler.sampler.type === 'non-filtering')),
      'The failing mobile CSM binding must use an unfilterable depth texture and non-filtering sampler');
    }
    const screenshot = path.join(directory, `web-project-${id}-${suffix}-${name.toLowerCase()}.png`);
    await page.locator('canvas').screenshot({path: screenshot});
    report.screenshot = audit(screenshot);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack || String(error);
    if (page) {
      report.diagnostics = await page.evaluate(() => typeof startupSnapshot === 'function' ? startupSnapshot() : null)
        .catch(() => null);
      await sample('failed').catch(() => {});
    }
  } finally {
    if (browser) await browser.close();
    delete report.started;
    const file = path.join(directory, `web-project-${id}-${suffix}-${name.toLowerCase()}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    if (!report.pass) process.exitCode = 1;
  }
})();
