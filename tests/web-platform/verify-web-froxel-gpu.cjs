'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const input = process.argv.find(value => value.startsWith('--input='))?.slice(8);
assert(input, '--input requires the converted FHZBBuildCS permutation 5 directory');
const metadataFile = path.resolve(input, 'input.json');
const shaderFile = path.resolve(input, 'output.wgsl');
const shader = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
assert.equal(shader.shaderName, 'FHZBBuildCS');
const code = fs.readFileSync(shaderFile, 'utf8');
const report = {date: new Date().toISOString(), pass: false,
  sources: [__filename, metadataFile, shaderFile].map(audit), cases: []};
(async () => {
  let browser;
  try {
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/froxel-validation',
      route => route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Froxel validation</title>'}));
    await page.goto('http://127.0.0.1:8765/froxel-validation');
    report.cases = await page.evaluate(async ({code, metadata}) => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const device = await adapter.requestDevice({
        requiredFeatures: ['float32-filterable', 'texture-formats-tier1', 'subgroups']});
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const module = device.createShaderModule({code});
      const info = await module.getCompilationInfo();
      const failures = info.messages.filter(item => item.type === 'error');
      if (failures.length) throw new Error(JSON.stringify(failures));
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: {module, entryPoint: metadata.webEntry}});
      const globals = metadata.spirvBindings.find(item => item.name === '$Globals');
      const makeBuffer = (data, usage) => {
        const buffer = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
      };
      const results = [];
      for (const name of ['duplicate', 'collisions', 'negative', 'infinite-depth', 'partial-viewport']) {
        const width = 32, height = 16;
        const viewport = name === 'partial-viewport' ? [25, 11] : [width, height];
        const pixels = new Float32Array(width * height);
        for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
          pixels[y * width + x] = name === 'infinite-depth' ? 0 : name === 'duplicate' ? 42.25 :
            name === 'negative' ? ((x + y) % 7) - 4.75 : (y * width + x) * 128 + 0.25;
        }
        const values = {
          DispatchThreadIdToBufferUV: [2 / width, 2 / height, 0, 0],
          InvSize: [1 / width, 1 / height],
          InputViewportMaxBound: [viewport[0] / width, viewport[1] / height],
          PixelViewPortMinMax: [0, 0, ...viewport],
          FroxelRecLog2DepthScale1: [1], FroxelRecNearScale: [1], FroxelNear: [0],
          FroxelClipToViewTransformScale: [1], FroxelClipToViewTransformBias: [0],
          FroxelInvRadius: [1], bFroxelIsOrtho: [name === 'infinite-depth' ? 0 : 1],
          FroxelArgsStride: [4], FroxelArgsOffset: [1],
        };
        const bytes = new ArrayBuffer(globals.paddedSize), view = new DataView(bytes);
        for (const field of globals.members) {
          const array = values[field.name];
          if (!array) throw new Error('Unhandled uniform: ' + field.name);
          const integer = /^(PixelViewPortMinMax|bFroxelIsOrtho|FroxelArgs)/.test(field.name);
          array.forEach((value, index) => view[integer ? 'setUint32' : 'setFloat32'](
            field.offset + index * 4, value, true));
        }
        const uniform = makeBuffer(bytes, GPUBufferUsage.UNIFORM);
        const froxels = makeBuffer(new Uint32Array(width * height * 2).fill(0xdeadbeef),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const args = makeBuffer(new Uint32Array([19, 23, 29, 31, 0, 1, 1, 0]),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const source = device.createTexture({size: [width, height], format: 'r32float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
        device.queue.writeTexture({texture: source}, pixels, {bytesPerRow: width * 4}, [width, height]);
        const hzb = device.createTexture({size: [width / 2, height / 2], format: 'r32float',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC});
        const resources = {$Globals: {buffer: uniform}, OutFroxels: {buffer: froxels},
          OutFroxelArgs: {buffer: args}, ParentTextureMip: source.createView(),
          ParentTextureMipSampler: device.createSampler(), FurthestHZBOutput_0: hzb.createView()};
        const bindGroup = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
          entries: metadata.spirvBindings.map(item => ({binding: item.binding, resource: resources[item.name]}))});
        const hzbOffset = froxels.size + args.size;
        const readback = device.createBuffer({size: hzbOffset + (height / 2) * 256,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(width / 16, height / 16); pass.end();
        encoder.copyBufferToBuffer(froxels, 0, readback, 0, froxels.size);
        encoder.copyBufferToBuffer(args, 0, readback, froxels.size, args.size);
        encoder.copyTextureToBuffer({texture: hzb}, {buffer: readback, offset: hzbOffset, bytesPerRow: 256},
          [width / 2, height / 2]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new DataView(readback.getMappedRange());
        const count = result.getUint32(froxels.size + 28, true);
        const dispatchCount = result.getUint32(froxels.size + 16, true);
        const expected = new Set(), actual = new Set();
        let hzbMismatches = 0, untouchedMismatches = 0;
        for (let y = 0; y < height / 2; ++y) for (let x = 0; x < width / 2; ++x) {
          const sx = Math.min(x * 2, viewport[0] - 2), sy = Math.min(y * 2, viewport[1] - 2);
          const samples = [pixels[sy * width + sx], pixels[sy * width + sx + 1],
            pixels[(sy + 1) * width + sx], pixels[(sy + 1) * width + sx + 1]];
          if (result.getFloat32(hzbOffset + y * 256 + x * 4, true) !== Math.min(...samples)) ++hzbMismatches;
          if (name !== 'infinite-depth' && Math.floor(x / 8) * 16 < viewport[0] &&
              Math.floor(y / 8) * 16 < viewport[1])
            for (const depth of samples) expected.add(`${Math.floor(x / 4)},${Math.floor(y / 4)},${Math.floor(depth)}`);
        }
        for (let index = 0; index < Math.min(count, width * height); ++index) {
          const xy = result.getUint32(index * 8, true), z = result.getInt32(index * 8 + 4, true);
          actual.add(`${xy & 0xffff},${xy >>> 16},${z}`);
        }
        for (let offset = count * 8; offset < froxels.size; offset += 4)
          if (result.getUint32(offset, true) !== 0xdeadbeef) ++untouchedMismatches;
        const prefix = Array.from({length: 4}, (_, i) => result.getUint32(froxels.size + i * 4, true));
        const missing = [...expected].filter(key => !actual.has(key));
        const extra = [...actual].filter(key => !expected.has(key));
        results.push({name, count, expectedCount: expected.size, uniqueCount: actual.size,
          dispatchCount, missing: missing.slice(0, 8), extra: extra.slice(0, 8),
          hzbMismatches, untouchedMismatches, prefix,
          pass: count === expected.size && actual.size === count && !missing.length && !extra.length &&
            dispatchCount === Math.ceil(count / 64) && !hzbMismatches && !untouchedMismatches &&
            prefix.join(',') === '19,23,29,31'});
        readback.unmap();
        for (const resource of [uniform, froxels, args, source, hzb, readback]) resource.destroy();
      }
      await device.queue.onSubmittedWorkDone();
      if (errors.length) throw new Error(errors.join('\n'));
      device.destroy();
      return results;
    }, {code, metadata: shader.metadata});
    assert(report.cases.every(item => item.pass), JSON.stringify(report.cases));
    report.pass = true;
  } catch (error) {
    report.failure = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    const output = path.join(__dirname, 'results/web-froxel-gpu.json');
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
})();
