'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const compareGlass = require('./verify-web-glass-color.cjs');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = argument('folder') || 'triplex-virtual-distance-fields-threads';
const tag = argument('tag') || 'glass-vsm';
assert([folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const inputs = (argument('input') || '').split(',').filter(Boolean).map(value => path.resolve(value));
assert(inputs.length, '--input requires actual Cook ShaderConversion directories');
const referenceFile = path.resolve(argument('reference') ||
  path.join(__dirname, 'results/villa-distance-fields-glass-vsm-native-interior-auto-project.png'));
const reference = PNG.sync.read(fs.readFileSync(referenceFile));
const shaders = {}, sources = [];
for (const directory of inputs) for (const name of fs.readdirSync(directory)) {
  const file = path.join(directory, name, 'input.json');
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file));
  if (data.shaderName === 'FWebTranslucentLightingInjectCS') {
    shaders[data.metadata.webEntry] = {
      name: data.shaderName,
      virtualShadows: data.metadata.spirvBindings.some(binding => /VirtualShadowMap/.test(binding.name)),
    };
    sources.push(audit(file));
  }
}
assert(Object.values(shaders).some(shader => shader.virtualShadows),
  'Cook must contain actual TLV injection permutations with VSM resources');

function observe(entries) {
  const state = globalThis.__glassProbe = {dispatches: {}, errors: [], losses: []};
  const pipelines = new WeakMap(), passes = new WeakMap();
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await request.apply(this, args);
    device.addEventListener('uncapturederror', event => state.errors.push(event.error.message));
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.losses.push(info.message);
    });
    return device;
  };
  const create = GPUDevice.prototype.createComputePipeline;
  GPUDevice.prototype.createComputePipeline = function(desc) {
    const pipeline = create.call(this, desc);
    if (entries[desc.compute.entryPoint]) pipelines.set(pipeline, desc.compute.entryPoint);
    return pipeline;
  };
  const set = GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline = function(pipeline) {
    passes.set(this, pipelines.get(pipeline)); return set.call(this, pipeline);
  };
  const dispatch = GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups = function(...args) {
    const entry = passes.get(this);
    if (entry) state.dispatches[entry] = (state.dispatches[entry] || 0) + 1;
    return dispatch.apply(this, args);
  };
}
const output = path.join(__dirname, 'results', tag);
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  imageCheck: audit(require.resolve('./verify-web-glass-color.cjs')), reference: audit(referenceFile),
  shaderSources: sources, shaders, views: [], errors: [], qualityOverrides: []};
const packageReport = path.join(__dirname, 'results', `web-project-${folder}-package-results.json`);
assert(JSON.parse(fs.readFileSync(packageReport, 'utf8')).pass, 'A validated package is required');
report.packageReport = audit(packageReport);
let context, log;
(async () => {
  try {
    context = await chromium.launchPersistentContext(path.join(__dirname, 'build/browser-profiles', tag),
      {channel: 'msedge', headless: true, viewport: {width: 1280, height: 720}});
    await context.route('**/web-engine-worker.js*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})(${JSON.stringify(shaders)});\n` + await response.text()});
    });
    const page = context.pages()[0];
    for (const extra of context.pages().filter(value => value !== page)) await extra.close();
    log = fs.createWriteStream(output + '.log');
    page.on('console', message => {
      const text = message.text(); log.write(text + '\n');
      if (/GPU validation:|Fatal error:|Assertion failed:|DeviceLost/.test(text)) report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    report.url = `http://127.0.0.1:8765/build/${folder}/index.html`;
    await page.goto(report.url, {waitUntil: 'commit'});
    await page.waitForFunction(() => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= 90,
      null, {timeout: 600000});
    assert(!await page.evaluate(() => globalThis.__webEngineFailure));
    const owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
    const snapshot = () => owner.evaluate(() => ({frames: globalThis.__webEngineFrames,
      settings: globalThis.__webProjectSettings, gpu: globalThis.__glassProbe,
      camera: globalThis.__webDefaultCamera}));
    report.initial = await snapshot();
    for (const [name, camera] of [
      ['interior', [-175, -80, 160, -5, 50]],
      ['living', [-20, 200, 130, 12, -35]],
      ['return', [-175, -80, 160, -5, 50]],
    ]) {
      assert.equal(await page.evaluate(camera => __webEngineRPC('WebProjectViewTest', ...camera), camera), 1);
      const before = (await snapshot()).frames;
      await page.waitForFunction(before => globalThis.__webEngineFailure || globalThis.__webEngineFrames >= before + 120,
        before, {timeout: 120000});
      assert(!await page.evaluate(() => globalThis.__webEngineFailure));
      const file = output + '-' + name + '.png';
      await page.locator('canvas').screenshot({path: file});
      const state = await snapshot();
      const comparison = name === 'living' ? null : compareGlass(PNG.sync.read(fs.readFileSync(file)), reference);
      report.views.push({name, screenshot: audit(file), state, comparison});
      assert.deepEqual(state.gpu.errors, []);
      assert.deepEqual(state.gpu.losses, []);
      assert(!comparison || comparison.pass, `Glass chromaticity mismatch: ${name}`);
      console.log(JSON.stringify({name, frames: state.frames, comparison}));
    }
    report.final = await snapshot();
    report.virtualShadowInjectionDispatches = Object.entries(report.final.gpu.dispatches)
      .filter(([entry]) => shaders[entry].virtualShadows).reduce((sum, [, count]) => sum + count, 0);
    assert(report.virtualShadowInjectionDispatches > 0, 'No TLV injection with VSM was executed');
    assert.equal(report.final.settings.virtualShadows, 1);
    assert.equal(report.final.settings.virtualTextures, 1);
    assert.deepEqual(report.errors, []);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
    await context?.close(); log?.end();
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, output}));
  }
})();
