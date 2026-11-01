'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results/manual-vertex-fetch-shader');
const shaderFile = path.join(directory, 'vertex-fetch.wgsl');
const metadataFile = path.join(directory, 'vertex-fetch.json');
const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8').replace(/^\uFEFF/, ''));
const code = fs.readFileSync(shaderFile, 'utf8').replace(/^\uFEFF/, '');
const report = {date: new Date().toISOString(), pass: false, sources: [__filename, shaderFile, metadataFile].map(audit)};
let browser;
(async () => {
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765/');
    report.gpu = await page.evaluate(async ({code, metadata}) => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const device = await adapter.requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', e => errors.push(e.error.message));
      const module = device.createShaderModule({code});
      const messages = (await module.getCompilationInfo()).messages.map(m => ({type: m.type, message: m.message}));
      if (messages.some(m => m.type === 'error')) throw Error(JSON.stringify(messages));
      const pipeline = await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: metadata.webEntry}});
      const floats = values => [...new Uint32Array(new Float32Array(values).buffer)];
      const inputs = {
        half: {code: 1, words: [0xc0003c00, 0x7bff0001], values: [[1, -2], [2 ** -24, 65504]]},
        uv32: {code: 2, words: floats([0.25, -8, 1024.5, 0]), values: [[0.25, -8], [1024.5, 0]]},
        snorm8: {code: 3, words: [0x7f00ff80, 0xc040817e], values: [[-1, -1 / 127, 0, 1], [126 / 127, -1, 64 / 127, -64 / 127]]},
        snorm16: {code: 4, words: [0xffff8000, 0x7fff0000, 0x80017ffe, 0xc0004000],
          values: [[-1, -1 / 32767, 0, 1], [32766 / 32767, -1, 16384 / 32767, -16384 / 32767]]},
        color: {code: 5, words: [0xff800100, 0x201040fe], values: [[0, 1 / 255, 128 / 255, 1], [254 / 255, 64 / 255, 16 / 255, 32 / 255]]},
        float4: {code: 6, words: floats([0.25, -1, 2, 3, 17, 0, -0.5, 42]), values: [[0.25, -1, 2, 3], [17, 0, -0.5, 42]]},
        nullTangent: {code: 7, words: [0, 0, 0], values: [[0, 0, 0, 0], [0, 0, 0, 0]]},
      };
      const names = ['LocalVF_VertexFetch_TexCoordBuffer', 'LocalVF_VertexFetch_PackedTangentsBuffer', 'LocalVF_VertexFetch_ColorComponentsBuffer'];
      const buffer = (words, usage, prefix = 0) => {
        const value = device.createBuffer({size: prefix + words.length * 4, usage: usage | GPUBufferUsage.COPY_DST});
        if (prefix) device.queue.writeBuffer(value, 0, new Uint32Array(prefix / 4).fill(0xdeadbeef));
        device.queue.writeBuffer(value, prefix, new Uint32Array(words));
        return value;
      };
      const cases = [];
      for (const uv of ['half', 'uv32']) for (const tangent of ['snorm8', 'snorm16', 'float4', 'nullTangent']) {
        const data = [inputs[uv], inputs[tangent], inputs.color];
        // Bind nonzero aligned view offsets, poison the prefix, and dispatch a
        // third out-of-range index to exercise the browser's robust loads.
        const resources = Object.fromEntries(names.map((name, i) => [name, {
          buffer: buffer(data[i].words, GPUBufferUsage.STORAGE, 256), offset: 256, size: data[i].words.length * 4,
        }]));
        resources.WebVertexFetchFormats = {buffer: buffer([...data.map(v => v.code), 0], GPUBufferUsage.UNIFORM)};
        resources.Results = {buffer: device.createBuffer({size: 3 * 3 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC})};
        const groups = new Map();
        for (const binding of metadata.spirvBindings) {
          if (!resources[binding.name]) throw Error(`Unexpected probe binding ${binding.name}`);
          if (!groups.has(binding.group)) groups.set(binding.group, []);
          groups.get(binding.group).push({binding: binding.binding, resource: resources[binding.name]});
        }
        const readback = device.createBuffer({size: 3 * 3 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (const [group, entries] of groups) pass.setBindGroup(group,
          device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries}));
        pass.dispatchWorkgroups(3);
        pass.end();
        encoder.copyBufferToBuffer(resources.Results.buffer, 0, readback, 0, 3 * 3 * 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = [...new Float32Array(readback.getMappedRange())];
        const expected = [];
        for (let i = 0; i < 3; ++i) {
          expected.push(...(data[0].values[i] || [0, 0]), 0, 1,
            ...(data[1].values[i] || [0, 0, 0, 0]), ...(data[2].values[i] || [0, 0, 0, 0]));
        }
        const maxError = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
        if (!Number.isFinite(maxError) || maxError > 0.000002) throw Error(JSON.stringify({uv, tangent, actual, expected, maxError}));
        cases.push({uv, tangent, maxError, values: actual.length, offset: 256, outOfBoundsZero: true});
        readback.unmap(); readback.destroy();
        for (const resource of Object.values(resources)) resource.buffer.destroy();
      }
      await device.queue.onSubmittedWorkDone();
      device.destroy();
      return {adapter: {vendor: adapter.info.vendor, architecture: adapter.info.architecture}, messages, errors, cases};
    }, {code, metadata});
    assert.equal(report.gpu.cases.length, 8);
    assert.deepEqual(report.gpu.errors, []);
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(__dirname, 'results/manual-vertex-fetch-formats.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
