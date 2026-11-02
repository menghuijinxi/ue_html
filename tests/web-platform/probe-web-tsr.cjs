const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const tag = option('tag');
const folder = option('folder') || 'triplex-project-tsr-distance-fields-threads';
const conversion = option('conversion');
assert(tag && /^[a-z0-9-]+$/.test(tag) && /^[a-z0-9-]+$/.test(folder));
assert(conversion && fs.statSync(conversion).isDirectory(), 'Use the actual Cook ShaderConversion directory');
const entries = {};
// Individual shader jobs can come from DDC; retain their earlier conversion identities.
const cookRoot = path.dirname(path.dirname(path.resolve(conversion)));
const conversions = fs.readdirSync(cookRoot, {withFileTypes: true})
  .filter(item => item.isDirectory()).map(item => path.join(cookRoot, item.name, 'ShaderConversion'))
  .filter(directory => fs.existsSync(directory));
if (!conversions.includes(path.resolve(conversion))) conversions.push(path.resolve(conversion));
for (const directory of conversions) {
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
    if (!item.isDirectory()) continue;
    const input = path.join(directory, item.name, 'input.json');
    if (!fs.existsSync(input)) continue;
    const shader = JSON.parse(fs.readFileSync(input, 'utf8'));
    if (/^FTSR/.test(shader.shaderName) && fs.existsSync(path.join(directory, item.name, 'output.wgsl')))
      entries[shader.metadata.webEntry] = shader.shaderName;
  }
}
assert(Object.keys(entries).length > 0, 'Cook must contain converted TSR shaders');
const output = path.join(__dirname, 'results', `web-tsr-${tag}`);
const report = {date: new Date().toISOString(), folder, conversion, conversions, entries,
  settingsOverrides: [], samples: [], errors: [], pass: false};
const save = () => fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
let context;

function observe(entries) {
  const state = globalThis.__tsrProbe = {dispatches: {}, pipelines: {}, textures: [], errors: []};
  const pipelines = new WeakMap(), passes = new WeakMap();
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await requestDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => { if (info.reason !== 'destroyed') state.errors.push(info.message); });
    return device;
  };
  const createPipeline = GPUDevice.prototype.createComputePipeline;
  GPUDevice.prototype.createComputePipeline = function(descriptor) {
    const pipeline = createPipeline.call(this, descriptor), name = entries[descriptor.compute.entryPoint];
    if (name) {
      pipelines.set(pipeline, name);
      state.pipelines[name] = (state.pipelines[name] || 0) + 1;
    }
    return pipeline;
  };
  const createTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    if (/TSR/.test(descriptor.label || ''))
      state.textures.push({label: descriptor.label, format: descriptor.format, size: descriptor.size});
    return createTexture.call(this, descriptor);
  };
  const setPipeline = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    passes.set(this, pipelines.get(pipeline));
    return setPipeline.call(this, pipeline);
  };
  for (const method of ['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']) {
    const original = GPUComputePassEncoder.prototype[method];
    GPUComputePassEncoder.prototype[method] = function(...args) {
      const name = passes.get(this);
      if (name) state.dispatches[name] = (state.dispatches[name] || 0) + 1;
      return original.apply(this, args);
    };
  }
}

(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', `tsr-${tag}`),
      {channel: 'msedge', headless: !process.argv.includes('--visible'),
        viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})(${JSON.stringify(entries)});\n` + await response.text()});
    });
    const page = context.pages()[0], log = fs.createWriteStream(output + '.log');
    page.on('close', () => log.end());
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('crash', () => report.errors.push('Renderer crashed'));
    page.on('console', message => {
      const text = message.text();
      log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost|Local bulk IO failed/.test(text)) report.errors.push(text);
    });
    const start = Date.now();
    await page.goto(`http://127.0.0.1:8765/build/${folder}/index.html`, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 30,
      null, {timeout: 900000});
    report.startupMs = Date.now() - start;
    report.startup = await page.evaluate(() => ({frame: globalThis.__webEngineFrames,
      failure: globalThis.__webEngineFailure,
      diagnostics: typeof startupSnapshot === 'function' ? startupSnapshot() : globalThis.__webStartupDiagnostics}));
    assert(!report.startup.failure, JSON.stringify(report.startup.failure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    assert(owner, 'Threaded engine worker must exist');
    const snapshot = async label => {
      // Parameter -1 only reads the real view; it does not set a quality CVar.
      assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', -1, 0)), 1);
      await page.waitForFunction(() => globalThis.__webDistanceFieldsLighting?.antiAliasing === 4, null, {timeout: 30000});
      const sample = await owner.evaluate(() => ({frame: globalThis.__webEngineFrames,
        view: globalThis.__webRenderView, lighting: globalThis.__webDistanceFieldsLighting,
        camera: globalThis.__webDefaultCamera, probe: globalThis.__tsrProbe,
        failure: globalThis.__webEngineFailure, settings: globalThis.__webProjectSettings}));
      report.samples.push({label, ...sample}); save();
      assert(!sample.failure, JSON.stringify(sample.failure));
      assert.equal(sample.view.antiAliasing, 4, 'Rendered views must select TSR');
      assert.deepEqual(sample.probe.errors, [], 'WebGPU must accept the actual shaders and resources');
      assert.deepEqual(report.errors, []);
      for (const name of ['FTSRMeasureFlickeringLumaCS', 'FTSRClearPrevTexturesCS', 'FTSRDilateVelocityCS',
        'FTSRDecimateHistoryCS', 'FTSRRejectShadingCS', 'FTSRUpdateHistoryCS']) {
        assert(sample.probe.dispatches[name] > 5, `Actual TSR dispatches missing: ${name}`);
      }
      console.log(JSON.stringify({label, frame: sample.frame, dispatches: sample.probe.dispatches}));
      return sample;
    };
    const settle = async frames => {
      const before = await page.evaluate(() => globalThis.__webEngineFrames);
      await page.waitForFunction(before => globalThis.__webEngineFailure || globalThis.__webEngineFrames > before + 15,
        before, {timeout: 60000});
      if (frames > 15) await page.waitForFunction(target => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= target,
        before + frames, {timeout: 120000});
    };
    const initial = await snapshot('initial');
    await page.locator('canvas').focus();
    await page.keyboard.down('w');
    await settle(40);
    await page.keyboard.up('w');
    await page.mouse.move(700, 400);
    await page.mouse.down({button: 'right'});
    await page.mouse.move(550, 410, {steps: 6});
    await page.mouse.up({button: 'right'});
    await settle(30);
    const moved = await snapshot('movement');
    assert(moved.probe.dispatches.FTSRUpdateHistoryCS > initial.probe.dispatches.FTSRUpdateHistoryCS + 10);
    report.travelCm = Math.hypot(...['x', 'y', 'z'].map(key => moved.camera[key] - initial.camera[key]));
    assert(report.travelCm > 10, 'Movement must exercise history reprojection');
    await page.setViewportSize({width: 960, height: 540});
    await settle(40);
    const resized = await snapshot('resize');
    assert.equal(resized.view.outputWidth, 960);
    assert.equal(resized.view.outputHeight, 540);
    await page.setViewportSize({width: 1280, height: 720});
    await settle(40);
    await snapshot('restored');
    report.diagnosticOverrides = [
      {parameter: 'r.AntiAliasingMethod', value: 2},
      {parameter: 'r.AntiAliasingMethod', value: 4},
      {parameter: 'r.ScreenPercentage', value: 66},
      {parameter: 'r.TSR.History.R11G11B10', value: 0},
    ];
    assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 0, 2)), 1);
    await settle(30);
    assert.equal(await owner.evaluate(() => __webRenderView.antiAliasing), 2);
    assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 0, 4)), 1);
    await settle(40);
    await snapshot('taa-to-tsr');
    assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 13, 66)), 1);
    await settle(40);
    const upsampled = await snapshot('upsampling-66-percent');
    assert(upsampled.view.width < upsampled.view.outputWidth * 0.75, 'TSR must reconstruct from a smaller input');
    assert.equal(upsampled.view.outputWidth, 1280);
    await page.locator('canvas').screenshot({path: output + '-upsampled.png', timeout: 60000});
    assert.equal(await page.evaluate(() => __webEngineRPC('WebLightingQualityTest', 14, 0)), 1);
    await settle(40);
    const fullPrecision = await snapshot('rgba16f-history');
    assert(fullPrecision.probe.textures.some(texture => /History.Color/.test(texture.label) && texture.format === 'rgba16float'),
      'Alternate full-precision history format must be exercised');
    const image = await page.locator('canvas').screenshot({timeout: 60000});
    fs.writeFileSync(output + '.png', image);
    const png = PNG.sync.read(image), colors = new Set();
    let nonBlack = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const [r, g, b] = png.data.subarray(i, i + 3);
      colors.add((r << 16) | (g << 8) | b);
      if (r + g + b > 30) ++nonBlack;
    }
    report.pixels = {colors: colors.size, nonBlackFraction: nonBlack / (png.width * png.height)};
    assert(colors.size > 256 && report.pixels.nonBlackFraction > 0.25, 'TSR must produce a nonblank scene');
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally { await context?.close(); save(); console.log(JSON.stringify({pass: report.pass, output, failure: report.failure})); }
})();
