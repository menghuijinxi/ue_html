const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-texture-update-20261019-1454.json');
const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const readWriteReportFile = path.join(results, 'web-texture-update-cook-regression-results-texture-readwrite-20261019-1500.json');
const readWriteCookFile = path.join(results, 'web-engine-webgpu-es31-cook-results-texture-readwrite-20261019-1500.json');
const tintInfo = path.join(root, '.tools/dawn-v20261009.190412/bin/tint_info.exe');
const shaderSource = '/Engine/Private/UpdateTextureShaders.usf';
const report = {date: new Date().toISOString(), pass: false, conversionVerified: false,
  shaderGPUExecutionVerified: false, engineRHIIntegrationVerified: false,
  completeUEScene: false, recoveredJobs: [], browserRuns: [],
  sourceFiles: [__filename, tintInfo].map(audit)};

function makeCase(input, reflection, code) {
  const {metadata, shaderName} = input;
  assert.equal(reflection.entry_points.length, 1);
  const entry = reflection.entry_points[0];
  assert.equal(entry.name, metadata.webEntry);
  assert.equal(entry.stage, 'compute');
  assert.equal(entry.bindings.length, metadata.spirvBindings.length);
  const bindings = metadata.spirvBindings.map(binding => {
    const reflected = entry.bindings.find(item => item.group === binding.group && item.binding === binding.binding);
    assert(reflected && binding.group === 0);
    const expectedType = binding.descriptorType === 6 ? 'UniformBuffer' :
      binding.descriptorType === 7 ? binding.readOnlyStorage ? 'ReadOnlyStorageBuffer' : 'StorageBuffer' :
      'WriteOnlyStorageTexture';
    assert([3, 6, 7].includes(binding.descriptorType));
    assert.equal(reflected.resource_type, expectedType, binding.name);
    return {...binding, reflectedSize: reflected.size, reflected};
  });
  const find = name => {
    const binding = bindings.find(item => item.name === name);
    assert(binding, `${shaderName}: missing ${name}`);
    return binding;
  };
  const uniform = bindings.find(item => item.descriptorType === 6);
  if (uniform) uniform.data = Array(Math.max(16, uniform.paddedSize, uniform.reflectedSize) / 4).fill(0);
  const parameter = (name, values) => {
    const parameter = metadata.ueParameterMap.find(item => item.name === name && item.type === 0);
    assert(parameter && uniform && parameter.baseIndex % 4 === 0 && values.length * 4 <= parameter.size, name);
    uniform.data.splice(parameter.baseIndex / 4, values.length, ...values);
  };
  const initialize = (name, elements, value) => {
    const binding = find(name);
    assert.equal(binding.descriptorType, 7);
    assert([4, 16].includes(binding.storageElementStride));
    binding.data = Array.from({length: elements * binding.storageElementStride / 4},
      (_, index) => typeof value === 'function' ? value(index) : value);
    return binding;
  };
  const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];
  let dispatch;
  if (shaderName.startsWith('TCopyDataCS')) {
    assert.deepEqual(entry.workgroup_size, [64, 1, 1]);
    const elementsPerThread = shaderName === 'TCopyDataCS<2>' ? 2 : 1;
    const copied = 64 * elementsPerThread * 2;
    const source = initialize('SrcCopyBuffer', copied + 19, index => (0x12340000 + index * 17) >>> 0);
    const output = initialize('DestBuffer', copied + 19, 0x7c123456);
    assert.equal(source.storageElementStride, 16);
    assert.equal(output.storageElementStride, 16);
    source.expected = [...source.data];
    output.expected = [...output.data];
    output.expected.splice(0, copied * 4, ...source.data.slice(0, copied * 4));
    dispatch = [2, 1, 1];
  } else {
    assert.deepEqual(entry.workgroup_size, [8, 8, 1]);
    const volume = shaderName === 'FUpdateTexture3DSubresourceCS';
    const texture = find(volume ? 'DestTexture3D' : 'TDestTexture');
    assert.equal(texture.descriptorType, 3);
    const formats = {Rgba32Float: 'rgba32float', Rgba32Sint: 'rgba32sint', Rgba32Uint: 'rgba32uint'};
    texture.format = formats[texture.reflected.image_format];
    assert(texture.format);
    assert.equal(texture.reflected.dimensions, volume ? '3d' : '2d');
    texture.dimension = volume ? '3d' : '2d';
    texture.extent = volume ? [13, 9, 5] : [17, 11, 1];
    const [width, height, depth] = texture.extent;
    const sentinel = texture.format === 'rgba32float' ? bits(-7.5) : 0x81234567;
    texture.data = Array(width * height * depth * 4).fill(sentinel);
    texture.expected = [...texture.data];
    if (volume) {
      const size = [7, 5, 3], destination = [3, 2, 1], rowPitch = 11 * 4, slicePitch = rowPitch * 8;
      const source = initialize('SrcBuffer', slicePitch * size[2] + 19, index => (-131 + index * 7) >>> 0);
      assert.equal(source.storageElementStride, 4);
      source.expected = [...source.data];
      parameter('SrcDepthPitch', [slicePitch]);
      parameter('SrcPitch', [rowPitch, 4]);
      parameter('DestPos', [...destination, 0]);
      parameter('DestSize', [...size, 0]);
      for (let z = 0; z < size[2]; ++z)
        for (let y = 0; y < size[1]; ++y)
          for (let x = 0; x < size[0]; ++x) {
            const src = z * slicePitch + y * rowPitch + x * 4;
            const dst = (((z + destination[2]) * height + y + destination[1]) * width + x + destination[0]) * 4;
            texture.expected.splice(dst, 4, ...source.data.slice(src, src + 4));
          }
      dispatch = [Math.ceil(size[0] / 8), Math.ceil(size[1] / 8), size[2]];
    } else {
      const sourceOrigin = [2, 1], destination = [3, 2], size = [9, 7], rowPitch = 15;
      const source = initialize('TSrcBuffer', rowPitch * 10 + 19, index =>
        texture.format === 'rgba32float' ? bits(index * 0.125 - 13) :
          texture.format === 'rgba32sint' ? (-137 + index * 3) >>> 0 : (0x12340000 + index * 17) >>> 0);
      assert.equal(source.storageElementStride, 16);
      source.expected = [...source.data];
      parameter('TSrcPosPitch', [...sourceOrigin, rowPitch]);
      parameter('TDestPosSize', [...destination, ...size]);
      for (let y = 0; y < size[1]; ++y)
        for (let x = 0; x < size[0]; ++x) {
          const src = ((y + sourceOrigin[1]) * rowPitch + x + sourceOrigin[0]) * 4;
          const dst = ((y + destination[1]) * width + x + destination[0]) * 4;
          texture.expected.splice(dst, 4, ...source.data.slice(src, src + 4));
        }
      dispatch = [Math.ceil(size[0] / 8), Math.ceil(size[1] / 8), 1];
    }
  }
  assert(bindings.every(item => item.data?.length));
  return {shader: input.shader, code, entry: entry.name, bindings, dispatch, workgroup: entry.workgroup_size};
}

(async () => {
  let browser;
  try {
    const baseline = read(baselineFile), cook = read(cookFile);
    assert(valid(baseline.log) && valid(cook.log) && cook.sourceFiles.every(valid) &&
      cook.hostProducts.every(valid) && valid(cook.shaderSourcesReport));
    const shaderSources = read(cook.shaderSourcesReport.file);
    assert(shaderSources.pass && shaderSources.sourceFiles.every(valid) &&
      shaderSources.installedInputs.length === 13 && shaderSources.installedInputs.every(valid) &&
      shaderSources.files.every(item => sha(path.join(shaderSources.output, item.relative)) === item.sha256));
    const beforeInventory = baseline.shaderInventory.detail, afterInventory = cook.shaderInventory.detail;
    assert.deepEqual(afterInventory.settings, beforeInventory.settings);
    assert.deepEqual(afterInventory.types.filter(item => item.source === shaderSource),
      beforeInventory.types.filter(item => item.source === shaderSource));
    assert(cook.validateShaderJobCache && fs.readFileSync(cook.log.file, 'utf8')
      .includes('Set CVar [[r.ShaderCompiler.DebugValidateJobCache:1]]'));
    const prior = baseline.shaderFailures.filter(item => item.detail.source === shaderSource);
    assert(prior.every(item => valid(item.diagnostic) && item.detail.error.includes('SampledBuffer')));
    const jobs = new Set(prior.map(item => item.detail.shader));
    assert.equal(jobs.size, 6);
    const oldFailures = new Set(baseline.shaderFailures.map(item => item.detail.shader));
    const currentFailures = new Set(cook.shaderFailures.filter(item => item.detail.shader.startsWith('Global/'))
      .map(item => item.detail.shader));
    assert([...jobs].every(job => oldFailures.has(job) && !currentFailures.has(job)));
    assert([...currentFailures].every(job => oldFailures.has(job)));
    const cases = new Map(), observedJobs = new Map();
    for (const entry of fs.readdirSync(path.join(cook.output, 'ShaderConversion'), {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(cook.output, 'ShaderConversion', entry.name);
      const inputFile = path.join(directory, 'input.json');
      if (!fs.existsSync(inputFile)) continue;
      const input = read(inputFile), failed = fs.existsSync(path.join(directory, 'failure.json'));
      if (!input.shader.startsWith('Global/')) continue;
      const previous = observedJobs.get(input.shader);
      assert(previous === undefined || previous === !failed);
      observedJobs.set(input.shader, !failed);
      if (!jobs.has(input.shader)) continue;
      assert(!failed);
      const wgsl = path.join(directory, 'output.wgsl');
      const reflection = JSON.parse(cp.execFileSync(tintInfo, ['--json', wgsl], {encoding: 'utf8'}));
      const item = makeCase(input, reflection, fs.readFileSync(wgsl, 'utf8'));
      cases.set(input.shader, item);
      report.recoveredJobs.push({shader: input.shader, input: audit(inputFile),
        spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(wgsl),
        workgroup: item.workgroup, checkedValues: item.bindings.reduce((sum, binding) =>
          sum + (binding.expected?.length || 0), 0)});
    }
    assert.equal(cases.size, 6);
    assert.equal(report.recoveredJobs.length, 6);
    assert.equal(observedJobs.size, cook.shaderInventory.detail.permutations);
    const readWrite = read(readWriteReportFile);
    assert(!readWrite.pass && readWrite.conversionVerified && !readWrite.shaderGPUExecutionVerified);
    assert.equal(readWrite.cook.sha256, sha(readWriteCookFile));
    assert(valid(read(readWriteCookFile).log));
    assert(readWrite.browserRuns.length === 2 && readWrite.browserRuns.every(run =>
      run.checks.filter(item => !item.pass && /StorageTextureAccess::ReadWrite/.test(item.failure || '')).length === 4));
    const negativeCases = [];
    for (const item of cases.values()) {
      if (!item.bindings.some(binding => binding.descriptorType === 3)) continue;
      const previous = readWrite.recoveredJobs.find(candidate => candidate.shader === item.shader);
      assert(previous && valid(previous.input) && valid(previous.spirv) && valid(previous.wgsl));
      const input = read(previous.input.file);
      const reflection = JSON.parse(cp.execFileSync(tintInfo, ['--json', previous.wgsl.file], {encoding: 'utf8'}));
      assert(reflection.entry_points[0].bindings.some(binding =>
        binding.resource_type === 'ReadWriteStorageTexture'));
      negativeCases.push({...item, entry: input.metadata.webEntry,
        code: fs.readFileSync(previous.wgsl.file, 'utf8'), expectPipelineRejection: true});
    }
    assert.equal(negativeCases.length, 4);
    report.readWriteNegativeControl = audit(readWriteReportFile);
    report.readWriteCook = audit(readWriteCookFile);
    report.readWriteNegativeJobs = readWrite.recoveredJobs.filter(item =>
      negativeCases.some(candidate => candidate.shader === item.shader));
    report.observedUniqueJobs = observedJobs.size;
    report.observedSuccessfulUniqueJobs = [...observedJobs.values()].filter(Boolean).length;
    report.observedFailedUniqueJobs = [...observedJobs.values()].filter(value => !value).length;
    report.baseline = audit(baselineFile);
    report.cook = audit(cookFile);
    report.shaderSources = cook.shaderSourcesReport;
    report.shaderInventoryUnchanged = JSON.stringify(beforeInventory) === JSON.stringify(afterInventory);
    report.textureShaderInventoryUnchanged = true;
    report.otherPreviouslyFailedJobsNotRecorded = [...oldFailures]
      .filter(job => !currentFailures.has(job) && !jobs.has(job));
    report.conversionVerified = true;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/texture-update-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Texture update validation</title>'}));
      await page.goto('http://127.0.0.1:8765/texture-update-validation');
      const state = await page.evaluate(async cases => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU adapter unavailable');
        const device = await adapter.requestDevice();
        const errors = [], checks = [], negativeChecks = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        for (const item of cases) {
          const resources = [], readbacks = [];
          const check = {shader: item.shader, pass: false, checkedValues: 0, mismatches: []};
          let pipelineCreated = false;
          device.pushErrorScope('validation');
          try {
            const module = device.createShaderModule({label: item.shader, code: item.code});
            const info = await module.getCompilationInfo();
            const moduleErrors = info.messages.filter(item => item.type === 'error');
            if (moduleErrors.length) throw Error(moduleErrors.map(item => item.message).join('\n'));
            const pipeline = await device.createComputePipelineAsync({
              layout: 'auto', compute: {module, entryPoint: item.entry},
            });
            pipelineCreated = true;
            const entries = item.bindings.map(binding => {
              if (binding.descriptorType === 3) {
                const [width, height, depth] = binding.extent, rowBytes = width * 16;
                const bytesPerRow = Math.ceil(rowBytes / 256) * 256;
                const texture = device.createTexture({size: binding.extent, dimension: binding.dimension,
                  format: binding.format, usage: GPUTextureUsage.STORAGE_BINDING |
                    GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST});
                resources.push(texture);
                const upload = new Uint32Array(bytesPerRow * height * depth / 4);
                for (let z = 0; z < depth; ++z)
                  for (let y = 0; y < height; ++y)
                    upload.set(binding.data.slice((z * height + y) * width * 4,
                      (z * height + y + 1) * width * 4), (z * height + y) * bytesPerRow / 4);
                device.queue.writeTexture({texture}, upload, {bytesPerRow, rowsPerImage: height}, binding.extent);
                const readback = device.createBuffer({size: upload.byteLength,
                  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
                resources.push(readback);
                readbacks.push({binding, texture, readback, bytesPerRow});
                return {binding: binding.binding, resource: texture.createView()};
              }
              const size = binding.data.length * 4;
              const buffer = device.createBuffer({size, usage: GPUBufferUsage.COPY_DST |
                GPUBufferUsage.COPY_SRC | (binding.descriptorType === 6 ? GPUBufferUsage.UNIFORM : GPUBufferUsage.STORAGE)});
              resources.push(buffer);
              device.queue.writeBuffer(buffer, 0, new Uint32Array(binding.data));
              if (binding.expected) {
                const readback = device.createBuffer({size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
                resources.push(readback);
                readbacks.push({binding, buffer, readback, size});
              }
              return {binding: binding.binding, resource: {buffer}};
            });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries}));
            pass.dispatchWorkgroups(...item.dispatch);
            pass.end();
            for (const output of readbacks) {
              if (output.texture)
                encoder.copyTextureToBuffer({texture: output.texture},
                  {buffer: output.readback, bytesPerRow: output.bytesPerRow,
                    rowsPerImage: output.binding.extent[1]}, output.binding.extent);
              else encoder.copyBufferToBuffer(output.buffer, 0, output.readback, 0, output.size);
            }
            device.queue.submit([encoder.finish()]);
            for (const {binding, readback, bytesPerRow} of readbacks) {
              await readback.mapAsync(GPUMapMode.READ);
              const actual = new Uint32Array(readback.getMappedRange());
              for (let index = 0; index < binding.expected.length; ++index) {
                let offset = index;
                if (bytesPerRow) {
                  const rowWords = binding.extent[0] * 4;
                  offset = Math.floor(index / rowWords) * bytesPerRow / 4 + index % rowWords;
                }
                ++check.checkedValues;
                if (actual[offset] !== binding.expected[index] && check.mismatches.length < 8)
                  check.mismatches.push({resource: binding.name, index,
                    expected: binding.expected[index], actual: actual[offset]});
              }
              readback.unmap();
            }
          } catch (error) {
            check.failure = error.stack || error.message;
          }
          const validation = await device.popErrorScope();
          if (validation) check.validationError = validation.message;
          for (const resource of resources) resource.destroy();
          if (item.expectPipelineRejection) {
            check.pass = !pipelineCreated && /StorageTextureAccess::ReadWrite/.test(check.failure || '');
            negativeChecks.push(check);
            continue;
          }
          check.pass = check.checkedValues > 0 && check.mismatches.length === 0 &&
            !check.failure && !check.validationError;
          checks.push(check);
        }
        device.destroy();
        return {checks, negativeChecks, errors};
      }, [...cases.values(), ...negativeCases]);
      const run = {browser: name, version: browser.version(), ...state,
        pass: state.checks.length === 6 && state.checks.every(item => item.pass) &&
          state.negativeChecks.length === 4 && state.negativeChecks.every(item => item.pass) &&
          state.errors.length === 0};
      report.browserRuns.push(run);
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.every(item => item.pass));
    report.shaderGPUExecutionVerified = true;
    report.pass = true;
    report.boundary = 'Runs six previously failing real ES31 Cook shaders directly in browser WebGPU. Checks exact buffer copies, float/int/uint 2D subrects, signed 3D updates, pitched sources, untouched destination regions and unchanged input buffers. Shader declarations retain original parameters, indexing and workgroups. This does not exercise Engine RHI dispatch, texture upload integration, shader-map loading or a scene. No new RHI texture/view formats are enabled. Browser Engine runtime remains SM5.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-texture-update-cook-regression-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, conversionVerified: report.conversionVerified,
      shaderGPUExecutionVerified: report.shaderGPUExecutionVerified, recoveredJobs: report.recoveredJobs.length,
      observedUniqueJobs: report.observedUniqueJobs, observedFailedUniqueJobs: report.observedFailedUniqueJobs,
      browserRuns: report.browserRuns.map(run => ({browser: run.browser, pass: run.pass,
        cases: run.checks.length, checkedValues: run.checks.reduce((sum, item) => sum + item.checkedValues, 0),
        negativeControls: run.negativeChecks.length, failures: run.checks.filter(item => !item.pass),
        negativeFailures: run.negativeChecks.filter(item => !item.pass), errors: run.errors})),
      failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
