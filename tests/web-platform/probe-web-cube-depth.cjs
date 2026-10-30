const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

(async () => {
  const browser = await chromium.launch({channel: 'msedge', headless: true,
    args: ['--enable-unsafe-webgpu']});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765/', {waitUntil: 'commit'});
    const shader = fs.readFileSync(path.join(__dirname, 'shaders/cube-shadow-comparison.wgsl'), 'utf8');
    const result = await page.evaluate(async fragment => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
      const cube = device.createTexture({size: [4, 4, 6], format: 'depth32float', usage});
      const cached = device.createTexture({size: [4, 4, 6], format: 'depth32float', usage});
      const face = device.createTexture({size: [4, 4], format: 'depth32float', usage});
      const color = device.createTexture({size: [6, 1], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const readback = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      const encoder = device.createCommandEncoder();
      for (let index = 0; index < 6; ++index) {
        const pass = encoder.beginRenderPass({colorAttachments: [], depthStencilAttachment: {
          view: face.createView(), depthLoadOp: 'clear', depthStoreOp: 'store',
          depthClearValue: index % 2 ? 0.8 : 0.2}});
        pass.end();
        encoder.copyTextureToTexture({texture: face}, {texture: cached, origin: [0, 0, index]}, [4, 4, 1]);
        encoder.copyTextureToTexture({texture: cached, origin: [0, 0, index]}, {texture: face}, [4, 4, 1]);
        encoder.copyTextureToTexture({texture: face}, {texture: cube, origin: [0, 0, index]}, [4, 4, 1]);
      }
      const vertex = device.createShaderModule({code: `
        @vertex fn main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
          let positions = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
          return vec4f(positions[index], 0, 1);
        }`});
      const layout = device.createBindGroupLayout({entries: [
        {binding: 0, visibility: GPUShaderStage.FRAGMENT,
          texture: {sampleType: 'depth', viewDimension: 'cube'}},
        {binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {type: 'comparison'}},
      ]});
      const group = device.createBindGroup({layout, entries: [
        {binding: 0, resource: cube.createView({dimension: 'cube'})},
        {binding: 1, resource: device.createSampler({compare: 'less', minFilter: 'linear', magFilter: 'linear'})},
      ]});
      const directions = ['1, 0, 0', '-1, 0, 0', '0, 1, 0', '0, -1, 0', '0, 0, 1', '0, 0, -1'];
      const pass = encoder.beginRenderPass({colorAttachments: [{view: color.createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
      for (let index = 0; index < 6; ++index) {
        const pipeline = device.createRenderPipeline({layout: device.createPipelineLayout({bindGroupLayouts: [layout]}),
          vertex: {module: vertex, entryPoint: 'main'},
          fragment: {module: device.createShaderModule({code: fragment.replace('vec3f(1, 0, 0)',
            `vec3f(${directions[index]})`)}), entryPoint: 'main', targets: [{format: 'rgba8unorm'}]}});
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.setViewport(index, 0, 1, 1, 0, 1);
        pass.setScissorRect(index, 0, 1, 1);
        pass.draw(3);
      }
      pass.end();
      encoder.copyTextureToBuffer({texture: color}, {buffer: readback, bytesPerRow: 256}, [6, 1, 1]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = Array.from(new Uint8Array(readback.getMappedRange()).slice(0, 24));
      readback.unmap();
      device.destroy();
      return {bytes, errors};
    }, shader);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.bytes, [0, 0, 0, 0, 255, 255, 255, 255,
      0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
    console.log(JSON.stringify({pass: true, sixFaceComparisonAndCachedDepthCopies: result}));
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
