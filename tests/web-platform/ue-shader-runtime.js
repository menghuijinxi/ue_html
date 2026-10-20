const report = {kind: 'ue-global-shader-runtime', completeUEScene: false,
  pass: false, checks: [], errors: [], moduleCount: 0, pipelineCount: 0,
  checkedValues: 0};
function finish() {
  report.pass = !report.errors.length;
  globalThis.__p0Report = report;
  const state = document.getElementById('state');
  state.textContent = report.pass ? 'PASS' : 'FAIL';
  state.dataset.pass = String(report.pass);
  document.getElementById('result').textContent = JSON.stringify(report, null, 2);
}
(async () => {
  const source = new URLSearchParams(location.search).get('source');
  const platformSource = source === 'platform', workerSource = platformSource || source === 'worker';
  const base = platformSource ? './build/ue-platform-full-worker/' :
    workerSource ? './build/ue-full-worker/' : './build/ue-full/';
  const response = await fetch(`${base}web-manifest.json`);
  if (!response.ok) throw Error('UE shader manifest missing');
  const manifest = await response.json();
  if (!manifest.pass) throw Error('UE compiler or source audit failed');
  if (platformSource && (!manifest.independentWebShaderPlatformVerified ||
      !manifest.shaderPlatformRegistration?.pass)) throw Error('Web platform registration missing');
  report.hostEngine = manifest.hostEngine;
  report.targetRevision = manifest.targetRevision;
  report.fullUEPreprocessing = manifest.fullUEPreprocessing;
  report.fullUEParameterMap = manifest.fullUEParameterMap;
  report.allIncludesMatchTarget = manifest.allIncludesMatchTarget;
  report.shaderCompileWorkerIPCVerified = !!manifest.shaderCompileWorkerIPCVerified;
  report.shaderSource = workerSource ? 'worker-bytecode' : 'standalone-wgsl';
  report.independentWebShaderPlatformVerified = !!manifest.independentWebShaderPlatformVerified;
  report.shaderPlatform = manifest.shaderPlatform;
  report.expectedConversionRejections = manifest.cases.filter(item => item.expectedRejection)
    .map(item => ({name: item.name, category: item.rejectionCategory}));
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw Error('WebGPU adapter unavailable');
  const mode = new URLSearchParams(location.search).get('features') || 'tier2';
  report.featureMode = mode;
  report.tier2Available = adapter.features.has('texture-formats-tier2');
  const device = await adapter.requestDevice({requiredFeatures:
    mode === 'tier2' && report.tier2Available ? ['texture-formats-tier2'] : []});
  const queue = device.queue;
  device.addEventListener('uncapturederror', event => {
    event.preventDefault();
    report.errors.push(event.error.message);
  });
  const shaders = new Map();
  for (const sourceItem of manifest.cases.filter(item => item.converted)) {
    let item = sourceItem;
    const response = await fetch(`${base}${workerSource ? item.packet : `${item.name}.wgsl`}`);
    if (!response.ok) throw Error(`WGSL missing: ${item.name}`);
    let code;
    if (workerSource) {
      const packet = WebShaderCode.decode(await response.arrayBuffer(),
        platformSource ? manifest.shaderPlatformRegistration : undefined);
      if (packet.metadata.formatVersion !== manifest.formatVersion ||
          packet.metadata.frequency !== item.frequency) throw Error('Worker packet version/frequency mismatch');
      item = {...item, ...packet.metadata};
      code = packet.wgsl;
    } else code = await response.text();
    const module = device.createShaderModule({code});
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(message => message.type === 'error');
    if (errors.length) throw Error(`${item.name}: ${errors.map(error => error.message).join('; ')}`);
    shaders.set(item.name, {...item, module, entry: item.reflection.entry_points[0]});
    ++report.moduleCount;
  }
  report.checks.push(`shader-modules-${report.moduleCount}`);
  const get = name => {
    if (!shaders.has(name)) throw Error(`Shader missing: ${name}`);
    return shaders.get(name);
  };
  function buffer(data, usage) {
    const result = device.createBuffer({size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
    queue.writeBuffer(result, 0, data);
    return result;
  }
  function uniform(shader, values) {
    const globals = shader.spirvBindings.find(binding => binding.name === '$Globals');
    if (!globals) return null;
    const bytes = new Uint8Array(globals.paddedSize);
    for (const parameter of shader.ueParameterMap.filter(parameter => parameter.type === 0)) {
      const value = values[parameter.name];
      if (!value || value.byteLength !== parameter.size) throw Error(`Parameter size: ${shader.name}.${parameter.name}`);
      bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), parameter.baseIndex);
    }
    return buffer(bytes, GPUBufferUsage.UNIFORM);
  }
  function bind(pipeline, stages, values) {
    const grouped = new Map();
    for (const shader of stages) {
      const globals = uniform(shader, values);
      for (const binding of shader.spirvBindings) {
        const entries = grouped.get(binding.group) || [];
        const resource = binding.name === '$Globals' ? {buffer: globals} : values[binding.name];
        if (!resource) throw Error(`Resource missing: ${shader.name}.${binding.name}`);
        entries.push({binding: binding.binding, resource});
        grouped.set(binding.group, entries);
      }
    }
    const maximum = Math.max(-1, ...grouped.keys());
    return Array.from({length: maximum + 1}, (_, group) =>
      device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries: grouped.get(group) || []}));
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
  async function readBuffer(encoder, source, size) {
    const readback = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    encoder.copyBufferToBuffer(source, 0, readback, 0, size);
    queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    readback.destroy();
    return bytes;
  }
  async function readTexture(encoder, texture, dimensions, channels) {
    const [width, height, depth] = dimensions;
    const pitch = Math.ceil(width * channels * 4 / 256) * 256;
    const readback = device.createBuffer({size: pitch * height * depth,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
    encoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow: pitch, rowsPerImage: height}, dimensions);
    queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    readback.destroy();
    return {bytes, pitch};
  }
  const vertices = buffer(new Float32Array([0, 0, 0, 0, 1, 0, 1, 0,
    0, 1, 0, 1, 1, 1, 1, 1]), GPUBufferUsage.VERTEX);
  const rectangle = buffer(new Float32Array([1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1]), GPUBufferUsage.UNIFORM);
  const vertexLayouts = [{arrayStride: 16, attributes: [
    {shaderLocation: 0, format: 'float32x2', offset: 0},
    {shaderLocation: 1, format: 'float32x2', offset: 8},
  ]}];
  const sampler = device.createSampler();
  const palette = [[32, 64, 96, 51], [96, 128, 160, 102], [160, 192, 224, 153], [224, 64, 128, 204]];
  const image = device.createTexture({size: [2, 2], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  queue.writeTexture({texture: image}, new Uint8Array(palette.flat()), {bytesPerRow: 8}, [2, 2]);
  const arrayImage = device.createTexture({size: [2, 2, 2], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  queue.writeTexture({texture: arrayImage, origin: [0, 0, 1]}, new Uint8Array(palette.flat()), {bytesPerRow: 8}, [2, 2, 1]);
  function renderPipeline(vertex, fragment, format, withVertices) {
    ++report.pipelineCount;
    return device.createRenderPipelineAsync({layout: 'auto',
      vertex: {module: vertex.module, entryPoint: vertex.webEntry, buffers: withVertices ? vertexLayouts : []},
      fragment: {module: fragment.module, entryPoint: fragment.webEntry, targets: [{format}]},
      primitive: {topology: 'triangle-strip'}});
  }
  function draw(encoder, texture, pipeline, groups, withVertices) {
    const pass = encoder.beginRenderPass({colorAttachments: [{view: texture.createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]}]});
    pass.setPipeline(pipeline);
    groups.forEach((group, index) => pass.setBindGroup(index, group));
    if (withVertices) pass.setVertexBuffer(0, vertices);
    pass.draw(4);
    pass.end();
  }
  for (const name of ['FScreenPS', 'FScreenPSMipLevel', 'FScreenPSInvertAlpha',
    'FScreenPSsRGBSource', 'FScreenPSsRGBSourceMipLevel', 'FScreenPSArraySlice']) {
    await check(`${name}-pixels`, async () => {
      const vertex = get('FScreenVS'), fragment = get(name);
      const pipeline = await renderPipeline(vertex, fragment, 'rgba8unorm', true);
      const groups = bind(pipeline, [vertex, fragment], {
        DrawRectangleParameters: {buffer: rectangle}, InTexture: name.includes('Array') ?
          arrayImage.createView({dimension: '2d-array'}) : image.createView(),
        InTextureSampler: sampler, MipLevel: new Int32Array([0]), ArraySlice: new Uint32Array([1]),
      });
      const target = device.createTexture({size: [64, 64], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const encoder = device.createCommandEncoder();
      draw(encoder, target, pipeline, groups, true);
      const {bytes, pitch} = await readTexture(encoder, target, [64, 64, 1], 1);
      for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) {
        const expected = [...palette[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)]];
        if (name.includes('sRGB')) for (let c = 0; c < 3; ++c) expected[c] = Math.round(255 * (expected[c] / 255) ** (1 / 2.2));
        if (name.includes('Invert')) expected[3] = 255 - expected[3];
        for (let c = 0; c < 4; ++c) {
          if (Math.abs(bytes[y * pitch + x * 4 + c] - expected[c]) > 1) throw Error(`Pixel mismatch ${x},${y},${c}`);
          ++report.checkedValues;
        }
      }
      target.destroy();
    });
  }
  const color = [0.25, 0.5, 0.75, 1];
  for (const [vertexName, fragmentName] of [
    ['FClearReplacementVS', 'FClearReplacementPS'],
    ['FClearReplacementVS_Bounds', 'FClearReplacementPS_128'],
    ['FClearReplacementVS_Depth', 'FClearReplacementPS_Zero'],
  ]) {
    await check(`${vertexName}-${fragmentName}-pixels`, async () => {
      const vertex = get(vertexName), fragment = get(fragmentName);
      const pipeline = await renderPipeline(vertex, fragment, 'rgba8unorm', false);
      const bounded = vertexName.includes('Bounds');
      const groups = bind(pipeline, [vertex, fragment], {ClearValue: new Float32Array(color),
        MinBounds: new Float32Array([-0.5, -0.5]), MaxBounds: new Float32Array([0.5, 0.5]), Depth: new Float32Array([0.4])});
      const target = device.createTexture({size: [64, 64], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
      const encoder = device.createCommandEncoder();
      draw(encoder, target, pipeline, groups, false);
      const {bytes, pitch} = await readTexture(encoder, target, [64, 64, 1], 1);
      for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) for (let c = 0; c < 4; ++c) {
        const inside = !bounded || (x >= 16 && x < 48 && y >= 16 && y < 48);
        const expected = inside && !fragmentName.includes('Zero') ? Math.round(color[c] * 255) : 0;
        if (Math.abs(bytes[y * pitch + x * 4 + c] - expected) > 1) throw Error(`Clear mismatch ${x},${y},${c}`);
        ++report.checkedValues;
      }
      target.destroy();
    });
  }
  for (const shader of [...shaders.values()].filter(shader => shader.entry.stage === 'compute')) {
    await check(`${shader.name}-readback`, async () => {
      ++report.pipelineCount;
      const pipeline = await device.createComputePipelineAsync({layout: 'auto',
        compute: {module: shader.module, entryPoint: shader.webEntry}});
      const structured = shader.name.includes('StructuredBuffer') || !!shader.fallbackOf;
      const large = !!shader.fallbackOf && shader.name.includes('LargeBuffer');
      const wrapped = large && shader.ueParameterMap.some(parameter => parameter.name === 'MaxBounds');
      const vector = /(?:Float|Uint|Sint)4/.test(shader.name);
      const channels = vector ? 4 : 1;
      const Typed = shader.name.includes('Float') ? Float32Array : shader.name.includes('Sint') ? Int32Array : Uint32Array;
      const sentinel = Typed === Float32Array ? -3 : Typed === Int32Array ? -123 : 99;
      const clear = Typed === Float32Array ? color.slice(0, channels) :
        (Typed === Int32Array ? [-7, -11, 19, -23] : [7, 11, 19, 23]).slice(0, channels);
      const zero = shader.name.endsWith('_Zero');
      const dimensions = structured ? [large ? 16384 : 128, 1, 1] : [8, 8, /Texture3D|Texture2DArray/.test(shader.name) ? 4 : 1];
      const bounds = shader.name.endsWith('_Bounds');
      const minimum = bounds ? [2, structured ? 0 : 1, dimensions[2] > 1 ? 1 : 0] : [0, 0, 0];
      const maximum = bounds ? [dimensions[0] - 2, structured ? 1 : dimensions[1] - 1,
        dimensions[2] > 1 ? dimensions[2] - 1 : 1] : dimensions;
      const values = {ClearValue: new Typed(clear), MinBounds: new Uint32Array([...minimum, 0]),
        MaxBounds: new Uint32Array([...maximum, 0])};
      let resource, source, pitch;
      if (structured) {
        resource = buffer(new Typed(dimensions[0] * channels).fill(sentinel),
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        values.ClearResource = {buffer: resource};
      } else {
        const binding = shader.entry.bindings.find(binding => binding.resource_type.includes('StorageTexture'));
        const format = {Rgba32Float: 'rgba32float', Rgba32Uint: 'rgba32uint', Rgba32Sint: 'rgba32sint',
          R32Uint: 'r32uint', R32Float: 'r32float'}[binding.image_format];
        if (!format) throw Error(`Texture format missing: ${binding.image_format}`);
        resource = device.createTexture({size: dimensions, dimension: binding.dimensions === '3d' ? '3d' : '2d',
          format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
        values.ClearResource = resource.createView({dimension: binding.dimensions === '2dArray' ? '2d-array' : binding.dimensions});
        queue.writeTexture({texture: resource}, new Typed(dimensions.reduce((a, b) => a * b) * channels).fill(sentinel),
          {bytesPerRow: dimensions[0] * channels * 4, rowsPerImage: dimensions[1]}, dimensions);
      }
      const groups = bind(pipeline, [shader], values);
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      const dispatch = wrapped ? [128, 2, 1] : dimensions.map((_, index) =>
        Math.ceil((maximum[index] - minimum[index]) / shader.entry.workgroup_size[index]));
      pass.dispatchWorkgroups(...dispatch);
      pass.end();
      if (structured) {
        source = new Typed((await readBuffer(encoder, resource, dimensions[0] * channels * 4)).buffer);
        pitch = dimensions[0] * channels;
      } else {
        const readback = await readTexture(encoder, resource, dimensions, channels);
        source = new Typed(readback.bytes.buffer);
        pitch = readback.pitch / 4;
      }
      for (let z = 0; z < dimensions[2]; ++z) for (let y = 0; y < dimensions[1]; ++y)
        for (let x = 0; x < dimensions[0]; ++x) for (let c = 0; c < channels; ++c) {
          const inside = [x, y, z].every((coordinate, index) => coordinate >= minimum[index] && coordinate < maximum[index]);
          const expected = inside ? (zero ? 0 : clear[c]) : sentinel;
          const actual = source[(z * dimensions[1] + y) * pitch + x * channels + c];
          if (Math.abs(actual - expected) > 0.00001) throw Error(`Compute mismatch ${x},${y},${z},${c}: ${actual} != ${expected}`);
          ++report.checkedValues;
        }
      resource.destroy();
    });
  }
  await check('canvas-present', async () => {
    const vertex = get('FClearReplacementVS'), fragment = get('FClearReplacementPS');
    const canvas = document.getElementById('scene'), context = canvas.getContext('webgpu');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({device, format, alphaMode: 'opaque'});
    const pipeline = await renderPipeline(vertex, fragment, format, false);
    const groups = bind(pipeline, [vertex, fragment], {ClearValue: new Float32Array(color)});
    const encoder = device.createCommandEncoder();
    draw(encoder, context.getCurrentTexture(), pipeline, groups, false);
    queue.submit([encoder.finish()]);
  });
  await queue.onSubmittedWorkDone();
  finish();
})().catch(error => { report.errors.push(error.message); finish(); });
