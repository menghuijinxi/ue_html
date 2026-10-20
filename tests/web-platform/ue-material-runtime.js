const report = {kind: 'ue-material-runtime', completeUEScene: false, pass: false,
  checks: [], errors: [], moduleCount: 0, pipelineCount: 0, checkedValues: 0,
  drawCount: 0, vertexFactory: 'FLocalVertexFactory'};
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
  const base = platformSource ? './build/ue-platform-material-worker/' :
    workerSource ? './build/ue-material-worker/' : './build/ue-material/';
  const manifest = await (await fetch(`${base}web-manifest.json`)).json();
  if (!manifest.pass) throw Error('UE material compilation or binding audit failed');
  if (platformSource && (!manifest.independentWebShaderPlatformVerified ||
      !manifest.shaderPlatformRegistration?.pass)) throw Error('Web platform registration missing');
  report.hostEngine = manifest.hostEngine;
  report.targetRevision = manifest.targetRevision;
  report.allIncludesMatchTarget = manifest.allIncludesMatchTarget;
  report.uniformEvaluation = manifest.uniformEvaluation;
  report.shaderCompileWorkerIPCVerified = !!manifest.shaderCompileWorkerIPCVerified;
  report.shaderSource = workerSource ? 'worker-bytecode' : 'standalone-wgsl';
  report.independentWebShaderPlatformVerified = !!manifest.independentWebShaderPlatformVerified;
  report.shaderPlatform = manifest.shaderPlatform;
  const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
  if (!adapter) throw Error('WebGPU adapter unavailable');
  const device = await adapter.requestDevice();
  report.requiredFeatures = [];
  report.deviceLimits = {maxUniformBufferBindingSize: device.limits.maxUniformBufferBindingSize,
    maxColorAttachments: device.limits.maxColorAttachments};
  device.addEventListener('uncapturederror', event => {
    event.preventDefault();
    report.errors.push(event.error.message);
  });
  const queue = device.queue, shaders = new Map(), constants = new Map();
  for (const sourceItem of manifest.cases) {
    let item = sourceItem, code;
    if (workerSource) {
      const response = await fetch(`${base}${item.packet}`);
      if (!response.ok) throw Error(`Worker packet missing: ${item.name}`);
      const packet = WebShaderCode.decode(await response.arrayBuffer(),
        platformSource ? manifest.shaderPlatformRegistration : undefined);
      if (packet.metadata.formatVersion !== manifest.formatVersion ||
          packet.metadata.frequency !== item.frequency) throw Error('Worker packet version/frequency mismatch');
      item = {...item, ...packet.metadata};
      code = packet.wgsl;
    } else code = await (await fetch(`${base}${item.name}.wgsl`)).text();
    const module = device.createShaderModule({code});
    const info = await module.getCompilationInfo();
    if (info.messages.some(message => message.type === 'error')) throw Error(`${item.name}: WGSL validation failed`);
    shaders.set(item.name, {...item, module, entry: item.reflection.entry_points[0]});
    ++report.moduleCount;
  }
  for (const artifact of manifest.uniformArtifacts) {
    constants.set(artifact.filename, new Uint8Array(await (await fetch(`${base}${artifact.filename}`)).arrayBuffer()));
  }
  report.checks.push(`shader-modules-${report.moduleCount}`);
  const palette = [[32, 64, 96, 255], [96, 128, 160, 255], [160, 192, 224, 255], [224, 64, 128, 255]];
  const image = device.createTexture({size: [2, 2], format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
  queue.writeTexture({texture: image}, new Uint8Array(palette.flat()), {bytesPerRow: 8}, [2, 2]);
  const sampler = device.createSampler({addressModeU: 'repeat', addressModeV: 'repeat',
    magFilter: 'nearest', minFilter: 'nearest'});
  function gpuBuffer(bytes, usage) {
    const buffer = device.createBuffer({size: Math.max(16, bytes.byteLength), usage: usage | GPUBufferUsage.COPY_DST});
    queue.writeBuffer(buffer, 0, bytes);
    return buffer;
  }
  const vertices = gpuBuffer(new Float32Array([
    -0.5, 0.5, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0,
    0.5, 0.5, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0,
    -0.5, -0.5, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 1,
    0.5, -0.5, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1,
  ]), GPUBufferUsage.VERTEX);
  const indices16 = gpuBuffer(new Uint16Array([0, 2, 1, 1, 2, 3]), GPUBufferUsage.INDEX);
  const indices32 = gpuBuffer(new Uint32Array([0, 2, 1, 1, 2, 3]), GPUBufferUsage.INDEX);
  const knownAttributes = new Map([
    [0, {shaderLocation: 0, format: 'float32x4', offset: 0}],
    [1, {shaderLocation: 1, format: 'float32x3', offset: 16}],
    [2, {shaderLocation: 2, format: 'float32x4', offset: 28}],
    [4, {shaderLocation: 4, format: 'float32x2', offset: 44}],
  ]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function settings(options = {}) {
    return {scale: [1, 1], translate: [0, 0, 0.5], projection: [1, 1],
      viewLow: [0, 0, 0], positionHigh: [0, 0, 0], viewHigh: [0, 0, 0],
      exposure: 1, override: false, indexFormat: 'uint16', instance: 0, ...options};
  }
  function fillUniform(binding, material, config) {
    const bytes = new Uint8Array(binding.paddedSize), view = new DataView(bytes.buffer);
    const write = (offset, values) => values.forEach((value, i) => view.setFloat32(offset + i * 4, value, true));
    const [sx, sy] = config.scale, [tx, ty, tz] = config.translate;
    const matrix = [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1];
    if (binding.name === 'Material') {
      const artifact = `${material}.${config.override ? 'override.uniform' : 'uniform'}.bin`;
      const data = constants.get(artifact);
      if (!data || data.byteLength > bytes.length) throw Error('Material constant allocation mismatch');
      bytes.set(data);
    } else if (binding.name === 'BatchedPrimitive') {
      // UE GPUScene.cpp: mobile records use 32 float4s, with transform rows at records 4..6.
      const offset = config.instance * 32 * 16;
      write(offset + 3 * 16, [...config.positionHigh, 0]);
      write(offset + 4 * 16, [sx, 0, 0, tx, 0, sy, 0, ty, 0, 0, 1, tz]);
      write(offset + 7 * 16, [1 / sx, 1 / sy, 1, 0]);
    } else {
      const values = {
        View_TranslatedWorldToClip: [config.projection[0], 0, 0, 0, 0, config.projection[1], 0, 0,
          0, 0, 1, 0, 0, 0, 0, 1],
        View_FirstPersonTransform: identity, View_PreViewTranslationHigh: config.viewHigh,
        View_PreViewTranslationLow: config.viewLow, View_PreExposure: [config.exposure],
        Primitive_Flags: [0], Primitive_PositionHigh: config.positionHigh,
        Primitive_LocalToRelativeWorld: matrix, Primitive_InvNonUniformScale: [1 / sx, 1 / sy, 1],
      };
      for (const member of binding.members) {
        if (!values[member.name]) throw Error(`Uniform field missing: ${member.name}`);
        if (member.name === 'Primitive_Flags') view.setUint32(member.offset, 0, true);
        else write(member.offset, values[member.name]);
      }
    }
    return gpuBuffer(bytes, GPUBufferUsage.UNIFORM);
  }
  function bind(pipeline, stages, config) {
    const entries = new Map(), owned = [];
    for (const stage of stages) {
      for (const binding of stage.spirvBindings) {
        let resource;
        if (binding.descriptorType === 6) {
          const buffer = fillUniform(binding, stage.material, config);
          owned.push(buffer);
          resource = {buffer};
        } else {
          const token = stage.resourceTokens.find(token => token.group === binding.group && token.binding === binding.binding);
          if (!token) throw Error(`UE resource token missing: ${binding.name}`);
          resource = token.category === 'textures' ? image.createView() : sampler;
        }
        const group = entries.get(binding.group) || [];
        group.push({binding: binding.binding, resource});
        entries.set(binding.group, group);
      }
    }
    return {owned, groups: Array.from({length: Math.max(...entries.keys()) + 1}, (_, index) =>
      device.createBindGroup({layout: pipeline.getBindGroupLayout(index), entries: entries.get(index) || []}))};
  }
  async function pipelineFor(vertex, fragment, format) {
    ++report.pipelineCount;
    return device.createRenderPipelineAsync({layout: 'auto',
      vertex: {module: vertex.module, entryPoint: vertex.webEntry, buffers: [{arrayStride: 52,
        attributes: vertex.entry.input_variables.map(input => {
          const attribute = knownAttributes.get(input.location);
          if (!attribute) throw Error(`Unsupported vertex location ${input.location}`);
          return attribute;
        })}]},
      fragment: {module: fragment.module, entryPoint: fragment.webEntry,
        targets: Array.from({length: 4}, () => ({format}))},
      primitive: {topology: 'triangle-list', cullMode: 'none'},
      depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater'}});
  }
  function draw(pass, pipeline, bindings, config) {
    pass.setPipeline(pipeline);
    bindings.groups.forEach((group, index) => pass.setBindGroup(index, group));
    pass.setVertexBuffer(0, vertices);
    pass.setIndexBuffer(config.indexFormat === 'uint32' ? indices32 : indices16, config.indexFormat);
    pass.drawIndexed(6, 1, 0, 0, config.instance);
    ++report.drawCount;
  }
  const width = 64, height = 64, pitch = 256;
  const targets = Array.from({length: 4}, () => device.createTexture({size: [width, height], format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC}));
  const depth = device.createTexture({size: [width, height], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT});
  function attachments(textures, depthTexture) {
    return {colorAttachments: textures.map(texture => ({view: texture.createView(),
      loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0]})),
      depthStencilAttachment: {view: depthTexture.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store'}};
  }
  function expectedColor(material, config, x, y) {
    const worldX = (2 * (x + 0.5) / width - 1) / config.projection[0];
    const worldY = (1 - 2 * (y + 0.5) / height) / config.projection[1];
    const localX = (worldX - config.translate[0] - config.viewLow[0] -
      config.positionHigh[0] - config.viewHigh[0]) / config.scale[0];
    const localY = (worldY - config.translate[1] - config.viewLow[1] -
      config.positionHigh[1] - config.viewHigh[1]) / config.scale[1];
    if (Math.abs(localX) > 0.5 || Math.abs(localY) > 0.5) return [0, 0, 0, 0];
    const color = material === 'UnlitColor' ?
      (config.override ? [0.75 * 255, 0.25 * 255, 0.125 * 255] : [0.125 * 255, 0.5 * 255, 0.75 * 255]) :
      palette[(localY < 0 ? 2 : 0) + (localX >= 0 ? 1 : 0)].slice(0, 3);
    return [...color.map(channel => Math.round(Math.min(255, channel * config.exposure))), 0];
  }
  async function verifyDraw(name, material, stages, pipeline, config, behind) {
    device.pushErrorScope('validation');
    let failure, owned = [], readback;
    try {
      const bindings = bind(pipeline, stages, config);
      owned.push(...bindings.owned);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass(attachments(targets, depth));
      draw(pass, pipeline, bindings, config);
      if (behind) {
        const far = bind(pipeline, stages, behind);
        owned.push(...far.owned);
        draw(pass, pipeline, far, behind);
      }
      pass.end();
      readback = device.createBuffer({size: pitch * height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      targets.forEach((texture, index) => encoder.copyTextureToBuffer({texture},
        {buffer: readback, offset: pitch * height * index, bytesPerRow: pitch}, [width, height]));
      queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const bytes = new Uint8Array(readback.getMappedRange());
      for (let target = 0; target < 4; ++target) {
        for (let y = 0; y < height; ++y) {
          for (let x = 0; x < width; ++x) {
            const expected = target === 0 ? expectedColor(material, config, x, y) : [0, 0, 0, 0];
            const offset = target * pitch * height + y * pitch + x * 4;
            for (let channel = 0; channel < 4; ++channel) {
              if (Math.abs(bytes[offset + channel] - expected[channel]) > 2) {
                throw Error(`target=${target} pixel=${x},${y} channel=${channel} actual=${bytes[offset + channel]} expected=${expected[channel]}`);
              }
              ++report.checkedValues;
            }
          }
        }
      }
      readback.unmap();
    } catch (error) { failure = error.message; }
    await queue.onSubmittedWorkDone();
    const validation = await device.popErrorScope();
    if (failure || validation) report.errors.push(`${name}: ${validation?.message || failure}`);
    else report.checks.push(name);
    readback?.destroy();
    owned.forEach(buffer => buffer.destroy());
  }
  for (const material of ['UnlitColor', 'UnlitTexture']) {
    for (const profile of ['Native', 'WebVertexInput']) {
      const vertex = shaders.get(`${material}_${profile}_TMobileBasePassVSFNoLightMapPolicy`);
      const fragment = shaders.get(`${material}_${profile}_TMobileBasePassPSFNoLightMapPolicy`);
      const stages = [vertex, fragment], pipeline = await pipelineFor(vertex, fragment, 'rgba8unorm');
      const prefix = `${material}-${profile}`;
      await verifyDraw(`${prefix}-indexed16`, material, stages, pipeline, settings());
      await verifyDraw(`${prefix}-indexed32`, material, stages, pipeline, settings({indexFormat: 'uint32'}));
      await verifyDraw(`${prefix}-pre-exposure`, material, stages, pipeline, settings({exposure: 0.5}));
      await verifyDraw(`${prefix}-model-transform`, material, stages, pipeline,
        settings({scale: [0.75, 0.5], translate: [0.25, -0.125, 0.5]}));
      await verifyDraw(`${prefix}-view-projection`, material, stages, pipeline,
        settings({projection: [0.5, 0.75], viewLow: [0.25, -0.125, 0]}));
      await verifyDraw(`${prefix}-large-world-instance`, material, stages, pipeline,
        settings({instance: 2, positionHigh: [65536, -65536, 0], viewHigh: [-65536, 65536, 0], viewLow: [0.125, 0, 0]}));
      if (material === 'UnlitColor') {
        await verifyDraw(`${prefix}-parameter-override`, material, stages, pipeline, settings({override: true}));
        await verifyDraw(`${prefix}-reversed-depth`, material, stages, pipeline,
          settings({override: true, translate: [0, 0, 0.75]}), settings({translate: [0, 0, 0.25]}));
      }
    }
  }
  const canvas = document.getElementById('scene'), context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({device, format, alphaMode: 'opaque'});
  const vertex = shaders.get('UnlitTexture_WebVertexInput_TMobileBasePassVSFNoLightMapPolicy');
  const fragment = shaders.get('UnlitTexture_WebVertexInput_TMobileBasePassPSFNoLightMapPolicy');
  const pipeline = await pipelineFor(vertex, fragment, format), config = settings({scale: [2, 2]});
  const canvasTargets = [context.getCurrentTexture(), ...Array.from({length: 3}, () =>
    device.createTexture({size: [canvas.width, canvas.height], format, usage: GPUTextureUsage.RENDER_ATTACHMENT}))];
  const canvasDepth = device.createTexture({size: [canvas.width, canvas.height], format: 'depth32float',
    usage: GPUTextureUsage.RENDER_ATTACHMENT});
  const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass(attachments(canvasTargets, canvasDepth));
  draw(pass, pipeline, bind(pipeline, [vertex, fragment], config), config);
  pass.end();
  queue.submit([encoder.finish()]);
  await queue.onSubmittedWorkDone();
  report.canvasExpectedPixels = palette;
  report.checks.push('canvas-indexed-textured-mesh');
  finish();
})().catch(error => { report.errors.push(error.stack || String(error)); finish(); });
