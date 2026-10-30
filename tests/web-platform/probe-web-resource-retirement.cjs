const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const observe = require('./web-gpu-memory-observer.cjs');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../reference-engine/Engine/Platforms/Web/Build/WebGPUHandleDiagnostics.js'), 'utf8');
(async () => {
  const report = {date: new Date().toISOString(), pass: false};
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/retirement-probe', route => route.fulfill({
      contentType: 'text/html', body: '<canvas width="64" height="64"></canvas>'}));
    await page.goto('http://127.0.0.1:8765/retirement-probe');
    await page.evaluate(observe);
    report.result = await page.evaluate(async code => {
      globalThis.LibraryManager = {library: {}};
      globalThis.mergeInto = (target, properties) => Object.assign(target, properties);
      // Model the Emdawn handle table; exercise its actual shipped deletion hook.
      globalThis.WebGPU = {Internals: {jsObjects: {}, jsObjectInsert(pointer, object) {
        this.jsObjects[pointer] = object;
      }}};
      (0, eval)(code);
      globalThis.WebGPUHandleDiagnostics = LibraryManager.library.$WebGPUHandleDiagnostics;
      WebGPUHandleDiagnostics.install();
      const adapter = await navigator.gpu.requestAdapter();
      const features = ['texture-formats-tier1', 'texture-formats-tier2'].filter(value => adapter.features.has(value));
      const device = await adapter.requestDevice({requiredFeatures: features});
      const bytes = 4 * 1024 * 1024;
      const source = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
      const output = device.createBuffer({size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      const data = new Uint32Array(bytes / 4);
      for (let i = 0; i < data.length; ++i) data[i] = (i * 2654435761) >>> 0;
      device.queue.writeBuffer(source, 0, data);
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(source, 0, output, 0, bytes);
      WebGPU.Internals.jsObjects[1] = source;
      LibraryManager.library.emwgpuDelete(1);
      if (__webGPUMemory.destroyed.buffer !== 0) throw new Error('Resource destroyed before submission');
      device.queue.submit([encoder.finish()]);
      __webFlushRetiredGPUResources();
      await output.mapAsync(GPUMapMode.READ);
      const actual = new Uint32Array(output.getMappedRange());
      for (let i = 0; i < data.length; ++i)
        if (actual[i] !== data[i]) throw new Error('Submitted copy was corrupted at ' + i);
      output.unmap();
      output.destroy();
      const canvas = document.querySelector('canvas').getContext('webgpu');
      canvas.configure({device, format: navigator.gpu.getPreferredCanvasFormat()});
      const surface = canvas.getCurrentTexture();
      WebGPU.Internals.jsObjects[2] = surface;
      LibraryManager.library.emwgpuDelete(2);
      __webFlushRetiredGPUResources();
      if (__webGPUMemory.destroyed.texture !== 0) throw new Error('Presentation texture was destroyed');
      const module = device.createShaderModule({code:
        '@group(0) @binding(0) var outTex: texture_storage_3d<rg11b10ufloat, write>; ' +
        '@compute @workgroup_size(1) fn main() { textureStore(outTex, vec3i(0), vec4f(0.25, 0.5, 1.0, 1.0)); }'
      });
      const info = await module.getCompilationInfo();
      const texture = device.createTexture({size: [1, 1, 1], dimension: '3d', format: 'rg11b10ufloat',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC});
      const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module}});
      const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
        entries: [{binding: 0, resource: texture.createView()}]});
      const readback = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      const computeEncoder = device.createCommandEncoder(), pass = computeEncoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      computeEncoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow: 256}, [1, 1, 1]);
      WebGPU.Internals.jsObjects[3] = texture;
      LibraryManager.library.emwgpuDelete(3);
      device.queue.submit([computeEncoder.finish()]);
      __webFlushRetiredGPUResources();
      await readback.mapAsync(GPUMapMode.READ);
      const packed = new Uint32Array(readback.getMappedRange())[0];
      const expected = (0x340 | (0x380 << 11) | (0x1e0 << 22)) >>> 0;
      if (packed !== expected) throw new Error(`Packed HDR storage mismatch: ${packed} != ${expected}`);
      readback.unmap();
      readback.destroy();
      const errors = [...__webGPUMemory.errors, ...info.messages.filter(value => value.type === 'error').map(value => value.message)];
      device.destroy();
      return {bytesVerified: bytes, beforeSubmissionPreserved: true, surfacePreserved: true,
        retiredResources: __webGPUHandleDiagnostics.retiredResources,
        destroyedBuffers: __webGPUMemory.destroyed.buffer, packedHDRStorageVerified: true,
        destroyedTextures: __webGPUMemory.destroyed.texture, errors};
    }, source);
    assert.deepEqual(report.result.errors, []);
    assert.equal(report.result.retiredResources, 2);
    assert.equal(report.result.destroyedBuffers, 3);
    assert.equal(report.result.destroyedTextures, 1);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(__dirname, 'results/web-resource-retirement-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    await browser?.close();
  }
})();
