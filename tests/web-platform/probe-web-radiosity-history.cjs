'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const output = path.join(__dirname, 'results/lumen-radiosity-history-gpu.json');
const report = {date: new Date().toISOString(), pass: false, completeLumenScene: false,
  sourceFiles: [audit(__filename)], cases: []};
(async () => {
  let browser;
  try {
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/radiosity-history', route =>
      route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Radiosity history probe</title>'}));
    await page.goto('http://127.0.0.1:8765/radiosity-history');
    Object.assign(report, await page.evaluate(async () => {
      const check = (value, message) => { if (!value) throw Error(message); };
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const features = ['texture-formats-tier1', 'texture-formats-tier2', 'timestamp-query']
        .filter(name => adapter.features.has(name));
      const device = await adapter.requestDevice({requiredFeatures: features});
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      device.pushErrorScope('validation');
      const module = device.createShaderModule({code: `
        @group(0) @binding(0) var history: texture_2d<f32>;
        @group(0) @binding(1) var current: texture_storage_2d<rg11b10ufloat, write>;
        @group(0) @binding(2) var frames: texture_storage_2d<r8unorm, read_write>;
        var<workgroup> accumulated: f32;
        @compute @workgroup_size(8, 8)
        fn main(@builtin(global_invocation_id) texel: vec3u,
                @builtin(workgroup_id) tile: vec3u, @builtin(local_invocation_index) thread: u32) {
          if (thread == 0u) {
            accumulated = min(round(textureLoad(frames, tile.xy).x * 255.0) + 1.0, 4.0);
            textureStore(frames, tile.xy, vec4f(accumulated / 255.0));
          }
          workgroupBarrier();
          let radiance = mix(textureLoad(history, texel.xy, 0).rgb,
            vec3f(1.0, 0.5, 0.25), 1.0 / (1.0 + accumulated));
          textureStore(current, texel.xy, vec4f(radiance, 1.0));
        }`});
      const pipeline = await device.createComputePipelineAsync({layout: 'auto',
        compute: {module, entryPoint: 'main'}});
      const cases = [];
      const unpack = packed => [packed & 2047, (packed >>> 11) & 2047, packed >>> 22]
        .map((value, channel) => {
          const mantissaBits = channel === 2 ? 5 : 6;
          const exponent = value >>> mantissaBits, mantissa = value & ((1 << mantissaBits) - 1);
          return exponent ? (1 + mantissa / (1 << mantissaBits)) * 2 ** (exponent - 15) :
            mantissa * 2 ** (-14 - mantissaBits);
        });
      for (const size of [64, 4096]) {
        const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
        const current = device.createTexture({size: [size, size], format: 'rg11b10ufloat', usage});
        const history = device.createTexture({size: [size, size], format: 'rg11b10ufloat', usage});
        const frames = device.createTexture({size: [size / 8, size / 8], format: 'r8unorm', usage});
        const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
          {binding: 0, resource: history.createView()}, {binding: 1, resource: current.createView()},
          {binding: 2, resource: frames.createView()},
        ]});
        const timestamped = features.includes('timestamp-query');
        const query = timestamped ? device.createQuerySet({type: 'timestamp', count: 4}) : null;
        const resolved = timestamped ? device.createBuffer({size: 32,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC}) : null;
        const readback = device.createBuffer({size: 1024,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const measurements = [], verified = [];
        let previous = [0, 0, 0];
        for (let frame = 0; frame < 12; ++frame) {
          const encoder = device.createCommandEncoder();
          if (timestamped)
            encoder.beginComputePass({timestampWrites: {querySet: query, endOfPassWriteIndex: 0}}).end();
          encoder.copyTextureToTexture({texture: current}, {texture: history}, [size, size]);
          if (timestamped)
            encoder.beginComputePass({timestampWrites: {querySet: query, beginningOfPassWriteIndex: 1}}).end();
          const pass = encoder.beginComputePass(timestamped ? {timestampWrites: {
            querySet: query, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3}} : {});
          pass.setPipeline(pipeline); pass.setBindGroup(0, group);
          pass.dispatchWorkgroups(size / 8, size / 8); pass.end();
          for (const [index, coordinate] of [[0, 0], [1, size - 1]]) {
            encoder.copyTextureToBuffer({texture: current, origin: [coordinate, coordinate]},
              {buffer: readback, offset: index * 256, bytesPerRow: 256}, [1, 1]);
            encoder.copyTextureToBuffer({texture: frames,
              origin: [Math.floor(coordinate / 8), Math.floor(coordinate / 8)]},
            {buffer: readback, offset: 512 + index * 256, bytesPerRow: 256}, [1, 1]);
          }
          if (timestamped) {
            encoder.resolveQuerySet(query, 0, 4, resolved, 0);
            encoder.copyBufferToBuffer(resolved, 0, readback, 64, 32);
          }
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const bytes = readback.getMappedRange(), view = new DataView(bytes);
          const count = Math.min(frame + 1, 4), alpha = 1 / (1 + count);
          const expected = previous.map((value, channel) =>
            value * (1 - alpha) + [1, 0.5, 0.25][channel] * alpha);
          let next;
          for (let index = 0; index < 2; ++index) {
            const actual = unpack(view.getUint32(index * 256, true));
            check(view.getUint8(512 + index * 256) === count, 'Temporal counter differs');
            check(actual.every((value, channel) => Math.abs(value - expected[channel]) <=
              2 ** (Math.floor(Math.log2(expected[channel])) - (channel === 2 ? 5 : 6)) + 1e-6),
            `History accumulation differs at frame ${frame}: ${actual} vs ${expected}`);
            if (index === 0) {
              next = actual;
              verified.push({frame: frame + 1, count, actual, expected});
            } else check(actual.every((value, channel) => value === next[channel]), 'Atlas edge differs');
          }
          // The next frame reads the already quantized packed-HDR result.
          previous = next;
          if (timestamped && frame >= 2) {
            const timestamps = new BigUint64Array(bytes, 64, 4);
            measurements.push({copyMilliseconds: Number(timestamps[1] - timestamps[0]) / 1e6,
              fixtureIntegrateMilliseconds: Number(timestamps[3] - timestamps[2]) / 1e6});
          }
          readback.unmap();
        }
        await device.queue.onSubmittedWorkDone();
        const mean = name => measurements.length ?
          measurements.reduce((sum, item) => sum + item[name], 0) / measurements.length : null;
        cases.push({size, frames: 12, verified, historyBytes: size * size * 4,
          measurements, meanCopyMilliseconds: mean('copyMilliseconds'),
          meanFixtureIntegrateMilliseconds: mean('fixtureIntegrateMilliseconds')});
        [current, history, frames, readback, resolved, query].filter(Boolean).forEach(value => value.destroy());
      }
      const validation = await device.popErrorScope();
      check(!validation, validation?.message); check(!errors.length, errors.join('\n'));
      const {vendor, architecture, device: model, description} = adapter.info;
      return {features, adapter: {vendor, architecture, device: model, description}, cases, errors};
    }));
    assert.equal(report.cases.length, 2);
    report.pass = true;
  } catch (error) { report.failure = error.stack; process.exitCode = 1; }
  finally {
    await browser?.close();
    report.boundary = 'Standalone WebGPU copy/temporal-blend fixture with packed-HDR readback and R8 counters; ' +
      'not the full UE Radiosity shader. GPU timestamps include empty-pass boundaries. ' +
      'Zero timestamps can mean timer quantization. Fixture integration time and descriptor bytes ' +
      'do not establish scene FPS or peak VRAM.';
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({pass: report.pass, cases: report.cases.map(item => ({
      size: item.size, historyBytes: item.historyBytes, meanCopyMilliseconds: item.meanCopyMilliseconds})),
    failure: report.failure}));
  }
})();
