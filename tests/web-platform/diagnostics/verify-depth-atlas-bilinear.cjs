'use strict';
const {initializeProjectOutput, assertProjectOutput, assertProjectOutputTree} = require('../project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const base = path.resolve(__dirname, '..'), tag = process.argv[2];
assert(tag && /^[a-z0-9-]+$/.test(tag));
const output = assertProjectOutput(path.join(base, 'results', tag + '.json'));
assert(!fs.existsSync(output), 'Preserve existing numerical results');
const source = fs.readFileSync(path.resolve(base,
  '../ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDepthAtlasSampling.h'), 'utf8');
const wgsl = source.match(/R"WGSL\(([\s\S]*?)\)WGSL"/)?.[1];
assert(wgsl, 'Test the actual helper compiled into the RHI');
let browser;
const report = {date: new Date().toISOString(), pass: false};
(async () => {
  try {
    const profile = assertProjectOutputTree(path.join(base, 'build/browser-profiles/villa-pso-startup-20261113'));
    browser = await chromium.launchPersistentContext(profile, {channel: 'msedge', headless: true,
      downloadsPath: assertProjectOutput(path.join(profile, 'downloads')),
      args: ['--disk-cache-dir=' + assertProjectOutput(path.join(profile, 'http-cache')),
        '--crash-dumps-dir=' + assertProjectOutput(path.join(profile, 'crashes'))]});
    const page = browser.pages()[0] || await browser.newPage();
    await page.goto('http://127.0.0.1:8765/');
    report.result = await page.evaluate(async helper => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      if (!adapter) throw Error('No GPU adapter');
      const device = await adapter.requestDevice(), errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      try {
        const texture = device.createTexture({size: [2, 2], format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
        device.queue.writeTexture({texture}, new Float32Array([0, .25, .5, 1]), {bytesPerRow: 8}, [2, 2]);
        const output = device.createBuffer({size: 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
        const readback = device.createBuffer({size: 20, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
        const module = device.createShaderModule({code: helper + `
@group(0) @binding(0) var atlas: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = array<vec2f, 5>(vec2f(.5), vec2f(-.25), vec2f(1.25), vec2f(.25), vec2f(.75, .25));
  result[id.x] = WebDepthAtlasBilinear(atlas, uv[id.x], 0.0).x;
}`});
        const layout = device.createBindGroupLayout({entries: [
          {binding: 0, visibility: GPUShaderStage.COMPUTE, texture: {sampleType: 'unfilterable-float'}},
          {binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: {type: 'storage'}},
        ]});
        const pipeline = await device.createComputePipelineAsync({
          layout: device.createPipelineLayout({bindGroupLayouts: [layout]}), compute: {module, entryPoint: 'main'}});
        const group = device.createBindGroup({layout, entries: [
          {binding: 0, resource: texture.createView()}, {binding: 1, resource: {buffer: output}}]});
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(5); pass.end();
        encoder.copyBufferToBuffer(output, 0, readback, 0, 20); device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = Array.from(new Float32Array(readback.getMappedRange()));
        readback.unmap();
        return {values, errors};
      } finally {device.destroy();}
    }, wgsl);
    const expected = [.4375, 0, 1, 0, .25];
    assert.deepEqual(report.result.errors, []);
    report.result.values.forEach((value, index) => assert(Math.abs(value - expected[index]) < 1e-6,
      'Bilinear interpolation and edge clamping, sample ' + index));
    report.pass = true;
    console.log(JSON.stringify(report));
  } catch (error) {report.error = error.stack; throw error;}
  finally {await browser?.close(); fs.writeFileSync(output, JSON.stringify(report, null, 2));}
})().catch(error => {console.error(error); process.exitCode = 1;});
