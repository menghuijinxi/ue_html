'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results/nanite-ue-shader');
const read = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const stages = Object.fromEntries(['compute', 'vertex', 'fragment', 'consumer'].map(name => [name, {
  code: read(path.join(directory, `${name}.wgsl`)),
  metadata: JSON.parse(read(path.join(directory, `${name}.json`))),
}]));
for (const name of ['compute', 'fragment']) {
  assert.match(stages[name].code, /enable atomic_vec2u_min_max;/);
  assert.equal((stages[name].code.match(/atomicStoreMax\(/g) || []).length, 2,
    'Both writes must survive DXC/Tint optimization');
  assert.doesNotMatch(stages[name].code, /atomicCompareExchangeWeak/);
  const binding = stages[name].metadata.spirvBindings.find(b => b.name === 'WebNaniteAtomicMax_Visibility');
  assert.equal(binding.storageElementStride, 8);
  assert.equal(binding.storagePacking, 'nanite-packed-visibility');
  assert.equal(binding.readOnlyStorage, false);
  assert.equal(stages[name].metadata.bindingContractVerified, true);
}
const compilerTests = JSON.parse(read(path.join(directory, 'compiler-tests.json')));
assert.equal(compilerTests.pass, true);
const report = {date: new Date().toISOString(), pass: false, compilerTests, browsers: [],
  sources: [__filename, ...Object.keys(stages).flatMap(name =>
    ['wgsl', 'json', 'webshader'].map(ext => path.join(directory, `${name}.${ext}`))),
  path.join(__dirname, '../../reference-engine/Engine/Shaders/Private/Nanite/NaniteWritePixel.ush'),
  path.join(__dirname, '../ue-shader-host/Shaders/Private/WebNaniteVisibilityProbe.usf')].map(audit)};

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end('<!doctype html><title>UE Nanite visibility verification</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const channel of ['chrome', 'msedge']) {
      let browser;
      try {
        browser = await chromium.launch({channel, headless: true});
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async stages => {
          const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
          if (!adapter || !adapter.features.has('atomic-vec2u-min-max')) throw Error('Packed atomic feature missing');
          const device = await adapter.requestDevice({requiredFeatures: ['atomic-vec2u-min-max']});
          const errors = [];
          device.addEventListener('uncapturederror', event => errors.push(event.error.message));
          try {
            const modules = {};
            for (const [name, stage] of Object.entries(stages)) {
              modules[name] = device.createShaderModule({code: stage.code});
              const messages = (await modules[name].getCompilationInfo()).messages;
              if (messages.some(m => m.type === 'error'))
                throw Error(`${name}: ${messages.map(m => m.message).join('\n')}`);
            }
            const compute = await device.createComputePipelineAsync({layout: 'auto',
              compute: {module: modules.compute, entryPoint: stages.compute.metadata.webEntry}});
            const consumer = await device.createComputePipelineAsync({layout: 'auto',
              compute: {module: modules.consumer, entryPoint: stages.consumer.metadata.webEntry}});
            const raster = await device.createRenderPipelineAsync({layout: 'auto',
              vertex: {module: modules.vertex, entryPoint: stages.vertex.metadata.webEntry},
              fragment: {module: modules.fragment, entryPoint: stages.fragment.metadata.webEntry,
                targets: [{format: 'rgba8unorm'}]}, primitive: {topology: 'triangle-list'}});
            const bitBuffer = new ArrayBuffer(4), f32 = new Float32Array(bitBuffer), u32 = new Uint32Array(bitBuffer);
            const bits = x => { f32[0] = x; return u32[0]; };
            const depthBits = x => bits(Math.max(0, Math.min(1, x)));
            let seed = 0x31a2c7e9;
            const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
            const denseCandidates = [];
            for (let i = 0; i < 8192; ++i) {
              const value = random(), depth = [0.125, 0.5, 0.75, -1, 2][random() % 5];
              denseCandidates.push([value, depth, (random() >>> 16) % 8, (random() >>> 16) % 8]);
            }
            // Equal depths exercise unsigned ID ties; invalid coordinates must not wrap.
            denseCandidates.push([0xffffffff, 0.5, 2, 2], [0x80000000, 0.5, 2, 2],
              [0x7fffffff, 0.5, 2, 2], [0xffffffff, 1, 8, 0],
              [0xffffffff, 1, 0xffffffff, 0xffffffff], [17, -1, 7, 7], [21, 2, 6, 6]);
            const cases = [];
            const configs = [
              {name: 'compute-contention', order: ['compute']},
              {name: 'fragment-and-repeated-store', order: ['fragment']},
              {name: 'compute-then-fragment', order: ['compute', 'fragment']},
              {name: 'fragment-then-compute', order: ['fragment', 'compute']},
              {name: 'offset-subview-guards', order: ['compute', 'fragment'], prefix: 256},
              {name: 'short-view-guards', order: ['compute'], prefix: 256, count: 15},
              {name: 'zero-width', order: ['compute'], width: 0},
              {name: 'overflow-width', order: ['compute'], width: 0xffffffff},
              {name: 'unsigned-id-ties-and-depth-priority', order: ['compute'], focused: true},
              {name: 'mixed-compute-raster-winners', order: ['compute', 'fragment'], focused: true},
            ];
            for (const config of configs) {
              const candidates = config.focused ? [
                [0xffffffff, 0.5, 0, 0], [0x80000000, 0.5, 0, 0], [0x7fffffff, 0.5, 0, 0],
                [0xffffffff, 0.25, 1, 0], [1, 0.75, 1, 0],
                [0xffffffff, 0.25, 2, 0], [5, -1, 3, 0], [7, 2, 4, 0],
              ] : denseCandidates;
              const prefix = config.prefix || 0, count = config.count || 64;
              const width = config.width ?? 8, height = 8, bytes = prefix + count * 8 + 256;
              const initial = new Uint32Array(bytes / 4).fill(0xa5a5a5a5);
              initial.fill(0, prefix / 4, prefix / 4 + count * 2);
              const expected = initial.slice();
              const select = (id, depth, x, y) => {
                if (!width || x >= width || y >= height || y >= Math.floor(count / width)) return;
                const index = prefix / 4 + 2 * (y * width + x), high = depthBits(depth);
                if (high > expected[index + 1] || (high === expected[index + 1] && id > expected[index])) {
                  expected[index] = id; expected[index + 1] = high;
                }
              };
              const owned = [];
              const buffer = (data, usage) => {
                const result = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
                device.queue.writeBuffer(result, 0, data);
                owned.push(result);
                return result;
              };
              const output = buffer(initial, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
              const inputWords = new Uint32Array(64 + candidates.length * 4 + 64).fill(0xdeadbeef);
              candidates.forEach(([id, depth, x, y], i) => inputWords.set([id, bits(depth), x, y], 64 + i * 4));
              const input = buffer(inputWords, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
              const globals = buffer(new Uint32Array([width, height, 0, 0]), GPUBufferUsage.UNIFORM);
              const consumed = buffer(new Uint32Array(count * 2), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
              const resources = {
                '$Globals': {buffer: globals},
                WebNaniteAtomicMax_Visibility: {buffer: output, offset: prefix, size: count * 8},
                Candidates: {buffer: input, offset: 256, size: candidates.length * 16},
                Visibility: {buffer: output, offset: prefix, size: count * 8},
                Results: {buffer: consumed},
              };
              const bind = (pass, pipeline, metadata) => {
                const highest = Math.max(...metadata.spirvBindings.map(b => b.group));
                for (let group = 0; group <= highest; ++group) {
                  const entries = metadata.spirvBindings.filter(b => b.group === group)
                    .map(b => ({binding: b.binding, resource: resources[b.name]}));
                  pass.setBindGroup(group, device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries}));
                }
              };
              const target = device.createTexture({size: [8, 8], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT});
              const encoder = device.createCommandEncoder();
              for (const mode of config.order) {
                if (mode === 'compute') {
                  const pass = encoder.beginComputePass();
                  pass.setPipeline(compute); bind(pass, compute, stages.compute.metadata);
                  pass.dispatchWorkgroups(Math.ceil(candidates.length / 64) + 1); pass.end();
                  for (const [id, depth, x, y] of candidates) select(id, depth, x, y);
                } else {
                  const pass = encoder.beginRenderPass({colorAttachments: [{view: target.createView(),
                    loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
                  pass.setPipeline(raster); bind(pass, raster, stages.fragment.metadata); pass.draw(3); pass.end();
                  for (let y = 0; y < 8; ++y) for (let x = 0; x < 8; ++x) select(0x80000000 + y * 16 + x, 0.5, x, y);
                }
              }
              const consumePass = encoder.beginComputePass();
              consumePass.setPipeline(consumer); bind(consumePass, consumer, stages.consumer.metadata);
              consumePass.dispatchWorkgroups(Math.ceil(count / 64)); consumePass.end();
              const readback = device.createBuffer({size: bytes + inputWords.byteLength + count * 8,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
              encoder.copyBufferToBuffer(output, 0, readback, 0, bytes);
              encoder.copyBufferToBuffer(input, 0, readback, bytes, inputWords.byteLength);
              encoder.copyBufferToBuffer(consumed, 0, readback, bytes + inputWords.byteLength, count * 8);
              device.queue.submit([encoder.finish()]);
              await readback.mapAsync(GPUMapMode.READ);
              const actual = new Uint32Array(readback.getMappedRange());
              const check = (wanted, offset, label) => {
                for (let i = 0; i < wanted.length; ++i)
                  if (wanted[i] !== actual[offset + i])
                    throw Error(`${config.name} ${label}[${i}]: ${actual[offset + i]} != ${wanted[i]}`);
              };
              check(expected, 0, 'visibility'); check(inputWords, bytes / 4, 'source');
              check(expected.subarray(prefix / 4, prefix / 4 + count * 2),
                (bytes + inputWords.byteLength) / 4, 'readonly-consumer');
              cases.push({name: config.name, pass: true, checkedWords: actual.length, candidates: candidates.length,
                prefix, count, width, order: config.order});
              readback.unmap(); readback.destroy(); target.destroy(); owned.forEach(b => b.destroy());
            }
            await device.queue.onSubmittedWorkDone();
            return {pass: errors.length === 0, errors, cases,
              adapter: {vendor: adapter.info.vendor, architecture: adapter.info.architecture,
                isFallbackAdapter: adapter.info.isFallbackAdapter}};
          } finally { device.destroy(); }
        }, stages);
        report.browsers.push({channel, version: browser.version(), ...result});
      } catch (error) {
        report.browsers.push({channel, pass: false, failure: error.stack});
      } finally { if (browser) await browser.close(); }
    }
    report.pass = report.browsers.length === 2 && report.browsers.every(b => b.pass);
    if (!report.pass) process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.writeFileSync(path.join(__dirname, 'results/nanite-ue-visibility.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, browsers: report.browsers}, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
