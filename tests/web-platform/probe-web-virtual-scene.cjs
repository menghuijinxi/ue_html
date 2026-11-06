'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const {audit} = require('./content-file-metadata.cjs');
const inspectTexturePair = require('./virtual-texture-image-check.cjs');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const folder = argument('folder') || 'triplex-virtual-distance-fields-threads';
const tag = argument('tag') || 'virtual-scene';
const fixture = process.argv.includes('--vt-fixture');
assert([folder, tag].every(value => /^[a-z0-9-]+$/.test(value)));
const output = path.join(__dirname, 'results', tag);
async function bounded(promise, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Diagnostic snapshot timed out')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const report = {date: new Date().toISOString(), pass: false, virtualTextureStreamingCovered: false,
  desktopVisualParityAccepted: false, source: audit(__filename), folder, fixture, views: [], errors: []};
if (fixture) {
  report.viewDefinitions = audit(path.join(__dirname, 'virtual-texture-views.json'));
  report.imageCheck = audit(require.resolve('./virtual-texture-image-check.cjs'));
}
function observe() {
  const state = globalThis.__virtualSceneGPU = {
    errors: [], losses: [], textures: [], atomicToTexture: 0, textureToAtomic: 0,
    textureUploads: {}, largestBuffer: 0,
  };
  const createDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function(...args) {
    const device = await createDevice.apply(this, args);
    device.addEventListener('uncapturederror', event => {
      if (state.errors.length < 30) state.errors.push(event.error.message);
    });
    device.lost.then(info => {
      if (info.reason !== 'destroyed') state.losses.push({reason: info.reason, message: info.message});
    });
    return device;
  };
  const texture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    if (/Shadow\.Virtual|VirtualTexture|PageTable/.test(descriptor.label || '') && state.textures.length < 250)
      state.textures.push({label: descriptor.label, size: descriptor.size,
        format: descriptor.format, mips: descriptor.mipLevelCount || 1});
    return texture.call(this, descriptor);
  };
  const buffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function(descriptor) {
    state.largestBuffer = Math.max(state.largestBuffer, descriptor.size);
    return buffer.call(this, descriptor);
  };
  const writeTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function(destination, ...args) {
    const label = destination.texture.label;
    if (/VirtualTexture|PhysicalTexture/.test(label)) {
      const item = state.textureUploads[label] ||= {count: 0, bytes: 0};
      ++item.count;
      item.bytes += args[0].byteLength;
    }
    return writeTexture.call(this, destination, ...args);
  };
  for (const [name, count, side] of [
    ['copyBufferToTexture', 'atomicToTexture', 1],
    ['copyTextureToBuffer', 'textureToAtomic', 0],
  ]) {
    const original = GPUCommandEncoder.prototype[name];
    GPUCommandEncoder.prototype[name] = function(...args) {
      const label = args[side]?.texture?.label || '';
      if (/Shadow\.Virtual/.test(label)) ++state[count];
      if (name === 'copyBufferToTexture' && /VirtualTexture_Physical/.test(label)) {
        const item = state.textureUploads[label] ||= {count: 0, bytes: 0};
        ++item.count;
      }
      return original.apply(this, args);
    };
  }
}
(async () => {
  let browser, page, log, owner;
  try {
    const context = await chromium.launchPersistentContext(
      path.join(__dirname, 'build/browser-profiles', tag), {headless: true,
        executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        viewport: {width: 1280, height: 720}});
    browser = context;
    if (process.argv.includes('--proxy-diagnostics')) {
      report.proxyDiagnostics = true;
      await context.route('**/UEWebEngineThreads.js?*', async route => {
        const response = await route.fetch();
        const original = 'assert(func.length == proxiedJSCallArgs.length, "Call args mismatch in _emscripten_receive_on_main_thread_js");';
        const replacement = `if (func.length !== proxiedJSCallArgs.length) console.error('WEB_PROXY_MISMATCH',
          JSON.stringify({funcIndex, emAsmAddr, expected:func.length, actual:proxiedJSCallArgs.length,
          functionSource:String(func), values:proxiedJSCallArgs.map(String)}));\n${original}`;
        const source = await response.text();
        assert(source.includes(original));
        await route.fulfill({response, body: source.replace(original, replacement)});
      });
    }
    await context.route('**/web-engine-worker.js?*', async route => {
      const response = await route.fetch();
      await route.fulfill({response, body: `(${observe.toString()})();\n` + await response.text()});
    });
    page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().filter(value => value !== page)) await extra.close();
    log = fs.createWriteStream(output + '.console.log');
    page.on('console', message => {
      const text = message.text();
      log.write(text + '\n');
      if (/Assertion failed:|Fatal error:/.test(text)) report.errors.push(text);
    });
    page.on('pageerror', error => report.errors.push(error.stack || error.message));
    report.url = `http://127.0.0.1:8765/build/${folder}/index.html`;
    await page.goto(report.url, {waitUntil: 'commit'});
    for (let attempt = 0; attempt < 20; ++attempt) {
      owner = page.workers().find(worker => worker.url().includes('web-engine-worker.js'));
      const state = await page.evaluate(() => ({
        failure: globalThis.__webEngineFailure || globalThis.__webThreadsFailure,
        frames: globalThis.__webEngineFrames || 0,
        loading: globalThis.__webStartupDiagnostics?.localContent,
      }));
      assert(!report.errors.length, report.errors.join('\n'));
      assert(!state.failure, JSON.stringify(state.failure));
      if (state.frames >= 60 && owner) break;
      console.log(JSON.stringify({startupAttempt: attempt, ...state}));
      await page.waitForTimeout(30000);
    }
    assert(owner, 'Engine owner worker missing');
    const snapshot = () => owner.evaluate(() => ({
      frames: globalThis.__webEngineFrames, rhiFrames: globalThis.__webRHIFrames,
      settings: globalThis.__webProjectSettings, streaming: globalThis.__webTextureStreaming,
      view: globalThis.__webRenderView, camera: globalThis.__webDefaultCamera,
      threads: globalThis.__webEngineThreads, gpu: globalThis.__virtualSceneGPU,
    }));
    report.initial = await snapshot();
    assert(report.initial.frames >= 60, 'Scene did not reach sixty frames');
    assert(report.initial.settings.virtualTextures === 1 && report.initial.settings.virtualTexturePathActive,
      'Virtual texture support is not active');
    assert(report.initial.settings.virtualShadows === 1 && report.initial.settings.virtualShadowPathActive,
      'Virtual shadow maps are not active');
    const camera = report.initial.camera;
    assert(camera, 'No scene camera');
    const capture = async name => {
      const file = output + '-' + name + '.png';
      await page.locator('canvas').screenshot({path: file, timeout: 30000});
      const png = PNG.sync.read(fs.readFileSync(file));
      const colors = new Set();
      let visible = 0;
      for (let offset = 0; offset < png.data.length; offset += 4) {
        colors.add(png.data.readUInt32LE(offset));
        if (png.data[offset] + png.data[offset + 1] + png.data[offset + 2] > 24) ++visible;
      }
      const state = await snapshot();
      report.views.push({name, screenshot: audit(file), colors: colors.size,
        visibleFraction: visible / (png.width * png.height), state});
      if (fixture) {
        const view = require('./virtual-texture-views.json').find(view => view.name === name);
        const comparison = inspectTexturePair(png, view);
        report.views.at(-1).textureComparison = comparison;
        assert(comparison.pass, 'Ordinary and virtual texture panels do not show matching colors');
      }
      assert(colors.size > 1000 && visible > png.width * png.height * 0.2, 'Scene screenshot is blank');
      assert(!state.gpu.errors.length && !state.gpu.losses.length, 'WebGPU validation or device loss');
    };
    if (!fixture) await capture('spawn');
    const views = fixture ? require('./virtual-texture-views.json').map(view =>
      [view.name, view.x, view.y, view.z, view.pitch, view.yaw]) : [
      ['interior', -175, -80, 160, -5, 50], ['kitchen', -175, -80, 160, -5, 230],
      ['living', -20, 200, 130, 12, -35], ['return', camera.x, camera.y, camera.z, camera.pitch, camera.yaw],
    ];
    for (const [name, ...values] of views) {
      const before = (await snapshot()).frames;
      assert.equal(await page.evaluate(values => __webEngineRPC('WebProjectViewTest', ...values), values), 1);
      await page.waitForFunction(frame => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= frame + 45, before, {timeout: 180000});
      await capture(name);
    }
    report.final = await snapshot();
    assert(report.final.gpu.textures.some(texture => /PhysicalPagePool/.test(texture.label)),
      'No virtual shadow physical page pool was created');
    assert(report.final.gpu.atomicToTexture > 0 && report.final.gpu.textureToAtomic > 0,
      'Virtual shadow atomic texture synchronization was not exercised');
    const uploads = state => Object.entries(state.gpu.textureUploads)
      .filter(([name]) => /VirtualTexture_Physical/.test(name)).reduce((sum, [, item]) => sum + item.count, 0);
    report.virtualTextureResourcesActive = report.final.streaming.virtualTextureResources > 0;
    report.physicalTileUploadsAfterCameraChanges = uploads(report.final) - uploads(report.initial);
    report.virtualTextureStreamingCovered = fixture && report.virtualTextureResourcesActive &&
      report.physicalTileUploadsAfterCameraChanges > 0 && report.views.every(view => view.textureComparison?.pass);
    if (fixture) assert(report.virtualTextureStreamingCovered,
      'Fixture did not exercise visible virtual texture tiles after camera changes');
    assert(!report.errors.length, 'Page reported JavaScript errors');
    report.pass = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    if (owner) {
      try { report.ownerFailureState = await bounded(owner.evaluate(() => ({
        frames: globalThis.__webEngineFrames, gpu: globalThis.__virtualSceneGPU,
        settings: globalThis.__webProjectSettings, streaming: globalThis.__webTextureStreaming,
      }))); } catch {}
    }
    if (page) {
      try { report.pageState = await bounded(page.evaluate(() => ({
        failure: globalThis.__webEngineFailure, threadsFailure: globalThis.__webThreadsFailure,
        frames: globalThis.__webEngineFrames, settings: globalThis.__webProjectSettings,
      }))); } catch {}
    }
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (log) await new Promise(resolve => log.end(resolve));
    fs.writeFileSync(output + '.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, views: report.views.length,
      virtualTextureStreamingCovered: report.virtualTextureStreamingCovered,
      failure: report.failure, output: output + '.json'}, null, 2));
  }
})();
