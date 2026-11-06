'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputs = (argument('input') || '').split(',').filter(Boolean).map(value => path.resolve(value));
assert(inputs.length, '--input requires one or more ShaderConversion directories, oldest first');
const output = path.resolve(argument('output') || path.join(__dirname, 'results/web-virtual-resource-gpu.json'));
const selected = new Map();
for (const directory of inputs) {
  for (const name of fs.readdirSync(directory)) {
    const json = path.join(directory, name, 'input.json'), wgsl = path.join(directory, name, 'output.wgsl');
    if (!fs.existsSync(json) || !fs.existsSync(wgsl) ||
        fs.existsSync(path.join(directory, name, 'failure.json'))) continue;
    const input = JSON.parse(fs.readFileSync(json, 'utf8'));
    selected.set(input.shader, {name: input.shaderName, key: input.shader,
      metadata: input.metadata, code: fs.readFileSync(wgsl, 'utf8'), sources: [audit(json), audit(wgsl)]});
  }
}
const jobs = [...selected.values()];
assert(jobs.length, 'No converted virtual-resource shaders');
const report = {date: new Date().toISOString(), pass: false, completeVirtualResourceScene: false,
  sources: [audit(__filename)], modules: [], pipelines: [], pageTableCases: []};
(async () => {
  let browser;
  try {
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/virtual-resource-validation',
      route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Virtual resources</title>'}));
    await page.goto('http://127.0.0.1:8765/virtual-resource-validation');
    const initialize = () => page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const features = ['texture-formats-tier1', 'texture-formats-tier2', 'subgroups']
        .filter(name => adapter.features.has(name));
      const requiredLimits = Object.fromEntries(Object.entries({
        maxStorageBuffersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 8,
        maxSampledTexturesPerShaderStage: 32, maxSamplersPerShaderStage: 16,
        maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024,
        maxComputeWorkgroupSizeY: 1024, maxComputeWorkgroupStorageSize: 32768,
      }).map(([name, value]) => [name, Math.min(value, adapter.limits[name])]));
      globalThis.virtualResourceDevice = await adapter.requestDevice({requiredFeatures: features, requiredLimits});
      globalThis.virtualResourceErrors = [];
      virtualResourceDevice.addEventListener('uncapturederror', event => virtualResourceErrors.push(event.error.message));
      return {features, limits: requiredLimits};
    });
    report.device = await initialize();
    for (const job of jobs) {
      if (report.modules.length && report.modules.length % 48 === 0) {
        const errors = await page.evaluate(async () => {
          await virtualResourceDevice.queue.onSubmittedWorkDone();
          virtualResourceDevice.destroy();
          return virtualResourceErrors;
        });
        assert(!errors.length, errors.join('\n'));
        await initialize();
        console.log(`Virtual-resource GPU validation: ${report.modules.length}/${jobs.length}`);
      }
      report.lastJob = job.key;
      const result = await page.evaluate(async job => {
        const device = virtualResourceDevice;
        device.pushErrorScope('validation');
        const module = device.createShaderModule({code: job.code});
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter(message => message.type === 'error').map(message => message.message);
        if (!errors.length && job.metadata.frequency === 5) {
          try {
            await device.createComputePipelineAsync({
              layout: 'auto', compute: {module, entryPoint: job.metadata.webEntry}});
          } catch (error) { errors.push(error.message); }
        }
        const validation = await device.popErrorScope();
        if (validation) errors.push(validation.message);
        return errors;
      }, job);
      report.modules.push({key: job.key, sources: job.sources, errors: result});
      if (job.metadata.frequency === 5) report.pipelines.push({key: job.key, errors: result});
    }
    const shaders = {};
    for (const [key, name] of Object.entries({small: 'TPageTableUpdateVS<true>',
      large: 'TPageTableUpdateVS<false>', pixel: 'TPageTableUpdatePS<PF_R32_UINT>'})) {
      shaders[key] = jobs.find(job => job.name === name);
      assert(shaders[key], `Missing actual UE shader ${name}`);
    }
    report.pageTableCases = await page.evaluate(async shaders => {
      const device = virtualResourceDevice, cases = [];
      const makeBuffer = (data, usage) => {
        const buffer = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const morton = (x, y) => {
        let result = 0;
        for (let bit = 0; bit < 16; ++bit)
          result |= ((x >>> bit) & 1) << (bit * 2) | ((y >>> bit) & 1) << (bit * 2 + 1);
        return result >>> 0;
      };
      const indices = new Uint16Array(Array.from({length: 8},
        (_, quad) => [0, 1, 2, 2, 1, 3].map(index => quad * 4 + index)).flat());
      const indexBuffer = makeBuffer(indices, GPUBufferUsage.INDEX);
      for (const coordinateBits of [6, 8]) {
        const vertex = coordinateBits === 6 ? shaders.small : shaders.large;
        const pipeline = await device.createRenderPipelineAsync({
          layout: 'auto', primitive: {topology: 'triangle-list', cullMode: 'none'},
          vertex: {module: device.createShaderModule({code: vertex.code}), entryPoint: vertex.metadata.webEntry},
          fragment: {module: device.createShaderModule({code: shaders.pixel.code}),
            entryPoint: shaders.pixel.metadata.webEntry, targets: [{format: 'r32uint'}]},
        });
        for (const firstUpdate of [0, 3]) {
          const width = 32, height = 16, bytesPerRow = 256;
          // Include more than one eight-quad instance and leave unused tail quads.
          const updates = Array.from({length: 11}, (_, index) => ({
            x: index % 6 * 5, y: Math.floor(index / 6) * 7,
            logSize: index % 3, level: index % 8,
            px: (index * 17 + 3) % (1 << coordinateBits),
            py: (index * 23 + 5) % (1 << coordinateBits),
          }));
          const packed = new Uint16Array((firstUpdate + updates.length) * 4);
          packed.fill(0xffff);
          const expected = new Uint32Array(width * height);
          updates.forEach((update, index) => {
            const address = morton(update.x, update.y), offset = (firstUpdate + index) * 4;
            packed.set([address & 0xffff, address >>> 16, update.px | update.py << 8,
              update.level | update.logSize << 8], offset);
            const value = update.level | update.px << 4 | update.py << (4 + coordinateBits);
            for (let y = update.y; y < update.y + (1 << update.logSize); ++y)
              for (let x = update.x; x < update.x + (1 << update.logSize); ++x) expected[y * width + x] = value;
          });
          const uniform = makeBuffer(new Uint32Array([width, height, firstUpdate, updates.length]), GPUBufferUsage.UNIFORM);
          const data = makeBuffer(packed, GPUBufferUsage.STORAGE);
          const bindings = vertex.metadata.spirvBindings.map(binding => ({
            binding: binding.binding, resource: {buffer: binding.name === '$Globals' ? uniform : data},
          }));
          const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: bindings});
          const texture = device.createTexture({size: [width, height], format: 'r32uint',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
          const readback = device.createBuffer({size: bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({colorAttachments: [{view: texture.createView(),
            loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.setIndexBuffer(indexBuffer, 'uint16');
          pass.drawIndexed(indices.length, Math.ceil(updates.length / 8));
          pass.end();
          encoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow}, [width, height]);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = new Uint32Array(readback.getMappedRange());
          let mismatches = 0;
          for (let y = 0; y < height; ++y)
            for (let x = 0; x < width; ++x)
              if (actual[y * bytesPerRow / 4 + x] !== expected[y * width + x]) ++mismatches;
          cases.push({coordinateBits, firstUpdate, updates: updates.length,
            checkedTexels: expected.length, mismatches, pass: mismatches === 0});
          readback.unmap();
          for (const resource of [uniform, data, texture, readback]) resource.destroy();
        }
      }
      indexBuffer.destroy();
      await device.queue.onSubmittedWorkDone();
      return cases;
    }, shaders);
    report.errors = await page.evaluate(() => virtualResourceErrors);
    assert(report.modules.every(result => !result.errors.length), 'Browser shader/pipeline validation failed');
    assert(report.pageTableCases.every(result => result.pass), 'Actual UE virtual-texture page-table readback failed');
    assert(!report.errors.length, 'WebGPU reported uncaptured errors');
    report.pass = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, modules: report.modules.length,
      pipelines: report.pipelines.length, pageTableCases: report.pageTableCases,
      failures: report.modules.filter(result => result.errors.length).map(result => ({key: result.key, errors: result.errors})),
      failure: report.failure, output}, null, 2));
  }
})();
