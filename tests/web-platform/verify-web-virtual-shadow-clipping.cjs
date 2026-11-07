'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const input = path.join(__dirname, 'shaders/virtual-shadow-clip-probe.hlsl');
const spirv = path.join(__dirname, 'build/virtual-shadow-clip.spv');
const sourceFile = path.join(__dirname, 'build/virtual-shadow-clip.wgsl');
const report = {date: new Date().toISOString(), pass: false, input: audit(input)};
(async () => {
  let browser;
  try {
    fs.mkdirSync(path.dirname(sourceFile), {recursive: true});
    fs.mkdirSync(path.join(__dirname, 'results'), {recursive: true});
    const compile = (tool, args) => {
      const result = spawnSync(path.join(root, tool), args, {encoding: 'utf8', windowsHide: true});
      assert.equal(result.status, 0, `${tool}: ${result.error || result.stderr || result.stdout}`);
    };
    compile('.tools/dxc-v1.9.2609/bin/x64/dxc.exe',
      ['-spirv', '-T', 'vs_6_0', '-E', 'Main', input, '-Fo', spirv]);
    compile('.tools/dawn-v20261009.190412/bin/tint.exe', [spirv, '--format', 'wgsl', '-o', sourceFile]);
    const code = fs.readFileSync(sourceFile, 'utf8');
    assert.match(code, /@builtin\(clip_distances\)/);
    report.source = audit(sourceFile);
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765');
    report.gpu = await page.evaluate(async code => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice({requiredFeatures: ['clip-distances']});
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const vs = device.createShaderModule({code});
      const ps = device.createShaderModule({code:
        '@fragment fn ps()->@location(0) vec4f { return vec4f(1,0,0,1); }'});
      const pipeline = device.createRenderPipeline({layout: 'auto', vertex: {module: vs, entryPoint: 'Main'},
        fragment: {module: ps, entryPoint: 'ps', targets: [{format: 'rgba8unorm'}]}});
      const texture = device.createTexture({size: [8, 8], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const readback = device.createBuffer({size: 256 * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({colorAttachments: [{view: texture.createView(),
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1]}]});
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      encoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow: 256}, [8, 8]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      let mismatches = 0, redPixels = 0;
      for (let y = 0; y < 8; ++y) for (let x = 0; x < 8; ++x) {
        const offset = y * 256 + x * 4;
        const expected = x >= 4 && y < 4 ? 255 : 0;
        if (bytes[offset] === 255) ++redPixels;
        if (bytes[offset] !== expected || bytes[offset + 1] || bytes[offset + 2] || bytes[offset + 3] !== 255)
          ++mismatches;
      }
      readback.unmap();
      device.destroy();
      return {mismatches, redPixels, checkedPixels: 64, errors};
    }, code);
    assert.equal(report.gpu.mismatches, 0);
    assert.equal(report.gpu.redPixels, 16);
    assert.deepEqual(report.gpu.errors, []);
    report.pass = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    await browser?.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-virtual-shadow-clipping.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
