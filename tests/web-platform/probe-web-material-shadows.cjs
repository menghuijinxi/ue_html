const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
const {PNG} = require('pngjs');
const results = path.join(__dirname, 'results');
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, runs: [], sources: [
  __filename, path.join(__dirname, 'capture-web-canvas.cjs')
].map(audit), boundary: 'Actual CSM depth draws, receiver uniforms, quality changes and image comparisons. '
  + 'Texel density uses the lab camera horizontal FOV 90 and 16:9 aspect; atlas bytes exclude driver overhead '
  + 'and retained render-target pool allocations. This does not establish native visual parity or soft shadows.'};

function texelSize(uniform) {
  // ScreenToShadow consumes NDC * view depth. Undo this camera's projection scale.
  return Array.from({length: 4}, (_, cascade) => {
    const m = uniform.matrices.slice(cascade * 16, cascade * 16 + 16);
    return 1 / (Math.hypot(m[0], m[4] * 16 / 9, m[8]) * uniform.size[0]);
  });
}

function observeShadows() {
  const state = {textures: [], passes: [], samplers: [], shaders: [], uniforms: [], frames: 0};
  const views = new WeakMap(), passes = new WeakMap(), uniforms = new WeakMap(), groups = new WeakMap();
  const originalTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function(descriptor) {
    const texture = originalTexture.call(this, descriptor);
    if (/CSM.*Shadowmap/.test(texture.label))
      state.textures.push({label: texture.label, width: texture.width, height: texture.height,
        format: texture.format});
    return texture;
  };
  const originalView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function(descriptor) {
    const view = originalView.call(this, descriptor);
    if (/CSM.*Shadowmap/.test(this.label))
      views.set(view, {label: this.label, width: this.width, height: this.height, format: this.format});
    return view;
  };
  const originalPass = GPUCommandEncoder.prototype.beginRenderPass;
  GPUCommandEncoder.prototype.beginRenderPass = function(descriptor) {
    const pass = originalPass.call(this, descriptor);
    const texture = views.get(descriptor.depthStencilAttachment?.view);
    if (texture && state.frames > 0) {
      const info = {texture, viewports: [], scissors: [], draws: 0};
      state.passes.push(info);
      passes.set(pass, info);
    }
    return pass;
  };
  for (const [name, field] of [['setViewport', 'viewports'], ['setScissorRect', 'scissors']]) {
    const original = GPURenderPassEncoder.prototype[name];
    GPURenderPassEncoder.prototype[name] = function(...args) {
      const info = passes.get(this);
      if (info) info[field].push(args);
      return original.apply(this, args);
    };
  }
  for (const name of ['draw', 'drawIndexed']) {
    const original = GPURenderPassEncoder.prototype[name];
    GPURenderPassEncoder.prototype[name] = function(...args) {
      const info = passes.get(this);
      if (info) ++info.draws;
      return original.apply(this, args);
    };
  }
  const originalSampler = GPUDevice.prototype.createSampler;
  GPUDevice.prototype.createSampler = function(descriptor) {
    if (state.samplers.length < 64) state.samplers.push(descriptor);
    return originalSampler.call(this, descriptor);
  };
  const originalShader = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function(descriptor) {
    if (state.shaders.length < 2 && descriptor.code.includes('DirectionalLightShadowTexture'))
      state.shaders.push(descriptor.code);
    return originalShader.call(this, descriptor);
  };
  const write = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function(buffer, offset, data, dataOffset = 0, size) {
    if (buffer.size >= 380 && buffer.size <= 512 &&
        offset === 0 && (buffer.usage & GPUBufferUsage.UNIFORM)) {
      const bytes = ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset + dataOffset * data.BYTES_PER_ELEMENT,
          (size ?? data.length - dataOffset) * data.BYTES_PER_ELEMENT) :
        new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
      if (bytes.length >= 380) {
        const copy = bytes.slice().buffer;
        const f = new Float32Array(copy), u = new Uint32Array(copy);
        if (f[8] >= 512 && f[9] >= 512 && u[88] > 0 && u[88] <= 4) {
          const info = {size: Array.from(f.slice(8, 12)), distances: Array.from(f.slice(16, 20)),
            cascades: u[88], matrices: Array.from(f.slice(24, 88))};
          uniforms.set(buffer, info);
        }
      }
    }
    return write.call(this, buffer, offset, data, dataOffset, size);
  };
  const createGroup = GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup = function(descriptor) {
    const group = createGroup.call(this, descriptor);
    const info = descriptor.entries.map(entry => uniforms.get(entry.resource?.buffer)).filter(Boolean);
    if (info.length) groups.set(group, info);
    return group;
  };
  const setGroup = GPURenderPassEncoder.prototype.setBindGroup;
  GPURenderPassEncoder.prototype.setBindGroup = function(...args) {
    if (state.frames > 0)
      for (const info of groups.get(args[1]) || [])
        if (!state.uniforms.some(item => JSON.stringify(item) === JSON.stringify(info)))
          state.uniforms.push(info);
    return setGroup.apply(this, args);
  };
  const present = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function() {
    if (state.frames > 0) --state.frames;
    return present.call(this);
  };
  globalThis.__shadowTrace = state;
}

async function settle(page, count = 30) {
  const frame = await page.evaluate(() => globalThis.__webEngineFrames || 0);
  await page.waitForFunction(({frame, count}) => globalThis.__webEngineFailure ||
    globalThis.__webEngineFrames >= frame + count, {frame, count}, {timeout: 60000});
  assert.equal(await page.evaluate(() => globalThis.__webEngineFailure || null), null);
  assert((await page.evaluate(() => globalThis.__webCanvasWaitIdle())).pass);
}

(async () => {
  let browser;
  try {
    const packageFile = path.join(results, 'web-project-material-lab-package-results.json');
    const packaged = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    assert(packaged.pass && packaged.products.every(valid) && packaged.sourceFiles.every(valid));
    report.packageReport = audit(packageFile);
    for (const [name, executablePath] of [
      ['chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ...(process.argv.includes('--both') ?
        [['edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']] : [])
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage({viewport: {width: 2048, height: 1152}});
      const run = {browser: name, errors: [], images: {}, log: []};
      report.runs.push(run);
      page.on('pageerror', error => run.errors.push(error.message));
      page.on('console', message => {
        const text = message.text();
        if (/Shadow|CSM|MaterialLab/.test(text)) run.log.push(text);
        if (/WebGPU validation|GPUValidationError|\[Invalid /.test(text)) run.errors.push(text);
      });
      await page.addInitScript(require('./capture-web-canvas.cjs'));
      await page.addInitScript(observeShadows);
      await page.route('**/material-lab/index.html', async route => {
        const response = await route.fetch();
        const html = await response.text();
        const original = "arguments: ['-webgpu', '-WebProjectMap=/Game/WebMaterialLab'],";
        assert(html.includes(original));
        await route.fulfill({response, body: html.replace(original,
          "arguments: ['-webgpu', '-WebProjectMap=/Game/WebMaterialLab', '-WebVisualTestClock'],")});
      });
      await page.goto('http://127.0.0.1:8765/build/material-lab/index.html', {waitUntil: 'commit'});
      await page.waitForFunction(() => globalThis.__webEngineFailure ||
        globalThis.__webEngineFrames >= 60, null, {timeout: 90000});
      await page.locator('#lab:not([hidden])').waitFor();
      await page.selectOption('#lab-view', 'metal');
      await settle(page);
      const shot = async tag => {
        const file = path.join(results, `material-shadow-${name}-${tag}.png`);
        await page.locator('canvas').screenshot({path: file});
        run.images[tag] = audit(file);
      };
      const capture = async tag => {
        await settle(page);
        await page.evaluate(() => {
          globalThis.__shadowTrace.passes = [];
          globalThis.__shadowTrace.uniforms = [];
          globalThis.__shadowTrace.frames = 4;
        });
        await settle(page, 8);
        await shot(tag);
        const trace = await page.evaluate(() => ({
          passes: globalThis.__shadowTrace.passes, uniforms: globalThis.__shadowTrace.uniforms
        }));
        assert(trace.uniforms.length > 0, 'Expected actual MobileDirectionalLight uniform bindings');
        trace.cmPerTexel = texelSize(trace.uniforms[0]);
        return trace;
      };
      run.published = await capture('published');
      run.trace = await page.evaluate(() => globalThis.__shadowTrace);
      run.shaders = run.trace.shaders.map((source, index) => {
        const file = path.join(results, `material-shadow-${name}-${index}.wgsl`);
        fs.writeFileSync(file, source);
        return audit(file);
      });
      delete run.trace.shaders;
      assert(run.shaders.every(item => fs.readFileSync(item.file, 'utf8').includes('textureGather(')),
        'Expected the cooked manual PCF shader');
      if (process.argv.includes('--controls')) {
        run.settings = await page.evaluate(() => {
          return globalThis.__webMaterialShadow;
        });
        for (const [tag, parameter, value] of [
          ['distance3000', 1, 3000], ['distance2000', 1, 2000],
          ['distribution1', 4, 1], ['distribution2', 4, 2],
          ['resolution4096', 2, 4096], ['cascades1', 3, 1],
          ['bias1', 5, 1], ['bias2', 5, 2], ['slope1', 6, 1], ['slope2', 6, 2]
        ]) {
          assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(0, 0)), 1);
          assert.equal(await page.evaluate(resolution => Module._WebMaterialLabShadowTest(2, resolution),
            run.settings.resolution), 1);
          assert.equal(await page.evaluate(({parameter, value}) =>
            Module._WebMaterialLabShadowTest(parameter, value), {parameter, value}), 1);
          await settle(page);
          await page.evaluate(() => {
            globalThis.__shadowTrace.passes = [];
            globalThis.__shadowTrace.uniforms = [];
            globalThis.__shadowTrace.frames = 3;
          });
          await settle(page, 6);
          run.images[tag + '-settings'] = await page.evaluate(() => globalThis.__webMaterialShadow);
          run.images[tag + '-trace'] = await page.evaluate(() => ({
            uniforms: globalThis.__shadowTrace.uniforms, passes: globalThis.__shadowTrace.passes
          }));
          await shot(tag);
          if (tag === 'resolution4096' && process.argv.includes('--verify-limits'))
            assert(run.images[tag + '-trace'].passes.some(pass =>
              pass.draws > 0 && pass.viewports.some(viewport => viewport[2] === 4096 && viewport[3] === 4096)),
            'Requested 4096 CSM must reach actual GPU viewports instead of the inherited 2048 cap');
        }
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(0, 0)), 1);
        await settle(page);
        await shot('restored');
      }
      if (process.argv.includes('--verify-limits')) {
        run.qualities = [];
        for (const resolution of [1024, 2048, 4096]) {
          await page.selectOption('#lab-shadow', String(resolution));
          const trace = await capture('quality' + resolution);
          const draws = trace.passes.filter(pass => pass.draws > 0);
          const tiles = [...new Set(draws.flatMap(pass => pass.viewports.map(viewport => JSON.stringify(viewport))))];
          assert.equal(tiles.length, 4, 'Each quality must draw all four cascades');
          assert(draws.every(pass => pass.viewports.every(viewport =>
            viewport[2] === resolution && viewport[3] === resolution)));
          assert(trace.uniforms.every(uniform => uniform.cascades === 4 && uniform.distances[3] === 3000));
          const texture = draws[0].texture;
          const bytes = texture.width * texture.height * 4;
          assert.equal(bytes, 4 * resolution * resolution * 4);
          const timing = await page.evaluate(async () => {
            const frame = globalThis.__webEngineFrames, start = performance.now();
            await new Promise(resolve => {
              const tick = () => globalThis.__webEngineFrames >= frame + 120 ?
                resolve() : requestAnimationFrame(tick);
              requestAnimationFrame(tick);
            });
            await globalThis.__webCanvasWaitIdle();
            const frames = globalThis.__webEngineFrames - frame, milliseconds = performance.now() - start;
            return {frames, milliseconds, fps: frames * 1000 / milliseconds};
          });
          run.qualities.push({resolution, bytes, trace, timing});
        }
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(1, 6000)), 1);
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(5, 0.5)), 1);
        await page.selectOption('#lab-shadow', '2048');
        run.previous = await capture('previous');
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(1, 3000)), 1);
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(5, 1)), 1);
        await page.selectOption('#lab-shadow', '4096');
        run.restored = await capture('restored');
        run.densityGain = run.previous.cmPerTexel[2] / run.restored.cmPerTexel[2];
        assert(run.densityGain > 3.8, 'The visible sphere cascade must gain approximately 4x linear texel density');
        await page.selectOption('#lab-shadow', '2048');
        run.publishedRestored = await capture('published-restored');
        assert.deepEqual(run.publishedRestored.uniforms, run.published.uniforms,
          'Restore must recover the published receiver matrices');
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(2, 8192)), 0);
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(3, 5)), 0);
        assert.equal(await page.evaluate(() => Module._WebMaterialLabShadowTest(1, NaN)), 0);
        const comparison = new PNG({width: 640, height: 260});
        for (const [index, tag] of ['previous', 'restored'].entries()) {
          const image = PNG.sync.read(fs.readFileSync(run.images[tag].file));
          PNG.bitblt(image, comparison, 1260, 475, 320, 260, index * 320, 0);
        }
        const file = path.join(results, `material-shadow-${name}-comparison.png`);
        fs.writeFileSync(file, PNG.sync.write(comparison));
        run.comparison = audit(file);
      }
      run.gpuErrors = await page.evaluate(() => globalThis.__webCanvas.gpuErrors);
      assert(run.trace.passes.length > 0, 'Expected actual CSM depth draws');
      assert.deepEqual(run.errors, []);
      assert.deepEqual(run.gpuErrors, []);
      run.pass = true;
      await browser.close();
      browser = null;
    }
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-material-shadow-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, failure: report.failure, runs: report.runs.map(run => ({
      browser: run.browser, pass: run.pass, densityGain: run.densityGain,
      qualities: run.qualities?.map(({resolution, bytes, timing}) => ({resolution, bytes, timing}))
    }))}));
  }
})();
