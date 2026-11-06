const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');

const output = path.join(__dirname, 'results/nanite-visibility-20261106.json');
const packedCode = fs.readFileSync(path.join(__dirname, 'shaders/nanite-packed-visibility-probe.wgsl'), 'utf8');
const report = {
  date: new Date().toISOString(),
  sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  shaderSha256: crypto.createHash('sha256').update(packedCode).digest('hex'),
  boundary: 'Synthetic visibility reduction, not Nanite rasterization, UE shader compilation, streaming, or a performance benchmark. No additional browser flags.',
  browsers: [],
  pass: false,
};

async function probe(packedCode) {
  const adapter = await navigator.gpu?.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw new Error('No WebGPU adapter');
  const feature = 'atomic-vec2u-min-max';
  const packed = adapter.features.has(feature);
  const device = await adapter.requestDevice({requiredFeatures: packed ? [feature] : []});
  const result = {
    adapter: {
      vendor: adapter.info.vendor, architecture: adapter.info.architecture,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
    },
    adapterFeatures: [...adapter.features].sort(),
    languageFeatures: [...navigator.gpu.wgslLanguageFeatures].sort(),
    packedAtomicsAdvertised: packed,
    checks: [],
    unexpectedErrors: [],
  };
  device.addEventListener('uncapturederror', event => result.unexpectedErrors.push(event.error.message));
  const resources = [];
  const makeBuffer = (size, usage, data) => {
    const buffer = device.createBuffer({size, usage});
    resources.push(buffer);
    if (data) device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  const createPipeline = async (code, entryPoint = 'main') => {
    const module = device.createShaderModule({code});
    const errors = (await module.getCompilationInfo()).messages.filter(x => x.type === 'error');
    if (errors.length) throw new Error(errors.map(x => x.message).join('\n'));
    return device.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint}});
  };
  const dispatch = (encoder, pipeline, buffers, count) => {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, binding) => ({binding, resource: {buffer}})),
    }));
    pass.dispatchWorkgroups(count);
    pass.end();
  };
  const read = async buffer => {
    const staging = makeBuffer(buffer.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const values = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return values;
  };
  const check = (name, values, expected) => {
    const mismatch = values.findIndex((value, i) => value !== expected[i]);
    result.checks.push({name, pass: mismatch === -1 && values.length === expected.length,
      words: expected.length, firstMismatch: mismatch});
    if (!result.checks.at(-1).pass) throw new Error(`Mismatch: ${name} at ${mismatch}`);
  };
  const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
  const pixelCount = 256;
  const candidateCount = 32768;
  const inputDeclaration = '@group(0) @binding(0) var<storage, read> candidates: array<vec4u>;';
  const fallbackCode = `
    ${inputDeclaration}
    @group(0) @binding(1) var<storage, read_write> depths: array<atomic<u32>>;
    @group(0) @binding(2) var<storage, read_write> ids: array<atomic<u32>>;
    @compute @workgroup_size(64) fn depth(@builtin(global_invocation_id) tid: vec3u) {
      if (tid.x >= arrayLength(&candidates)) { return; }
      let c = candidates[tid.x];
      atomicMax(&depths[c.z], c.y);
    }
    @compute @workgroup_size(64) fn identity(@builtin(global_invocation_id) tid: vec3u) {
      if (tid.x >= arrayLength(&candidates)) { return; }
      let c = candidates[tid.x];
      if (atomicLoad(&depths[c.z]) == c.y) { atomicMax(&ids[c.z], c.x); }
    }
  `;
  try {
    const depthPipeline = await createPipeline(fallbackCode, 'depth');
    const identityPipeline = await createPipeline(fallbackCode, 'identity');
    const maxPipeline = packed ? await createPipeline(packedCode) : null;
    const minPipeline = packed ? await createPipeline(packedCode.replace('atomicStoreMax', 'atomicStoreMin')) : null;
    const snapshotPipeline = packed ? await createPipeline(`
      @group(0) @binding(0) var<storage, read> source: array<vec2u>;
      @group(0) @binding(1) var<storage, read_write> dest: array<vec2u>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) tid: vec3u) {
        if (tid.x < arrayLength(&source)) { dest[tid.x] = source[tid.x]; }
      }
    `) : null;
    for (const seed of [1, 0x12345678, 0xfedcba98]) {
      let state = seed;
      const random = () => {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        return state >>> 0;
      };
      const candidates = new Uint32Array(candidateCount * 4);
      const maxima = Array(pixelCount).fill(0n);
      const minima = Array(pixelCount).fill(0xffffffffffffffffn);
      for (let i = 0; i < candidateCount; i++) {
        const id = random();
        // Repeated finite, nonnegative depth bits exercise depth ties and full-width IDs.
        const depth = [0, 0x00800000, 0x3e800000, 0x3f000000, 0x3f800000][random() % 5];
        const pixel = random() % pixelCount;
        candidates.set([id, depth, pixel, 0], i * 4);
        const value = (BigInt(depth) << 32n) | BigInt(id);
        if (value > maxima[pixel]) maxima[pixel] = value;
        if (value < minima[pixel]) minima[pixel] = value;
      }
      const words = values => Uint32Array.from(values.flatMap(value =>
        [Number(value & 0xffffffffn), Number(value >> 32n)]));
      const expected = words(maxima);
      const input = makeBuffer(candidates.byteLength, storageUsage, candidates);
      const depths = makeBuffer(pixelCount * 4, storageUsage);
      const ids = makeBuffer(pixelCount * 4, storageUsage);
      const fallbackEncoder = device.createCommandEncoder();
      const depthPass = fallbackEncoder.beginComputePass();
      depthPass.setPipeline(depthPipeline);
      depthPass.setBindGroup(0, device.createBindGroup({
        layout: depthPipeline.getBindGroupLayout(0),
        entries: [input, depths].map((buffer, binding) => ({binding, resource: {buffer}})),
      }));
      depthPass.dispatchWorkgroups(candidateCount / 64);
      depthPass.end();
      dispatch(fallbackEncoder, identityPipeline, [input, depths, ids], candidateCount / 64);
      device.queue.submit([fallbackEncoder.finish()]);
      check(`two-pass-depth-${seed}`, await read(depths), Uint32Array.from(maxima, x => Number(x >> 32n)));
      check(`two-pass-id-${seed}`, await read(ids), Uint32Array.from(maxima, x => Number(x & 0xffffffffn)));
      if (packed) {
        const maximum = makeBuffer(pixelCount * 8, storageUsage);
        const minimum = makeBuffer(pixelCount * 8, storageUsage, new Uint32Array(pixelCount * 2).fill(0xffffffff));
        const snapshot = makeBuffer(pixelCount * 8, storageUsage);
        const encoder = device.createCommandEncoder();
        dispatch(encoder, maxPipeline, [input, maximum], candidateCount / 64);
        dispatch(encoder, minPipeline, [input, minimum], candidateCount / 64);
        dispatch(encoder, snapshotPipeline, [maximum, snapshot], pixelCount / 64);
        device.queue.submit([encoder.finish()]);
        check(`packed-max-${seed}`, await read(maximum), expected);
        check(`packed-min-${seed}`, await read(minimum), words(minima));
        check(`subsequent-readonly-view-${seed}`, await read(snapshot), expected);
      }
    }
    if (packed) {
      const pixels = makeBuffer(pixelCount * 8, storageUsage);
      const module = device.createShaderModule({code: `
        enable atomic_vec2u_min_max;
        @group(0) @binding(0) var<storage, read_write> pixels: array<atomic<vec2u>>;
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
          let p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
          return vec4f(p[i], 0.5, 1);
        }
        @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
          let pixel = u32(p.y) * 16u + u32(p.x);
          atomicStoreMax(&pixels[pixel], vec2u(0x80000000u + pixel, 0x3f000000u));
          return vec4f(1);
        }
      `});
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto', vertex: {module, entryPoint: 'vs'},
        fragment: {module, entryPoint: 'fs', targets: [{format: 'rgba8unorm'}]},
      });
      const texture = device.createTexture({size: [16, 16], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT});
      resources.push(texture);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({colorAttachments: [{
        view: texture.createView(), loadOp: 'clear', storeOp: 'store',
      }]});
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: {buffer: pixels}}],
      }));
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
      const fragmentExpected = Uint32Array.from(Array.from({length: pixelCount}, (_, i) =>
        [0x80000000 + i, 0x3f000000]).flat());
      check('fragment-packed-write', await read(pixels), fragmentExpected);
      const candidates = new Uint32Array(pixelCount * 4);
      const mergedExpected = fragmentExpected.slice();
      for (let i = 0; i < pixelCount; i++) {
        const value = i % 2 ? [1, 0x3f800000] : [0xffffffff, 0x3e800000];
        candidates.set([...value, i, 0], i * 4);
        if (i % 2) mergedExpected.set(value, i * 2);
      }
      const input = makeBuffer(candidates.byteLength, storageUsage, candidates);
      const mergeEncoder = device.createCommandEncoder();
      dispatch(mergeEncoder, maxPipeline, [input, pixels], pixelCount / 64);
      device.queue.submit([mergeEncoder.finish()]);
      check('fragment-then-compute-packed-merge', await read(pixels), mergedExpected);
      device.pushErrorScope('validation');
      const invalid = device.createShaderModule({code: `
        enable atomic_vec2u_min_max;
        @group(0) @binding(0) var<storage, read_write> pixels: array<atomic<vec2u>>;
        @compute @workgroup_size(1) fn main() { let value = atomicLoad(&pixels[0]); }
      `});
      result.packedAtomicLoadErrors = (await invalid.getCompilationInfo()).messages
        .filter(x => x.type === 'error').map(x => x.message);
      const expectedError = await device.popErrorScope();
      result.packedAtomicLoadRejected = !!expectedError || result.packedAtomicLoadErrors.length > 0;
    }
    await device.queue.onSubmittedWorkDone();
    result.pass = result.checks.every(x => x.pass) && result.unexpectedErrors.length === 0
      && (!packed || result.packedAtomicLoadRejected);
    return result;
  } finally {
    for (const resource of resources) resource.destroy();
    device.destroy();
  }
}

async function main() {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const tint = path.resolve(__dirname, '../../.tools/dawn-v20261009.190412/bin/tint.exe');
  if (fs.existsSync(tint)) {
    const shader = path.join(__dirname, 'shaders/nanite-packed-visibility-probe.wgsl');
    const spirv = path.join(path.dirname(output), 'nanite-packed-visibility-probe.spv');
    const runTint = args => {
      const value = spawnSync(tint, args, {encoding: 'utf8', timeout: 30000, windowsHide: true});
      return {args, status: value.status, error: value.error?.message,
        stdout: value.stdout?.trim(), stderr: value.stderr?.trim()};
    };
    report.compiler = {
      path: tint,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(tint)).digest('hex'),
      wgsl: runTint(['--format', 'wgsl', shader]),
      hlsl: runTint(['--format', 'hlsl', '--hlsl-shader-model', '6.6', shader]),
      spirv: runTint(['--format', 'spirv', '--output-name', spirv, shader]),
    };
    if (report.compiler.spirv.status === 0) {
      report.compiler.spirvToWgsl = runTint(['--format', 'wgsl', spirv]);
      report.compiler.spirvRoundtripSupported = report.compiler.spirvToWgsl.status === 0;
    }
  }
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Nanite visibility capability probe</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const channel of ['chrome', 'msedge']) {
      let browser;
      try {
        browser = await chromium.launch({channel, headless: true});
        const page = await browser.newPage();
        page.setDefaultTimeout(30000);
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const value = await page.evaluate(probe, packedCode);
        report.browsers.push({channel, version: browser.version(), ...value});
      } catch (error) {
        report.browsers.push({channel, pass: false, error: String(error)});
      } finally {
        if (browser) await browser.close();
      }
    }
    report.pass = report.browsers.length === 2 && report.browsers.every(x => x.pass);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.mkdirSync(path.dirname(output), {recursive: true});
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({output, pass: report.pass, browsers: report.browsers.map(x => ({
    channel: x.channel, version: x.version, packed: x.packedAtomicsAdvertised,
    checks: x.checks?.length, pass: x.pass, error: x.error,
  }))}, null, 2));
  assert(report.pass, 'Visibility probe failed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
