'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const root = path.resolve(__dirname, '../..');
const input = path.join(__dirname, 'shaders/virtual-shadow-depth-probe.hlsl');
const directory = path.join(__dirname, 'build/virtual-shadow-depth-probe');
fs.mkdirSync(directory, {recursive: true});
const report = {date: new Date().toISOString(), pass: false, sources: [
  __filename, input, path.join(root, 'reference-engine/Engine/Shaders/Private/VirtualShadowMaps/WebVirtualShadowDepth.ush')
].map(audit)};
const cookDirectory = process.argv.find(arg => arg.startsWith('--cook='))?.slice(7);
(async () => {
  let browser;
  try {
    if (cookDirectory) {
      report.cookedShaders = [];
      for (const name of fs.readdirSync(cookDirectory)) {
        const file = path.join(cookDirectory, name, 'output.wgsl');
        if (!fs.existsSync(file)) continue;
        const code = fs.readFileSync(file, 'utf8');
        if (!code.includes('@fragment') || !code.includes('ShadowDepthPass_OutDepthBufferArray')) continue;
        assert.match(code, /VirtualShadowMap_PhysicalPoolSize/);
        assert.match(code, /atomicMax/);
        assert.doesNotMatch(code, /atomicLoad/, file);
        report.cookedShaders.push(audit(file));
      }
      assert(report.cookedShaders.length, 'Require actual cooked shadow fragment permutations');
    }
    const shaders = {};
    for (const [stage, entry] of [['vs', 'VS'], ['ps', 'PS']]) {
      const spirv = path.join(directory, stage + '.spv'), wgsl = path.join(directory, stage + '.wgsl');
      for (const [tool, args] of [
        ['.tools/dxc-v1.9.2609/bin/x64/dxc.exe', ['-spirv', '-T', stage + '_6_0', '-E', entry, input, '-Fo', spirv]],
        ['.tools/dawn-v20261009.190412/bin/tint.exe', [spirv, '--format', 'wgsl', '-o', wgsl]]
      ]) {
        const result = spawnSync(path.join(root, tool), args, {encoding: 'utf8', windowsHide: true});
        assert.equal(result.status, 0, result.stderr || result.stdout);
      }
      shaders[stage] = fs.readFileSync(wgsl, 'utf8');
      report.sources.push(audit(wgsl));
    }
    assert.match(shaders.ps, /atomicMax/);
    assert.doesNotMatch(shaders.ps, /atomicLoad/);
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765');
    report.gpu = await page.evaluate(async shaders => {
      const adapter = await navigator.gpu.requestAdapter();
      const device = await adapter.requestDevice();
      const errors = [], cases = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const pipeline = device.createRenderPipeline({layout: 'auto',
        vertex: {module: device.createShaderModule({code: shaders.vs}), entryPoint: 'VS'},
        fragment: {module: device.createShaderModule({code: shaders.ps}), entryPoint: 'PS',
          targets: [{format: 'r8unorm', writeMask: 0}]}});
      for (const [width, height, layers] of [[1, 1, 1], [5, 3, 2], [65, 7, 2], [129, 4, 3], [128, 128, 2]]) {
        const pitch = Math.ceil(width / 64) * 64, count = 64 + pitch * height * layers;
        const initial = new Uint32Array(count);
        // Poison the old header: the fragment must use the authoritative uniform dimensions.
        initial.fill(0xa5a5a5a5, 0, 64);
        for (let i = 64; i < count; ++i) initial[i] = i % 7 === 0 ? 0x3f700000 : 0x3e000000;
        const buffer = device.createBuffer({size: initial.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
        device.queue.writeBuffer(buffer, 0, initial);
        const target = device.createTexture({size: [width + 1, height + 1], format: 'r8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT});
        const encoder = device.createCommandEncoder(), uniforms = [];
        for (let layer = 0; layer < layers; ++layer) for (let invalid = 0; invalid < 4; ++invalid) {
          const uniform = device.createBuffer({size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
          uniforms.push(uniform);
          device.queue.writeBuffer(uniform, 0, new Uint32Array([width, height, layers, layer, invalid, 0, 0, 0]));
          const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
            entries: [{binding: 0, resource: {buffer}}, {binding: 1, resource: {buffer: uniform}}]});
          const pass = encoder.beginRenderPass({colorAttachments: [
            {view: target.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0]}]});
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.draw(3, 3); pass.end();
        }
        const readback = device.createBuffer({size: initial.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        encoder.copyBufferToBuffer(buffer, 0, readback, 0, initial.byteLength);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Uint32Array(readback.getMappedRange());
        let mismatches = 0;
        for (let i = 0; i < count; ++i) {
          const texel = i >= 64 && (i - 64) % pitch < width;
          const expected = texel ? Math.max(initial[i], 0x3f400000) : initial[i];
          if (actual[i] !== expected) ++mismatches;
        }
        cases.push({width, height, layers, pitch, checkedWords: count, mismatches});
        readback.unmap(); readback.destroy(); buffer.destroy(); target.destroy();
        for (const uniform of uniforms) uniform.destroy();
      }
      await device.queue.onSubmittedWorkDone(); device.destroy();
      return {cases, errors};
    }, shaders);
    assert(report.gpu.cases.every(item => item.mismatches === 0));
    assert.deepEqual(report.gpu.errors, []);
    report.pass = true;
  } catch (error) {report.error = error.stack; process.exitCode = 1;}
  finally {
    await browser?.close();
    fs.writeFileSync(path.join(__dirname, 'results/web-virtual-shadow-depth.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  }
})();
