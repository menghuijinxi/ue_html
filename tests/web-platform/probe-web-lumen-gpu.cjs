'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {audit} = require('./content-file-metadata.cjs');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert(argument('input'), '--input must name a Lumen ShaderConversion directory');
const directory = path.resolve(argument('input'));
const output = path.resolve(argument('output') || path.join(__dirname, 'results/web-lumen-gpu.json'));
const modulesOnly = process.argv.includes('--modules-only');
const pipelines = process.argv.includes('--pipelines');
const pipelineBatchSize = Number(argument('pipeline-batch') || 64);
assert(Number.isInteger(pipelineBatchSize) && pipelineBatchSize > 0 && pipelineBatchSize <= 1024);
const selectedJob = argument('job');
assert(!selectedJob || /^[A-Za-z0-9_-]+$/.test(selectedJob), 'Invalid conversion job name');
const storageFormats = Object.fromEntries((argument('storage-formats') || '').split(',').filter(Boolean).map(item => {
  const pair = item.split(':');
  assert(pair.length === 2 && pair.every(value => /^[A-Za-z0-9_]+$/.test(value)),
    'storage-formats must contain bindingName:format pairs');
  return pair;
}));
const report = {date: new Date().toISOString(), pass: false, modulesOnly, modules: [], execution: [],
  pipelines: [], storageFormats, pipelineBatchSize, devices: 0,
  hostCondition: process.env.UE_WEB_TEST_HOST_CONDITION || 'default CPU scheduling',
  completeLumenScene: false, sourceFiles: [audit(__filename)]};
const jobs = fs.readdirSync(directory).flatMap(name => {
  if (selectedJob && name !== selectedJob) return [];
  const file = path.join(directory, name, 'output.wgsl');
  if (!fs.existsSync(file) || fs.existsSync(path.join(directory, name, 'failure.json'))) return [];
  const inputFile = path.join(directory, name, 'input.json');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  return [{name: input.shaderName, shader: input.shader, job: name, metadata: input.metadata,
    code: fs.readFileSync(file, 'utf8'), sourceFiles: [audit(file), audit(inputFile)]}];
});
assert(jobs.length, 'No converted UE shaders');

(async () => {
  let browser;
  try {
    for (const [shader, name] of [
      ['FScreenProbeTraceScreenTexturesCS', 'RWTraceRadiance'],
      ['FReflectionTraceVoxelsCS', 'RWTraceRadiance'],
      ['FLumenSceneDenoiserTemporalCS', 'RWNumFramesAccumulated'],
      ['FLumenRadiosityDistanceFieldTracingCS', 'RWTraceRadianceAtlas'],
    ]) {
      const job = jobs.find(item => item.name === shader);
      if (!job && modulesOnly) continue;
      const binding = job?.metadata.spirvBindings.find(item => item.name === name);
      assert.equal(binding?.storageTextureAccess, 'write',
        `${shader}/${name}: SPIR-V instruction literals must not imply an image read`);
    }
    report.runtimeStorageBindings = 0;
    for (const job of jobs)
      for (const binding of job.metadata.spirvBindings.filter(item => item.runtimeStorageFormat)) {
        assert.equal(job.code.slice(binding.storageFormatOffset,
          binding.storageFormatOffset + binding.storageFormatLength), 'rgba32float',
        `${job.name}/${binding.name}: runtime format position differs from emitted WGSL`);
        ++report.runtimeStorageBindings;
      }
    browser = await chromium.launch({headless: true,
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage();
    await page.route('http://127.0.0.1:8765/lumen-shader-validation', route =>
      route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Lumen shader probe</title>'}));
    await page.goto('http://127.0.0.1:8765/lumen-shader-validation');
    const initializeDevice = () => page.evaluate(async pipelines => {
      const adapter = await navigator.gpu.requestAdapter({powerPreference: 'high-performance'});
      const features = ['texture-formats-tier1', 'texture-formats-tier2',
        'rg11b10ufloat-renderable', 'subgroups'].filter(name => adapter.features.has(name));
      const requiredLimits = pipelines ? Object.fromEntries(Object.entries({
        maxStorageBuffersPerShaderStage: 16, maxStorageTexturesPerShaderStage: 8,
        maxSampledTexturesPerShaderStage: 32, maxSamplersPerShaderStage: 16,
        maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 1024,
        maxComputeWorkgroupSizeY: 1024, maxComputeWorkgroupStorageSize: 32768,
      }).map(([name, value]) => [name, Math.min(value, adapter.limits[name])])) : {};
      const device = await adapter.requestDevice({requiredFeatures: features, requiredLimits});
      globalThis.lumenProbeDevice = device;
      globalThis.lumenProbeErrors = [];
      device.addEventListener('uncapturederror', event => lumenProbeErrors.push(event.error.message));
      return {features, adapter: adapter.info, requiredLimits};
    }, pipelines);
    report.device = await initializeDevice();
    ++report.devices;
    const specializedBindings = new Set();
    for (const job of jobs) {
      if (pipelines && report.modules.length && report.modules.length % pipelineBatchSize === 0) {
        const deviceErrors = await page.evaluate(async () => {
          await lumenProbeDevice.queue.onSubmittedWorkDone();
          lumenProbeDevice.destroy();
          return lumenProbeErrors;
        });
        assert(!deviceErrors.length, deviceErrors.join('\n'));
        await initializeDevice();
        ++report.devices;
      }
      let code = job.code;
      for (const binding of job.metadata.spirvBindings.filter(item =>
        item.runtimeStorageFormat && storageFormats[item.name]).sort((a, b) => b.storageFormatOffset - a.storageFormatOffset)) {
        code = code.slice(0, binding.storageFormatOffset) + storageFormats[binding.name] +
          code.slice(binding.storageFormatOffset + binding.storageFormatLength);
        specializedBindings.add(binding.name);
      }
      const errors = await page.evaluate(async code => {
        const module = lumenProbeDevice.createShaderModule({code});
        const info = await module.getCompilationInfo();
        return info.messages.filter(message => message.type === 'error').map(message => message.message);
      }, code);
      report.modules.push({name: job.name, shader: job.shader, job: job.job, errors, sourceFiles: job.sourceFiles});
      assert(!errors.length, `${job.shader || job.name} (${job.job}): ${errors.join('\n')}`);
      if (pipelines && !errors.length && job.metadata.frequency === 5) {
        const pipelineErrors = await page.evaluate(async ({code, entryPoint}) => {
          lumenProbeDevice.pushErrorScope('validation');
          const module = lumenProbeDevice.createShaderModule({code});
          const errors = [];
          try {
            await lumenProbeDevice.createComputePipelineAsync({layout: 'auto', compute: {module, entryPoint}});
          } catch (error) { errors.push(error.message); }
          const validation = await lumenProbeDevice.popErrorScope();
          if (validation) errors.push(validation.message);
          return errors;
        }, {code, entryPoint: job.metadata.webEntry});
        report.pipelines.push({name: job.name, shader: job.shader, job: job.job, errors: pipelineErrors});
        assert(!pipelineErrors.length,
          `${job.shader || job.name} (${job.job}): ${pipelineErrors.join('\n')}`);
      }
    }
    for (const name of Object.keys(storageFormats))
      assert(specializedBindings.has(name), `No runtime storage binding matched ${name}`);
    assert(report.modules.every(item => !item.errors.length), 'Browser rejected a converted Lumen shader');
    assert(report.pipelines.every(item => !item.errors.length), 'Browser rejected a converted compute pipeline');
    if (modulesOnly) {
      report.pass = true;
      return;
    }
    const scene = jobs.find(job => job.name === 'FLumenSceneUpdateCS');
    const copy = jobs.find(job => job.name === 'FWebLumenCopyAdaptiveProbeHeaderCS');
    assert(scene && copy, 'Actual scene-update and adaptive-header UE shaders are required');
    report.execution = await page.evaluate(async ({scene, copy}) => {
      const device = lumenProbeDevice;
      const check = (value, message) => { if (!value) throw Error(message); };
      const makeBuffer = (bytes, usage) => {
        const buffer = device.createBuffer({size: bytes.byteLength, usage: usage | GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(buffer, 0, bytes);
        return buffer;
      };
      const uniforms = (binding, values) => {
        const bytes = new ArrayBuffer(binding.paddedSize);
        const view = new DataView(bytes);
        for (const member of binding.members) {
          const value = values[member.name];
          if (value === undefined) continue;
          if (Array.isArray(value)) value.forEach((item, index) => view.setFloat32(member.offset + index * 4, item, true));
          else if (/^(MaxScene|NumCamera|LumenCardScene_Num|WebAdaptive)/.test(member.name))
            view.setUint32(member.offset, value, true);
          else view.setFloat32(member.offset, value, true);
        }
        return makeBuffer(bytes, GPUBufferUsage.UNIFORM);
      };
      const readBuffer = async (encoder, source, size) => {
        const readback = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        encoder.copyBufferToBuffer(source, 0, readback, 0, size);
        return readback;
      };
      const results = [];
      for (const capacity of [258, 3]) {
        const count = 257;
        const primitiveBytes = new ArrayBuffer(count * 32);
        const floats = new Float32Array(primitiveBytes), uints = new Uint32Array(primitiveBytes);
        const added = [], removed = [];
        for (let index = 0; index < count; ++index) {
          const kind = index % 4, center = kind === 2 ? 1000 + index : 1 + index % 16;
          floats[index * 8] = center;
          uints[index * 8 + 3] = kind === 0 ? 0xffffffff : 17;
          floats[index * 8 + 4] = kind === 3 ? 0 : 1;
          floats[index * 8 + 5] = kind === 3 ? 0 : 1;
          floats[index * 8 + 6] = kind === 3 ? 0 : 1;
          uints[index * 8 + 7] = 1;
          if (kind === 0) added.push(index);
          if (kind === 2) removed.push(index);
        }
        const sentinel = 0xdeadbeef;
        const addData = new Uint32Array(capacity * 2 + 8).fill(sentinel);
        const removeData = new Uint32Array(capacity + 8).fill(sentinel);
        addData[0] = removeData[0] = 0;
        const addBuffer = makeBuffer(addData, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const removeBuffer = makeBuffer(removeData, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        const primitives = makeBuffer(primitiveBytes, GPUBufferUsage.STORAGE);
        const values = {MaxSceneAddOps: capacity, MaxSceneRemoveOps: capacity,
          WorldCameraOrigins: [0, 0, 0, 0, 0, 0, 0, 0], NumCameraOrigins: 1,
          CardMaxDistanceSq: 10000, CardTexelDensity: 1000, FarFieldCardMaxDistanceSq: 10000,
          FarFieldCardTexelDensity: 1, MinCardResolution: 0.5, LumenCardScene_NumPrimitiveGroups: count};
        const resources = {RWSceneAddOps: addBuffer, RWSceneRemoveOps: removeBuffer,
          LumenCardScene_PrimitiveGroupData: primitives};
        const module = device.createShaderModule({code: scene.code});
        const pipeline = await device.createComputePipelineAsync({layout: 'auto',
          compute: {module, entryPoint: scene.metadata.webEntry}});
        const buffers = [addBuffer, removeBuffer, primitives];
        const entries = scene.metadata.spirvBindings.map(binding => {
          check(binding.group === 0, 'Unexpected scene-update bind group');
          const buffer = binding.descriptorType === 6 ? uniforms(binding, values) : resources[binding.name];
          check(buffer, `Unexpected scene-update resource: ${binding.name}`);
          if (binding.descriptorType === 6) buffers.push(buffer);
          return {binding: binding.binding, resource: {buffer}};
        });
        const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries});
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        const workgroup = /@workgroup_size\((\d+)u?/.exec(scene.code);
        check(workgroup, 'Missing compiled scene-update workgroup size');
        pass.dispatchWorkgroups(Math.ceil(count / Number(workgroup[1])));
        pass.end();
        const addReadback = await readBuffer(encoder, addBuffer, addData.byteLength);
        const removeReadback = await readBuffer(encoder, removeBuffer, removeData.byteLength);
        device.queue.submit([encoder.finish()]);
        await Promise.all([addReadback.mapAsync(GPUMapMode.READ), removeReadback.mapAsync(GPUMapMode.READ)]);
        const addResult = new Uint32Array(addReadback.getMappedRange());
        const removeResult = new Uint32Array(removeReadback.getMappedRange());
        check(addResult[0] === added.length && removeResult[0] === removed.length, 'Scene operation count differs');
        check(addResult[1] === sentinel, 'Scene queue uint2 header padding overwritten');
        const seen = new Set();
        for (let item = 0; item < Math.min(added.length, capacity - 1); ++item) {
          const index = addResult[(item + 1) * 2];
          check(added.includes(index) && !seen.has(index), 'Invalid or duplicate added primitive');
          seen.add(index);
          const distanceBits = new Uint32Array(new Float32Array([(index % 16) ** 2]).buffer)[0];
          check(addResult[(item + 1) * 2 + 1] === distanceBits, 'Primitive ID/distance pair differs');
        }
        const removedResults = Array.from(removeResult.slice(1, 1 + Math.min(removed.length, capacity - 1)));
        check(new Set(removedResults).size === removedResults.length &&
          removedResults.every(index => removed.includes(index)), 'Invalid remove operation');
        check(Array.from(addResult.slice(capacity * 2)).every(value => value === sentinel) &&
          Array.from(removeResult.slice(capacity)).every(value => value === sentinel), 'Queue overflow wrote guard values');
        results.push({shader: scene.name, capacity, primitiveCount: count, additions: added.length,
          removals: removed.length, pairsAndOverflowGuardsVerified: true});
        addReadback.unmap(); removeReadback.unmap();
        [...buffers, addReadback, removeReadback].forEach(buffer => buffer.destroy());
      }
      for (const [width, height] of [[1, 1], [13, 9], [65, 37], [127, 68]]) {
        const data = Uint32Array.from({length: width * height}, (_, index) => (index * 17) ^ (Math.floor(index / width) * 1234));
        const source = makeBuffer(data, GPUBufferUsage.STORAGE);
        const texture = device.createTexture({size: [width, height], format: 'r32uint',
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC});
        const module = device.createShaderModule({code: copy.code});
        const pipeline = await device.createComputePipelineAsync({layout: 'auto',
          compute: {module, entryPoint: copy.metadata.webEntry}});
        const buffers = [source];
        const entries = copy.metadata.spirvBindings.map(binding => {
          let resource;
          if (binding.descriptorType === 6) {
            const buffer = uniforms(binding, {WebAdaptiveProbeHeaderSize: [width, height]});
            // The two-component size is uint2, not a floating-point array.
            device.queue.writeBuffer(buffer, binding.members[0].offset, new Uint32Array([width, height]));
            buffers.push(buffer); resource = {buffer};
          } else if (binding.descriptorType === 7) resource = {buffer: source};
          else if (binding.descriptorType === 3) resource = texture.createView();
          else throw Error('Unexpected copy resource');
          return {binding: binding.binding, resource};
        });
        const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries});
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        const readback = device.createBuffer({size: bytesPerRow * height,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
        encoder.copyTextureToBuffer({texture}, {buffer: readback, bytesPerRow}, [width, height]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const actual = new Uint32Array(readback.getMappedRange());
        for (let y = 0; y < height; ++y)
          for (let x = 0; x < width; ++x)
            check(actual[y * bytesPerRow / 4 + x] === data[y * width + x], 'Adaptive header row/edge differs');
        results.push({shader: copy.name, width, height, verifiedTexels: width * height});
        readback.unmap(); [...buffers, readback].forEach(buffer => buffer.destroy()); texture.destroy();
      }
      await device.queue.onSubmittedWorkDone();
      check(!lumenProbeErrors.length, lumenProbeErrors.join('\n'));
      return results;
    }, {scene, copy});
    report.pass = true;
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    report.boundary = (modulesOnly ? 'Real UE WGSL module validation' +
      (pipelines ? ' and compute pipeline creation. ' : ' only. ') :
      'Real UE WGSL module validation and GPU execution of scene Cards queues/adaptive-header copy. ') +
      'No full Cook, Surface Cache, GI pixels, scene performance or peak VRAM acceptance.';
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, modules: report.modules.length,
      pipelines: report.pipelines.length, execution: report.execution, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
