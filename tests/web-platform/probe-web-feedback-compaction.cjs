'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const directory = path.resolve(process.argv[2]);
const output = path.join(__dirname, 'results/lumen-feedback-compaction-gpu.json');
const jobs = fs.readdirSync(directory, {withFileTypes: true}).filter(item => item.isDirectory())
  .map(item => path.join(directory, item.name)).filter(item => fs.existsSync(path.join(item, 'output.wgsl')))
  .map(item => {
    const input = JSON.parse(fs.readFileSync(path.join(item, 'input.json'), 'utf8'));
    return {shader: input.shader, name: input.shaderName, metadata: input.metadata,
      code: fs.readFileSync(path.join(item, 'output.wgsl'), 'utf8'),
      sourceFiles: ['input.json', 'output.wgsl'].map(name => audit(path.join(item, name)))};
  });
const report = {date: new Date().toISOString(), pass: false, completeLumenScene: false,
  sourceFiles: [audit(__filename), ...jobs.flatMap(job => job.sourceFiles)], cases: []};
(async () => {
  let browser;
  try {
    assert.equal(jobs.length, 6, 'Expected both permutations of all three feedback shaders');
    for (const job of jobs.filter(job => job.name === 'FCompactFeedbackHashTableCS'))
      assert.equal(job.metadata.spirvBindings.find(binding =>
        binding.name === 'RWCompactedFeedbackBuffer')?.storageElementStride, 8,
      'Compacted feedback must match the actual UE uint2 UAV stride');
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/feedback-compaction', route =>
      route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Feedback compaction probe</title>'}));
    await page.goto('http://127.0.0.1:8765/feedback-compaction');
    report.cases = await page.evaluate(async jobs => {
      const check = (value, message) => { if (!value) throw Error(message); };
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const device = await adapter.requestDevice();
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      device.pushErrorScope('validation');
      const results = [];
      for (const permutation of [0, 1]) {
        const shaders = {};
        for (const name of ['FBuildFeedbackHashTableIndirectArgsCS',
          'FBuildFeedbackHashTableCS', 'FCompactFeedbackHashTableCS']) {
          const job = jobs.find(job => job.name === name && job.shader.includes(`/${permutation}:`));
          check(job, `Missing ${name}/${permutation}`);
          const module = device.createShaderModule({code: job.code});
          const info = await module.getCompilationInfo();
          check(!info.messages.some(message => message.type === 'error'), 'Shader module rejected');
          shaders[name] = {...job, pipeline: await device.createComputePipelineAsync({layout: 'auto',
            compute: {module, entryPoint: job.metadata.webEntry}})};
        }
        for (const [count, capacity] of [[0, 4], [1, 4], [65, 257], [257, 257], [257, 4]]) {
          const stride = permutation + 1, sentinel = 0x7e35a91b, tableSize = 64;
          const input = new Uint32Array(Math.max(1, count) * stride), expected = new Map();
          for (let index = 0; index < count; ++index) {
            const id = index % 23 + 1;
            input[index * stride] = id;
            if (stride === 2) input[index * stride + 1] = id * 3;
            expected.set(id, (expected.get(id) || 0) + 1);
          }
          const resources = [];
          const buffer = (data, extra = 0) => {
            const result = device.createBuffer({size: data.byteLength,
              usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra});
            device.queue.writeBuffer(result, 0, data);
            resources.push(result);
            return result;
          };
          const allocator = buffer(new Uint32Array([count]));
          const feedback = buffer(input), keys = buffer(new Uint32Array(tableSize));
          const indices = buffer(new Uint32Array(tableSize)), counts = buffer(new Uint32Array(tableSize));
          const indirect = buffer(new Uint32Array([0, 0, 0, sentinel]), GPUBufferUsage.INDIRECT);
          const initial = new Uint32Array(capacity * 2 + 4).fill(sentinel);
          initial[0] = 0;
          const compacted = buffer(initial);
          const values = {FeedbackBufferSize: count, CompactedFeedbackBufferSize: capacity,
            CompactedFeedbackCountShiftBits: 16, HashTableSize: tableSize, HashTableIndexWrapMask: tableSize - 1};
          const buffers = {FeedbackBufferAllocator: allocator, FeedbackBuffer: feedback,
            RWHashTableKeys: keys, RWHashTableElementIndices: indices, RWHashTableElementCounts: counts,
            HashTableElementIndices: indices, HashTableElementCounts: counts,
            RWBuildHashTableIndirectArgs: indirect, RWCompactedFeedbackBuffer: compacted};
          const dispatch = (encoder, name, mode) => {
            const shader = shaders[name];
            const entries = shader.metadata.spirvBindings.map(binding => {
              check(binding.group === 0, 'Unexpected binding group');
              let resource = buffers[binding.name];
              if (binding.descriptorType === 6) {
                const bytes = new Uint8Array(binding.paddedSize), view = new DataView(bytes.buffer);
                for (const member of binding.members) {
                  check(member.name in values, `Unexpected uniform ${member.name}`);
                  view.setUint32(member.offset, values[member.name], true);
                }
                resource = device.createBuffer({size: bytes.byteLength,
                  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
                device.queue.writeBuffer(resource, 0, bytes);
                resources.push(resource);
              } else check(binding.descriptorType === 7, 'Expected buffer resource');
              check(resource, `Missing ${binding.name}`);
              return {binding: binding.binding, resource: {buffer: resource}};
            });
            const group = device.createBindGroup({layout: shader.pipeline.getBindGroupLayout(0), entries});
            const pass = encoder.beginComputePass();
            pass.setPipeline(shader.pipeline); pass.setBindGroup(0, group);
            if (mode === 'indirect') pass.dispatchWorkgroupsIndirect(indirect, 0);
            else pass.dispatchWorkgroups(1);
            pass.end();
          };
          const encoder = device.createCommandEncoder();
          dispatch(encoder, 'FBuildFeedbackHashTableIndirectArgsCS');
          dispatch(encoder, 'FBuildFeedbackHashTableCS', 'indirect');
          dispatch(encoder, 'FCompactFeedbackHashTableCS');
          const readback = device.createBuffer({size: 16 + initial.byteLength,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          encoder.copyBufferToBuffer(indirect, 0, readback, 0, 16);
          encoder.copyBufferToBuffer(compacted, 0, readback, 16, initial.byteLength);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = new Uint32Array(readback.getMappedRange());
          check(actual[0] === Math.ceil(count / 64) && actual[1] === 1 && actual[2] === 1,
            'Indirect dispatch dimensions differ');
          check(actual[3] === sentinel, 'Indirect dispatch overwrote its guard');
          const data = actual.subarray(4), written = Math.min(expected.size, capacity - 1), seen = new Set();
          check(data[0] === expected.size && data[1] === sentinel, 'Header count or uint2 layout differs');
          for (let index = 0; index < written; ++index) {
            const id = data[(index + 1) * 2], packed = data[(index + 1) * 2 + 1];
            check(expected.has(id) && !seen.has(id), 'Compaction produced an invalid or duplicate element');
            check((packed >>> 16) === expected.get(id), 'Feedback occurrence count differs');
            check((packed & 65535) === (stride === 2 ? id * 3 : 0), 'Feedback payload differs');
            seen.add(id);
          }
          check(Array.from(data.subarray((written + 1) * 2)).every(value => value === sentinel),
            'Compaction overwrote unused capacity or overflow guards');
          results.push({stride, inputCount: count, capacity, uniqueElements: expected.size,
            written, indirectDispatch: Array.from(actual.subarray(0, 3)), countsPayloadAndGuardsVerified: true});
          readback.unmap(); readback.destroy();
          resources.forEach(resource => resource.destroy());
        }
      }
      await device.queue.onSubmittedWorkDone();
      const validation = await device.popErrorScope();
      check(!validation && !errors.length, validation?.message || errors.join('\n'));
      device.destroy();
      return results;
    }, jobs);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    await browser?.close();
    report.boundary = 'Actual UE feedback indirect dispatch, hash insertion and compaction with GPU readback. ' +
      'No full Lumen scene, frame rate or peak VRAM acceptance.';
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({pass: report.pass, cases: report.cases.length, failure: report.failure, output}));
  }
})();
