const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const output = path.join(__dirname, 'results/nanite-lumen-webgpu-capabilities.json');
const report = {
  date: new Date().toISOString(),
  pass: false,
  source: {
    file: __filename,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  },
  boundary: 'Standalone browser API and synthetic compute probes. Does not run UE, port Nanite/Lumen, measure performance, or establish cross-GPU support. No additional browser flags.',
  browsers: [],
};

async function probe() {
  const adapter = await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('No WebGPU adapter');
  const limitNames = [
    'maxBufferSize', 'maxStorageBufferBindingSize', 'maxStorageBuffersPerShaderStage',
    'maxStorageTexturesPerShaderStage', 'maxSampledTexturesPerShaderStage',
    'maxSamplersPerShaderStage', 'maxBindGroups', 'maxBindingsPerBindGroup',
    'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupStorageSize',
    'maxTextureDimension2D', 'maxTextureDimension3D',
  ];
  const limits = value => Object.fromEntries(limitNames.map(name => [name, value[name]]));
  const info = adapter.info;
  const result = {
    adapter: {
      vendor: info.vendor, architecture: info.architecture, device: info.device,
      description: info.description, isFallbackAdapter: info.isFallbackAdapter,
      subgroupMinSize: info.subgroupMinSize, subgroupMaxSize: info.subgroupMaxSize,
    },
    adapterFeatures: [...adapter.features].sort(),
    languageFeatures: [...navigator.gpu.wgslLanguageFeatures].sort(),
    adapterLimits: limits(adapter.limits),
    checks: [],
    unexpectedErrors: [],
  };
  const check = (name, pass, details = {}) => {
    result.checks.push({name, pass, ...details});
    if (!pass) throw new Error(`Failed: ${name}`);
  };
  const defaultAdapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  const defaultDevice = await defaultAdapter.requestDevice();
  result.defaultDeviceLimits = limits(defaultDevice.limits);
  defaultDevice.destroy();
  const candidates = [
    'subgroups', 'subgroup-size-control', 'texture-formats-tier1', 'texture-formats-tier2',
    'atomic-vec2u-min-max',
  ];
  result.requestedFeatures = candidates.filter(name => adapter.features.has(name));
  const requiredLimits = Object.fromEntries([
    'maxStorageBuffersPerShaderStage', 'maxStorageTexturesPerShaderStage',
    'maxSampledTexturesPerShaderStage', 'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupStorageSize',
  ].map(name => [name, adapter.limits[name]]));
  const device = await adapter.requestDevice({requiredFeatures: result.requestedFeatures, requiredLimits});
  result.deviceLimits = limits(device.limits);
  result.deviceFeatures = [...device.features].sort();
  device.addEventListener('uncapturederror', event => result.unexpectedErrors.push(event.error.message));
  const resources = [];
  const buffer = (size, usage) => {
    const value = device.createBuffer({size, usage});
    resources.push(value);
    return value;
  };
  const read = async (source, bytes) => {
    const staging = buffer(bytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return values;
  };
  const compile = async (name, code) => {
    device.pushErrorScope('validation');
    let exception;
    let messages = [];
    try {
      const module = device.createShaderModule({label: name, code});
      messages = (await module.getCompilationInfo()).messages
        .filter(message => message.type === 'error').map(message => message.message);
      if (!messages.length)
        await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint: 'main'}});
    } catch (error) {
      exception = String(error);
    }
    const validation = await device.popErrorScope();
    return {name, accepted: !messages.length && !exception && !validation,
      messages, exception, validation: validation?.message};
  };
  const bind = (pipeline, buffers) => device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: buffers.map((value, binding) => ({binding, resource: {buffer: value}})),
  });
  try {
    result.shaderProbes = [];
    result.shaderProbes.push(await compile('general-u64-atomic', `
      @group(0) @binding(0) var<storage, read_write> words: array<atomic<u64>>;
      @compute @workgroup_size(1) fn main() { atomicMax(&words[0], 1); }
    `));
    result.shaderProbes.push(await compile('packed-vec2u-atomic', `
      requires atomic_vec2u_min_max;
      @group(0) @binding(0) var<storage, read_write> words: array<atomic<vec2<u32>>>;
      @compute @workgroup_size(1) fn main() { atomicStoreMax(&words[0], vec2<u32>(1, 2)); }
    `));
    result.shaderProbes.push(await compile('r32uint-texture-atomic-builtin', `
      @group(0) @binding(0) var words: texture_storage_2d<r32uint, read_write>;
      @compute @workgroup_size(1) fn main() { textureAtomicAdd(words, vec2<u32>(0), 1u); }
    `));
    device.pushErrorScope('validation');
    let r64Exception;
    try {
      const texture = device.createTexture({size: [1, 1], format: 'r64uint',
        usage: GPUTextureUsage.STORAGE_BINDING});
      resources.push(texture);
    } catch (error) {
      r64Exception = String(error);
    }
    const r64Validation = await device.popErrorScope();
    result.r64uintTexture = {accepted: !r64Exception && !r64Validation,
      exception: r64Exception, validation: r64Validation?.message};

    if (device.features.has('subgroups')) {
      const module = device.createShaderModule({code: `
        enable subgroups;
        @group(0) @binding(0) var<storage, read_write> output: array<u32>;
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>,
                @builtin(subgroup_size) size: u32,
                @builtin(subgroup_invocation_id) lane: u32) {
          output[id.x * 4u] = size;
          output[id.x * 4u + 1u] = subgroupAdd(1u);
          output[id.x * 4u + 2u] = select(0u, 1u, subgroupExclusiveAdd(1u) == lane);
          output[id.x * 4u + 3u] = subgroupBroadcastFirst(lane);
        }
      `});
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: {module, entryPoint: 'main'},
      });
      const data = buffer(1024, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind(pipeline, [data]));
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const values = await read(data, 1024);
      check('subgroup-reduction-prefix-broadcast', Array.from({length: 64}, (_, index) =>
        values[index * 4] === values[index * 4 + 1] &&
        values[index * 4 + 2] === 1 && values[index * 4 + 3] === 0).every(Boolean),
      {verifiedInvocations: 64, subgroupSizes: [...new Set(values.filter((_, index) => index % 4 === 0))]});
    }

    if (device.features.has('texture-formats-tier1')) {
      const texture = device.createTexture({size: [1, 1], format: 'r16uint',
        usage: GPUTextureUsage.STORAGE_BINDING});
      resources.push(texture);
      const module = device.createShaderModule({code: `
        @group(0) @binding(0) var image: texture_storage_2d<r16uint, read_write>;
        @group(0) @binding(1) var<storage, read_write> output: array<u32>;
        @compute @workgroup_size(1) fn main() {
          textureStore(image, vec2<u32>(0), vec4<u32>(65534u, 0u, 0u, 0u));
          textureBarrier();
          output[0] = textureLoad(image, vec2<u32>(0)).x + 1u;
        }
      `});
      const pipeline = await device.createComputePipelineAsync({
        layout: 'auto', compute: {module, entryPoint: 'main'},
      });
      const data = buffer(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: [
        {binding: 0, resource: texture.createView()}, {binding: 1, resource: {buffer: data}},
      ]});
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const values = await read(data, 4);
      check('r16uint-storage-read-write', values[0] === 65535, {actual: values[0]});
    }

    const count = 8192;
    const pixels = 128;
    const module = device.createShaderModule({code: `
      struct Candidate { pixel: u32, depth: u32, id: u32, unused: u32 }
      @group(0) @binding(0) var<storage, read> input: array<Candidate>;
      @group(0) @binding(1) var<storage, read_write> winners: array<atomic<u32>>;
      @compute @workgroup_size(64) fn pick_depth(@builtin(global_invocation_id) invocation: vec3<u32>) {
        let candidate = input[invocation.x];
        atomicMax(&winners[candidate.pixel * 2u], candidate.depth);
      }
      @compute @workgroup_size(64) fn pick_id(@builtin(global_invocation_id) invocation: vec3<u32>) {
        let candidate = input[invocation.x];
        if (candidate.depth == atomicLoad(&winners[candidate.pixel * 2u])) {
          atomicMax(&winners[candidate.pixel * 2u + 1u], candidate.id);
        }
      }
    `});
    const pipelines = [];
    for (const entryPoint of ['pick_depth', 'pick_id'])
      pipelines.push(await device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint}}));
    for (const seed of [1, 12345, 0xdeadbeef]) {
      let state = seed >>> 0;
      const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
      };
      const input = new Uint32Array(count * 4);
      const expected = Array(pixels).fill(0n);
      for (let index = 0; index < count; index++) {
        const pixel = random() % pixels;
        const depth = 1 + random() % 64;
        const id = random();
        input.set([pixel, depth, id, 0], index * 4);
        const packed = BigInt(depth) << 32n | BigInt(id);
        if (packed > expected[pixel]) expected[pixel] = packed;
      }
      const source = buffer(input.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      device.queue.writeBuffer(source, 0, input);
      const winners = buffer(pixels * 8, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
      const encoder = device.createCommandEncoder();
      for (const pipeline of pipelines) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bind(pipeline, [source, winners]));
        pass.dispatchWorkgroups(count / 64);
        pass.end();
      }
      device.queue.submit([encoder.finish()]);
      const values = await read(winners, pixels * 8);
      check(`two-pass-depth-id-seed-${seed}`, expected.every((value, index) =>
        (BigInt(values[index * 2]) << 32n | BigInt(values[index * 2 + 1])) === value),
      {candidates: count, pixels, reference: 'CPU BigInt unsigned packed 64-bit maximum, including equal-depth ID ties'});
    }
    await device.queue.onSubmittedWorkDone();
    check('no-unexpected-validation-errors', result.unexpectedErrors.length === 0);
    result.pass = true;
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
  return result;
}

(async () => {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  try {
    for (const channel of ['chrome', 'msedge']) {
      const browser = await chromium.launch({channel, headless: true, timeout: 30000});
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(30000);
        await page.route('http://localhost/webgpu-feasibility', route => route.fulfill({
          contentType: 'text/html', body: '<!doctype html><title>WebGPU feasibility probe</title>',
        }));
        await page.goto('http://localhost/webgpu-feasibility');
        const result = await Promise.race([
          page.evaluate(probe),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('GPU probe exceeded 45 seconds')), 45000);
            timer.unref();
          }),
        ]);
        assert(result.pass);
        report.browsers.push({channel, version: browser.version(), ...result});
        console.log(`${channel} ${browser.version()}: ${result.checks.length} checks passed; ` +
          result.shaderProbes.map(item => `${item.name}=${item.accepted}`).join(', '));
      } finally {
        await browser.close();
      }
    }
    report.pass = report.browsers.length === 2 && report.browsers.every(browser => browser.pass);
  } catch (error) {
    report.failure = error.stack || String(error);
    process.exitCode = 1;
    console.error(report.failure);
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(output);
  }
})();
