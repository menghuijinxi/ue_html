'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {chromium} = require('playwright');
const option = name => process.argv.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const tag = option('tag') || '20261111';
assert(/^[a-z0-9-]+$/.test(tag));
const report = {date: new Date().toISOString(), pass: false};
(async () => {
  let browser;
  try {
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8765');
    report.gpu = await page.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const width = 16384, height = 4096, layers = 2, sliceBytes = width * height * 4;
      const device = await adapter.requestDevice({requiredFeatures: ['timestamp-query'],
        requiredLimits: {maxTextureDimension2D: width, maxBufferSize: sliceBytes * layers + 256,
          maxStorageBufferBindingSize: sliceBytes}});
      const errors = [];
      device.addEventListener('uncapturederror', event => errors.push(event.error.message));
      const texture = device.createTexture({size: [width, height, layers], format: 'r32uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
      const buffer = device.createBuffer({size: sliceBytes * layers + 256,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
      const query = device.createQuerySet({type: 'timestamp', count: 2});
      const resolved = device.createBuffer({size: 256, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC});
      const readback = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      const noop = device.createComputePipeline({layout: 'auto', compute: {
        module: device.createShaderModule({code: '@compute @workgroup_size(1) fn main() {}'}), entryPoint: 'main'}});
      const variants = [];
      for (const [wx, wy, repeat] of [[8,8,1], [16,16,1], [32,8,1], [64,4,1], [128,1,1], [32,8,4]]) {
        const pipelines = [], groups = [];
        for (const toTexture of [false, true]) {
          const code = toTexture ? `
@group(0) @binding(0) var image: texture_storage_2d<r32uint, write>;
@group(0) @binding(1) var<storage, read> data: array<u32>;
@compute @workgroup_size(${wx},${wy}) fn main(@builtin(global_invocation_id) id: vec3u) {
 let size = textureDimensions(image); let pitch = (size.x + 63u) & ~63u;
 for(var row=0u; row<${repeat}u; row++) {
  let p = vec2u(id.x, id.y * ${repeat}u + row);
  if(all(p<size)) { textureStore(image, p, vec4u(data[p.y*pitch+p.x],0u,0u,0u)); }
 }
}` : `
@group(0) @binding(0) var image: texture_2d<u32>;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@compute @workgroup_size(${wx},${wy}) fn main(@builtin(global_invocation_id) id: vec3u) {
 let size = textureDimensions(image); let pitch = (size.x + 63u) & ~63u;
 for(var row=0u; row<${repeat}u; row++) {
  let p = vec2u(id.x, id.y * ${repeat}u + row);
  if(all(p<size)) { data[p.y*pitch+p.x] = textureLoad(image, p, 0).x; }
 }
}`;
          const pipeline = await device.createComputePipelineAsync({layout: 'auto',
            compute: {module: device.createShaderModule({code}), entryPoint: 'main'}});
          pipelines.push(pipeline);
          groups.push(Array.from({length: layers}, (_, layer) => device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0), entries: [
              {binding: 0, resource: texture.createView({dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1})},
              {binding: 1, resource: {buffer, offset: 256 + layer * sliceBytes, size: sliceBytes}}
            ]})));
        }
        variants.push({name: `${wx}x${wy}x${repeat}`, wx, wy, repeat, pipelines, groups});
      }
      const results = [];
      async function sample(variant, toTexture, measured) {
        const encoder = device.createCommandEncoder();
        const begin = encoder.beginComputePass({timestampWrites: {
          querySet: query, beginningOfPassWriteIndex: 0}});
        begin.setPipeline(noop); begin.dispatchWorkgroups(1); begin.end();
        for (let layer = 0; layer < layers; ++layer) {
          if (variant) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(variant.pipelines[+toTexture]);
            pass.setBindGroup(0, variant.groups[+toTexture][layer]);
            pass.dispatchWorkgroups(Math.ceil(width / variant.wx), Math.ceil(height / (variant.wy * variant.repeat)));
            pass.end();
          } else {
            const image = {texture, origin: [0,0,layer]};
            const data = {buffer, offset: 256 + layer * sliceBytes, bytesPerRow: width * 4, rowsPerImage: height};
            if (toTexture) encoder.copyBufferToTexture(data, image, [width,height]);
            else encoder.copyTextureToBuffer(image, data, [width,height]);
          }
        }
        const end = encoder.beginComputePass({timestampWrites: {querySet: query, endOfPassWriteIndex: 1}});
        end.setPipeline(noop); end.dispatchWorkgroups(1); end.end();
        encoder.resolveQuerySet(query, 0, 2, resolved, 0);
        encoder.copyBufferToBuffer(resolved, 0, readback, 0, 16);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const times = new BigUint64Array(readback.getMappedRange(), 0, 2);
        const milliseconds = Number(times[1]-times[0]) / 1e6;
        readback.unmap();
        if (measured) results.push({variant: variant?.name || 'copy-command', toTexture, milliseconds});
      }
      // Interleave the baseline and candidates so frequency/temperature drift is shared.
      for (let round = 0; round < 7; ++round) for (const variant of [null, ...variants]) {
        await sample(variant, false, round > 1);
        await sample(variant, true, round > 1);
      }
      await device.queue.onSubmittedWorkDone();
      device.destroy();
      return {adapter: {...adapter.info}, width, height, layers, results, errors};
    });
    assert.deepEqual(report.gpu.errors, []);
    report.summary = [];
    for (const name of new Set(report.gpu.results.map(x => x.variant))) {
      const entry = {variant: name};
      for (const toTexture of [false,true]) {
        const times = report.gpu.results.filter(x=>x.variant===name && x.toTexture===toTexture).map(x=>x.milliseconds).sort((a,b)=>a-b);
        entry[toTexture ? 'bufferToTextureMs' : 'textureToBufferMs'] = times[Math.floor(times.length/2)];
      }
      report.summary.push(entry);
    }
    report.pass = true;
  } catch (error) { report.error = error.stack; process.exitCode = 1; }
  finally {
    await browser?.close();
    fs.writeFileSync(path.join(__dirname, 'results/atomic-copy-' + tag + '.json'), JSON.stringify(report,null,2));
    console.log(JSON.stringify({pass:report.pass,summary:report.summary,error:report.error,gpuErrors:report.gpu?.errors},null,2));
  }
})();
