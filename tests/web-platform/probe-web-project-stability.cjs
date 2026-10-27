const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const desktop = process.argv.includes('--desktop');
const published = process.argv.includes('--published');
assert(!published || desktop, '--published requires --desktop');
const suffix = option('report') || 'stability';
const name = option('browser') || 'Edge';
const seconds = Number(option('seconds') || 120);
const dpr = Number(option('dpr') || 1.5);
const width = Number(option('width') || 1854), height = Number(option('height') || 909);
const mode = option('mode') || (process.argv.includes('--slate-menu') ? 'spawn' : 'tour');
const resize = process.argv.includes('--resize');
const collectGarbage = process.argv.includes('--gc');
const headful = process.argv.includes('--headful');
const minimal = process.argv.includes('--minimal');
const streamChurn = process.argv.includes('--stream-churn');
const stepFrames = Number(option('step-frames') || 60);
const debugPort = option('debug-port');
const requireHandles = process.argv.includes('--require-handles');
const debugHandles = process.argv.includes('--debug-handles');
const slateMenu = process.argv.includes('--slate-menu');
assert(/^[a-z0-9-]+$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
assert(['Chrome', 'Edge'].includes(name) && ['tour', 'spawn', 'orbit'].includes(mode));
assert(!slateMenu || mode === 'spawn', 'The project menu changes levels and invalidates the tour camera');
assert(seconds >= 1 && seconds <= 1800 && dpr >= 1 && dpr <= 3);
assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0);
assert(Number.isInteger(stepFrames) && stepFrames >= 1 && stepFrames <= 600);
assert(!debugPort || (Number.isInteger(Number(debugPort)) && Number(debugPort) >= 1024 &&
  Number(debugPort) <= 65535));
const directory = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, project: id, browser: name,
  desktop, published,
  seconds, mode, resize, collectGarbage, headful, minimal, streamChurn, stepFrames, requireHandles, debugHandles, slateMenu,
  viewport: {width, height, dpr},
  samples: [], errors: [], engineErrors: [], source: audit(__filename)};
let browser, page;
let watchdog;

function instrument({minimal, slateMenu}) {
  const state = globalThis.__stability = {errors: [], deviceLosses: [], shadowTextures: [], shadowLayouts: [],
    shadowShaderDeclarations: [], draws: 0, submissions: 0, slatePipelines: 0, slateDraws: 0};
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
  if (slateMenu) {
    const slatePipelines = new WeakSet(), passes = new WeakMap();
    const create = GPUDevice.prototype.createRenderPipeline;
    GPUDevice.prototype.createRenderPipeline = function(descriptor) {
      const pipeline = create.call(this, descriptor);
      const attributes = descriptor.vertex.buffers?.flatMap(buffer => buffer.attributes) || [];
      if (attributes.some(item => item.shaderLocation === 5 && item.format === 'uint16x2') &&
          attributes.some(item => item.shaderLocation === 0 && item.format === 'float32x4') &&
          attributes.some(item => item.shaderLocation === 2 && item.format === 'float32x2')) {
        slatePipelines.add(pipeline);
        ++state.slatePipelines;
      }
      return pipeline;
    };
    const setPipeline = GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline = function(pipeline) {
      passes.set(this, slatePipelines.has(pipeline));
      return setPipeline.call(this, pipeline);
    };
    const draw = GPURenderPassEncoder.prototype.drawIndexed;
    GPURenderPassEncoder.prototype.drawIndexed = function(...args) {
      if (passes.get(this)) ++state.slateDraws;
      return draw.apply(this, args);
    };
  }
  if (minimal) return;
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
    ready: globalThis.__webEngineReady || null,
    camera: globalThis.__webDefaultCamera || null, runtime: globalThis.__webEngineRuntime || null,
    streaming: globalThis.__webTextureStreaming || null,
    occlusion: globalThis.__webOcclusionRHI || null,
    handles: globalThis.__webGPUHandleDiagnostics || null,
    gpu: globalThis.__stability,
    canvas: {width: Module.canvas.width, height: Module.canvas.height}
  }));
  report.samples.push({label, elapsedSeconds: (Date.now() - report.started) / 1000, ...value});
  assert(!value.failure && !value.gpu.errors.length && !value.gpu.deviceLosses.length &&
    !report.errors.length && !report.engineErrors.length,
  value.failure || value.gpu.errors[0]?.message || report.errors[0] || report.engineErrors[0] || 'Device lost');
  if (requireHandles) assert(value.handles?.version === 1 && !value.handles.failure,
    'The packaged runtime must include bounded handle diagnostics');
  if (debugHandles) assert(value.handles?.enabled && value.handles.capacity === 256);
  if (desktop) assert(value.ready?.shaderPlatform === 47 && value.ready.featureLevel === 3);
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
    watchdog = setTimeout(() => {
      report.watchdog = 'No test progress for 120 seconds';
      browser?.close().catch(() => {});
    }, 120000);
    const packageFile = path.join(directory, `web-project-${id}${desktop ? '-desktop' : ''}-package-results.json`);
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
    assert(packaged.pass && packaged.products.every(item =>
      fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256));
    report.packageReport = audit(packageFile);
    browser = await chromium.launch({headless: !headful, executablePath: name === 'Chrome' ?
      'C:/Program Files/Google/Chrome/Application/chrome.exe' :
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      args: debugPort ? [`--remote-debugging-port=${Number(debugPort)}`] : []});
    report.version = browser.version();
    page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: dpr});
    const debuggerSession = collectGarbage ? await page.context().newCDPSession(page) : null;
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    const log = [];
    page.on('console', message => {
      const text = message.text();
      if (log.length >= 120) log.shift();
      log.push(text);
      if (/GPU validation:|Ensure condition failed|Assertion failed|Fatal error:/.test(text) &&
          report.engineErrors.length < 40) report.engineErrors.push(text);
    });
    await page.addInitScript(instrument, {minimal, slateMenu});
    report.started = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${id}${desktop && !published ? '-desktop' : ''}/index.html${debugHandles ? '?debug=1' : ''}`,
      {waitUntil: 'commit'});
    await frames(60);
    report.initial = await sample('spawn');
    watchdog.refresh();
    console.log(JSON.stringify({browser: name, phase: 'spawn', frame: report.initial.frame}));
    if (slateMenu) {
      if (await page.locator('#close-diagnostics').isVisible())
        await page.locator('#close-diagnostics').click();
      await page.locator('canvas').focus();
      await page.keyboard.press('Escape');
      await frames(15);
      report.menu = await sample('slate-menu-open');
      assert(report.menu.gpu.slatePipelines > 0 && report.menu.gpu.slateDraws > 0,
        'The menu must reach actual Slate pipeline creation and indexed drawing');
      await page.reload({waitUntil: 'commit'});
      await frames(60);
      if (await page.locator('#close-diagnostics').isVisible())
        await page.locator('#close-diagnostics').click();
      assert(await page.evaluate(() => Module._WebProjectWidgetTest(1)),
        'The cooked project material widget must be created and attached');
      await frames(15);
      report.widget = await sample('slate-material-widget');
      assert(report.widget.gpu.slateDraws > 0, 'The persistent project widget must actually draw');
    }
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
      report.operation = {step, phase: 'view', frame: report.samples.at(-1)?.frame};
      if (mode === 'tour') {
        const view = views[step % views.length];
        assert(await page.evaluate(view => Module._WebProjectViewTest(...view), view));
      }
      if (mode === 'orbit') {
        const angle = step * 2.399963229728653;
        const view = [120 + 500 * Math.cos(angle), -150 + 430 * Math.sin(angle),
          150 + (step % 4) * 130, (step % 5 - 2) * 15, (step * 47) % 360];
        assert(await page.evaluate(view => Module._WebProjectViewTest(...view), view));
      }
      if (resize && step % 3 === 0) {
        report.operation.phase = 'resize';
        await page.setViewportSize(step % 2 ? {width, height} :
          {width: Math.floor(width * 0.7), height: Math.floor(height * 0.7)});
      }
      if (slateMenu && step % 3 === 1) {
        report.operation.phase = 'close-widget';
        assert(await page.evaluate(() => Module._WebProjectWidgetTest(0)));
        await frames(15);
        await sample('slate-widget-closed');
        report.operation.phase = 'open-widget';
        assert(await page.evaluate(() => Module._WebProjectWidgetTest(1)));
      }
      if (debuggerSession) await debuggerSession.send('HeapProfiler.collectGarbage');
      if (streamChurn) {
        report.operation.phase = 'budget';
        assert(await page.evaluate(budget => Module._WebTextureStreamingTestBudget(budget), step % 2 ? 256 : 32));
        report.operation.phase = 'clear-memory';
        await page.evaluate(() => __webContentIO.call('clear-memory'));
      }
      report.operation.phase = 'frames';
      await frames(stepFrames);
      report.operation.phase = 'sample';
      await sample(`${mode}-${++step}`);
      watchdog.refresh();
      if (step % 10 === 0) console.log(JSON.stringify({browser: name, step, frame: report.samples.at(-1).frame}));
    }
    await page.evaluate(() => globalThis.__stabilityIdle());
    report.final = await sample('final');
    assert(report.final.frame > report.initial.frame + 60, 'Engine stopped advancing');
    if (mode === 'tour' && !minimal && !desktop) {
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
    clearTimeout(watchdog);
    if (browser) await browser.close();
    delete report.started;
    const file = path.join(directory, `web-project-${id}-${suffix}-${name.toLowerCase()}-results.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, file, failure: report.failure}));
    if (!report.pass) process.exitCode = 1;
  }
})();
