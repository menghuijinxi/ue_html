const report = {kind: 'shader-runtime-smoke', includeEnvironment: 'reduced-standalone-fixtures',
  completeUECompiler: false, pass: false, checks: [], errors: []};
const color = [0.25, 0.5, 0.75, 1];

function finish() {
  report.pass = report.errors.length === 0;
  globalThis.__p0Report = report;
  const state = document.getElementById('state');
  state.textContent = report.pass ? 'PASS' : 'FAIL';
  state.dataset.pass = String(report.pass);
  document.getElementById('result').textContent = JSON.stringify(report, null, 2);
}

(async () => {
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw Error('WebGPU adapter unavailable');
  const mode = new URLSearchParams(location.search).get('features') || 'tier2';
  const requested = mode === 'tier2' ? 'texture-formats-tier2' :
    mode === 'tier1' ? 'texture-formats-tier1' : null;
  const requiredFeatures = requested && adapter.features.has(requested) ? [requested] : [];
  report.featureMode = mode;
  report.adapterSupportsRequestedFeature = !requested || adapter.features.has(requested);
  report.requestedFeatures = requiredFeatures;
  const device = await adapter.requestDevice({requiredFeatures});
  device.addEventListener('uncapturederror', event => {
    event.preventDefault();
    report.errors.push(event.error.message);
  });
  const queue = device.queue;
  const modules = {};
  const reflection = {};
  for (const name of ['screen-vs', 'screen-ps', 'screen-mip-ps', 'clear-vs', 'clear-ps',
    'clear-structured-cs', 'clear-texture-cs']) {
    const response = await fetch(`./build/shaders/${name}.wgsl`);
    if (!response.ok) throw Error(`Shader artifact missing: ${name}`);
    const module = device.createShaderModule({code: await response.text()});
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw Error(`${name}: ${errors.map(message => message.message).join('; ')}`);
    modules[name] = module;
    const metadata = await fetch(`./build/shaders/${name}.reflection.json`);
    reflection[name] = await metadata.json();
  }

  function checkBindings(name, expected) {
    const bindings = reflection[name].entry_points[0].bindings;
    const actual = bindings.map(binding => `${binding.group}:${binding.binding}:${binding.resource_type}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) {
      throw Error(`Reflection bindings mismatch: ${name}: ${actual}`);
    }
  }
  checkBindings('screen-ps', ['0:0:SampledTexture', '0:1:Sampler']);
  checkBindings('screen-mip-ps', ['0:0:SampledTexture', '0:1:Sampler', '0:2:UniformBuffer']);
  checkBindings('clear-ps', ['0:2:UniformBuffer']);
  checkBindings('clear-structured-cs', ['0:0:StorageBuffer', '0:2:UniformBuffer']);
  const layout = reflection['clear-structured-cs'].structures.find(structure => structure.name === 'S');
  if (layout.size !== 48 || layout.members.map(member => member.offset).join(',') !== '0,16,32') {
    throw Error('Compute Uniform layout mismatch');
  }
  report.checks.push('reflection-bindings-uniform-offsets');

  function buffer(data, usage) {
    const value = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
    queue.writeBuffer(value, 0, data);
    return value;
  }
  function parameters(min, max) {
    const data = new ArrayBuffer(48);
    new Float32Array(data, 0, 4).set(color);
    new Uint32Array(data, 16, 4).set(min);
    new Uint32Array(data, 32, 4).set(max);
    return buffer(data, GPUBufferUsage.UNIFORM);
  }
  async function readTexture(encoder, texture, width, height, bytesPerPixel) {
    const pitch = Math.ceil(width * bytesPerPixel / 256) * 256;
    const readback = device.createBuffer({size: pitch * height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    encoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow: pitch}, [width, height]);
    queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    readback.destroy();
    return {bytes, pitch};
  }
  async function check(name, action) {
    device.pushErrorScope('validation');
    let failure;
    try { await action(); await queue.onSubmittedWorkDone(); }
    catch (error) { failure = error.message; }
    const gpuError = await device.popErrorScope();
    if (failure || gpuError) report.errors.push(`${name}: ${gpuError?.message || failure}`);
    else report.checks.push(name);
  }

  const vertices = buffer(new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0,
    -1, -1, 0, 1, 1, -1, 1, 1]), GPUBufferUsage.VERTEX);
  const image = device.createTexture({size: [2, 2], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  queue.writeTexture({texture: image}, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255]), {bytesPerRow: 8}, [2, 2]);
  const sampler = device.createSampler();
  const vertexLayouts = [{arrayStride: 16, attributes: [
    {shaderLocation: 0, format: 'float32x2', offset: 0},
    {shaderLocation: 1, format: 'float32x2', offset: 8},
  ]}];
  function renderPipeline(fragment, entry, format, clear = false) {
    return device.createRenderPipeline({layout: 'auto',
      vertex: {module: modules[clear ? 'clear-vs' : 'screen-vs'],
        entryPoint: clear ? 'ClearVS' : 'Main', buffers: clear ? [] : vertexLayouts},
      fragment: {module: modules[fragment], entryPoint: entry, targets: [{format}]},
      primitive: {topology: 'triangle-strip'},
    });
  }
  function draw(encoder, texture, pipeline, group, clear = false) {
    const pass = encoder.beginRenderPass({colorAttachments: [{view: texture.createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (!clear) pass.setVertexBuffer(0, vertices);
    pass.draw(4);
    pass.end();
  }
  const original = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
  for (const [name, entry, mip] of [['screen-ps', 'Main', false], ['screen-mip-ps', 'MainMipLevel', true]]) {
    await check(name + '-pixels', async () => {
      const pipeline = renderPipeline(name, entry, 'rgba8unorm');
      const entries = [{binding: 0, resource: image.createView()}, {binding: 1, resource: sampler}];
      if (mip) entries.push({binding: 2, resource: {buffer: buffer(new Int32Array([0, 0, 0, 0]), GPUBufferUsage.UNIFORM)}});
      const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries});
      const target = device.createTexture({size: [64, 64], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const encoder = device.createCommandEncoder();
      draw(encoder, target, pipeline, group);
      const {bytes, pitch} = await readTexture(encoder, target, 64, 64, 4);
      for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) {
        const expected = original[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)];
        for (let c = 0; c < 4; ++c) {
          if (Math.abs(bytes[y * pitch + x * 4 + c] - expected[c]) > 1) throw Error(`Pixel mismatch ${x},${y}`);
        }
      }
      target.destroy();
    });
  }

  const clearUniform = buffer(new Float32Array(color), GPUBufferUsage.UNIFORM);
  await check('clear-vs-ps-uniform-pixels', async () => {
    const pipeline = renderPipeline('clear-ps', 'ClearPS', 'rgba8unorm', true);
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 2, resource: {buffer: clearUniform}}]});
    const target = device.createTexture({size: [64, 64], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
    const encoder = device.createCommandEncoder();
    draw(encoder, target, pipeline, group, true);
    const {bytes, pitch} = await readTexture(encoder, target, 64, 64, 4);
    for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) for (let c = 0; c < 4; ++c) {
      if (Math.abs(bytes[y * pitch + x * 4 + c] - Math.round(color[c] * 255)) > 1) throw Error('Clear pixel mismatch');
    }
    target.destroy();
  });

  await check('clear-structured-cs-bounds-readback', async () => {
    const pipeline = device.createComputePipeline({layout: 'auto',
      compute: {module: modules['clear-structured-cs'], entryPoint: 'ClearCS'}});
    const storage = device.createBuffer({size: 32 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC});
    const readback = device.createBuffer({size: 32 * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
    const uniform = parameters([4, 0, 0, 0], [32, 1, 1, 0]);
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 0, resource: {buffer: storage}}, {binding: 2, resource: {buffer: uniform}}]});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(4); pass.end();
    encoder.copyBufferToBuffer(storage, 0, readback, 0, 32 * 16);
    queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const values = new Float32Array(readback.getMappedRange());
    for (let i = 0; i < 32; ++i) for (let c = 0; c < 4; ++c) {
      if (values[i * 4 + c] !== (i < 4 ? 0 : color[c])) throw Error(`Storage value mismatch ${i}:${c}`);
    }
    readback.unmap(); readback.destroy(); storage.destroy(); uniform.destroy();
  });

  await check('clear-texture-cs-bounds-readback', async () => {
    const pipeline = device.createComputePipeline({layout: 'auto',
      compute: {module: modules['clear-texture-cs'], entryPoint: 'ClearCS'}});
    const target = device.createTexture({size: [8, 4], format: 'rgba32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC});
    const uniform = parameters([2, 1, 0, 0], [8, 4, 1, 0]);
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 0, resource: target.createView()}, {binding: 2, resource: {buffer: uniform}}]});
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1, 4); pass.end();
    const {bytes, pitch} = await readTexture(encoder, target, 8, 4, 16);
    const values = new Float32Array(bytes.buffer);
    for (let y = 0; y < 4; ++y) for (let x = 0; x < 8; ++x) for (let c = 0; c < 4; ++c) {
      if (values[y * pitch / 4 + x * 4 + c] !== (x < 2 || y < 1 ? 0 : color[c])) {
        throw Error(`Storage texture mismatch ${x},${y}:${c}`);
      }
    }
    target.destroy(); uniform.destroy();
  });

  await check('clear-shader-canvas-present', async () => {
    const context = document.getElementById('scene').getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({device, format, alphaMode: 'opaque'});
    const pipeline = renderPipeline('clear-ps', 'ClearPS', format, true);
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0),
      entries: [{binding: 2, resource: {buffer: clearUniform}}]});
    const encoder = device.createCommandEncoder();
    draw(encoder, context.getCurrentTexture(), pipeline, group, true);
    queue.submit([encoder.finish()]);
  });
  finish();
})().catch(error => { report.errors.push(error.message); finish(); });
