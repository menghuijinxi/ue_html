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
const sources = new Set(['ClearReplacementShaders', 'ByteBuffer', 'CopyUIntBuffer']
  .map(name => `/Engine/Private/${name}.usf`));
const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-buffer-shaders-20261019-1420.json');
const indirectBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-indirect-args-20261019-1629.json');
const indirectNames = new Set(['FClearIndirectDispatchArgsCS', 'FBuildIndirectDispatchArgsBufferCS',
  'FInitIndirectArgs1DCS', 'FClearUAVBuildIndirectDispatchBufferCS']);
const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const tintInfo = path.join(root, '.tools/dawn-v20261009.190412/bin/tint_info.exe');
const report = {date: new Date().toISOString(), pass: false, conversionVerified: false,
  shaderGPUExecutionVerified: false, engineRHIIntegrationVerified: false,
  completeUEScene: false, recoveredJobs: [], browserRuns: [],
  sourceFiles: [__filename, tintInfo].map(audit)};

function makeCase(input, reflection, code, scenario = 0) {
  const {metadata, shaderName} = input;
  const entry = reflection.entry_points[0];
  const workgroup = entry.workgroup_size;
  assert(workgroup[0] > 0 && workgroup[1] === 1 && workgroup[2] === 1);
  assert.equal(entry.name, metadata.webEntry);
  assert.equal(entry.bindings.length, metadata.spirvBindings.length);
  const buffers = metadata.spirvBindings.map(binding => {
    const reflected = entry.bindings.find(item => item.group === binding.group && item.binding === binding.binding);
    assert(reflected && binding.group === 0 && [6, 7].includes(binding.descriptorType));
    assert.equal(reflected.resource_type, binding.descriptorType === 6 ? 'UniformBuffer' :
      binding.readOnlyStorage ? 'ReadOnlyStorageBuffer' : 'StorageBuffer');
    return {...binding, reflectedSize: reflected.size};
  });
  const buffer = name => {
    const found = buffers.find(item => item.name === name);
    assert(found, `${shaderName}: missing buffer ${name}`);
    return found;
  };
  const uniform = buffers.find(item => item.descriptorType === 6);
  if (uniform) uniform.data = Array(Math.max(16, uniform.paddedSize, uniform.reflectedSize) / 4).fill(0);
  const bits = value => new Uint32Array(new Float32Array([value]).buffer)[0];
  const parameter = (name, values) => {
    const item = metadata.ueParameterMap.find(item => item.name === name && item.type === 0);
    assert(item && uniform && item.baseIndex % 4 === 0 && values.length * 4 <= item.size,
      `${shaderName}: parameter layout ${name}`);
    uniform.data.splice(item.baseIndex / 4, values.length, ...values);
  };
  const initialize = (name, count, value) => {
    const item = buffer(name);
    assert([4, 16].includes(item.storageElementStride));
    item.data = Array.from({length: count * item.storageElementStride / 4},
      (_, index) => typeof value === 'function' ? value(index) : value);
    return item;
  };
  let dispatch;
  if (shaderName.startsWith('FClearReplacementCS_')) {
    const bounded = shaderName.endsWith('_Bounds');
    const zero = shaderName.endsWith('_Zero');
    const float = /_Float/.test(shaderName);
    const signed = /_Sint/.test(shaderName);
    const first = bounded ? 7 : 0;
    const count = bounded ? workgroup[0] + 13 : workgroup[0] * 2;
    const output = initialize('ClearResource', first + count + 19, 0x7c123456);
    output.expected = [...output.data];
    const width = output.storageElementStride / 4;
    const values = Array.from({length: width}, (_, index) => zero ? 0 :
      float ? bits((index + 1) * 0.25) : signed ? (-13 - index) >>> 0 : 0x12340000 + index);
    if (!zero) parameter('ClearValue', values);
    if (bounded) {
      parameter('MinBounds', [first, 0, 0, 0]);
      parameter('MaxBounds', [first + count, 1, 1, 0]);
    }
    for (let index = first; index < first + count; ++index)
      output.expected.splice(index * width, width, ...values);
    dispatch = Math.ceil(count / workgroup[0]);
  } else if (shaderName.includes('MemsetBufferCS')) {
    const offset = 11, count = 79;
    const output = initialize('DstBuffer', offset + count + 23, 0x7c123456);
    output.expected = [...output.data];
    output.expected.fill(bits(0.5), offset * 4, (offset + count) * 4);
    parameter('Value', [bits(0.5)]);
    parameter('Size', [count]);
    parameter('DstOffset', [offset]);
    dispatch = Math.ceil(count / workgroup[0]);
  } else if (shaderName.includes('MemcpyCS')) {
    const source = initialize('SrcBuffer', 137, index => bits(index * 0.25 + 1));
    const output = initialize('DstBuffer', 149, 0x7c123456);
    const src = 7, dst = 11, count = 79;
    output.expected = [...output.data];
    output.expected.splice(dst * 4, count * 4, ...source.data.slice(src * 4, (src + count) * 4));
    parameter('Size', [count]);
    parameter('SrcOffset', [src]);
    parameter('DstOffset', [dst]);
    dispatch = Math.ceil(count / workgroup[0]);
  } else if (shaderName.includes('ScatterCopyCS')) {
    const size = 3, scatters = [7, 1, 9, 4], offset = 2;
    initialize('ScatterStructuredBuffer', scatters.length, index => scatters[index]);
    const source = initialize('UploadStructuredBuffer4x', scatters.length * size,
      index => bits(index * 0.25 + 1));
    const output = initialize('DstBuffer', 40, 0x7c123456);
    output.expected = [...output.data];
    for (let thread = offset; thread < scatters.length * size; ++thread) {
      const destination = scatters[Math.floor(thread / size)] * size + thread % size;
      output.expected.splice(destination * 4, 4, ...source.data.slice(thread * 4, thread * 4 + 4));
    }
    parameter('Size', [size]);
    parameter('NumScatters', [scatters.length]);
    parameter('SrcOffset', [offset]);
    dispatch = Math.ceil((scatters.length * size - offset) / workgroup[0]);
  } else if (shaderName === 'FCopyUIntBufferCS') {
    const source = initialize('SourceData', 111, index => 0x12340000 + index);
    const limits = [31, 67, 93], first = 7;
    for (let destination = 0; destination < 3; ++destination) {
      const output = initialize(`DestData${destination}`, 111, 0x7c123456);
      output.expected = [...output.data];
      const start = Math.max(first, destination ? limits[destination - 1] : 0);
      output.expected.splice(start, limits[destination] - start,
        ...source.data.slice(start, limits[destination]));
    }
    parameter('CopyParams', [first, ...limits]);
    dispatch = Math.ceil((limits[2] - first) / workgroup[0]);
  } else if (shaderName === 'FClearIndirectDispatchArgsCS') {
    const count = [67, 1, 0][scenario], stride = [5, 3, 7][scenario];
    const dimensions = scenario === 1 ? [0, 0, 0] : [2, 3, 1];
    const output = initialize('OutIndirectArgsBuffer', Math.max(1, count) * stride + 11, 0x7c123456);
    output.expected = [...output.data];
    for (let index = 0; index < count; ++index)
      output.expected.splice(index * stride, stride, ...dimensions, ...Array(stride - 3).fill(0));
    output.indirect = [...new Set(count ? [0, count - 1] : [])]
      .map(index => ({offset: index * stride * 4, dimensions}));
    parameter('NumIndirectArgs', [count]);
    parameter('IndirectArgStride', [stride]);
    parameter('DimClearValue', dimensions);
    dispatch = Math.max(1, Math.ceil(count / workgroup[0]));
  } else if (shaderName === 'FInitIndirectArgs1DCS') {
    const count = [77, 0, 1][scenario], multiplier = [3, 7, 1][scenario], divisor = [8, 3, 1][scenario];
    const source = initialize('InputCountBuffer', 9, 0x12345678);
    source.data[3] = count;
    source.expected = [...source.data];
    const dimensions = [Math.ceil(count * multiplier / divisor), 1, 1];
    const output = initialize('IndirectDispatchArgsOut', 14, 0x7c123456);
    output.expected = [...output.data];
    output.expected.splice(0, 3, ...dimensions);
    output.indirect = [{offset: 0, dimensions}];
    parameter('Multiplier', [multiplier]);
    parameter('Divisor', [divisor]);
    parameter('InputCountOffset', [3]);
    dispatch = 1;
  } else if (shaderName === 'FBuildIndirectDispatchArgsBufferCS' ||
      shaderName === 'FClearUAVBuildIndirectDispatchBufferCS') {
    const mip = shaderName === 'FBuildIndirectDispatchArgsBufferCS';
    const count = mip ? [10, 10, 0][scenario] : 1;
    const enabled = scenario !== 1;
    const size = scenario === 2 ? [1, 1] : mip ? [257, 65] : [17, 9];
    const source = initialize('ConditionBuffer', 9, 0x12345678);
    source.data[3] = enabled ? 7 : 0;
    source.expected = [...source.data];
    const output = initialize('RWIndirectDispatchArgsBuffer', Math.max(1, count) * 3 + 11, 0x7c123456);
    output.expected = [...output.data];
    output.indirect = [];
    for (let index = 0; index < count; ++index) {
      const dimensions = enabled ? [
        Math.ceil((mip ? Math.max(size[0] >>> (index + 1), 1) : size[0]) / 8),
        Math.ceil((mip ? Math.max(size[1] >>> (index + 1), 1) : size[1]) / 8), 1] : [0, 0, 0];
      output.expected.splice(index * 3, 3, ...dimensions);
      output.indirect.push({offset: index * 12, dimensions});
    }
    parameter(mip ? 'TextureSize' : 'ViewportSize', size);
    parameter('Offset', [3]);
    if (mip) parameter('NumMips', [count]);
    dispatch = Math.max(1, Math.ceil(count / workgroup[0]));
  } else {
    throw Error(`Uncovered recovered shader: ${shaderName}`);
  }
  assert(buffers.every(item => item.data?.length > 0));
  return {shader: input.shader, shaderName, scenario, code, entry: entry.name, buffers, workgroup, dispatch};
}

(async () => {
  let browser;
  try {
    const baseline = read(baselineFile), indirectBaseline = read(indirectBaselineFile), cook = read(cookFile);
    assert(valid(baseline.log) && valid(cook.log) && cook.sourceFiles.every(valid) &&
      cook.hostProducts.every(valid) && valid(cook.shaderSourcesReport));
    const shaderSources = read(cook.shaderSourcesReport.file);
    assert(shaderSources.pass && shaderSources.sourceFiles.every(valid) &&
      shaderSources.installedInputs.length === 13 && shaderSources.installedInputs.every(valid) &&
      shaderSources.files.every(item => sha(path.join(shaderSources.output, item.relative)) === item.sha256));
    const previous = baseline.shaderFailures.filter(item => sources.has(item.detail.source));
    assert(previous.every(item => valid(item.diagnostic) && item.detail.error.includes('SampledBuffer')));
    const originalJobs = [...new Set(previous.map(item => item.detail.shader))];
    assert.equal(originalJobs.length, 22);
    assert(valid(indirectBaseline.log) && valid(indirectBaseline.shaderInventory.artifact));
    const indirectFailures = new Map(indirectBaseline.shaderFailures
      .filter(item => indirectNames.has(item.detail.shaderName)).map(item => [item.detail.shader, item]));
    assert.equal(indirectFailures.size, 4);
    assert([...indirectFailures.values()].every(item => valid(item.diagnostic) &&
      item.detail.error.includes('SampledBuffer')));
    assert.deepEqual(cook.shaderInventory.detail.types.filter(item => indirectNames.has(item.name)),
      indirectBaseline.shaderInventory.detail.types.filter(item => indirectNames.has(item.name)),
      'Indirect buffer shader eligibility must remain unchanged');
    assert.deepEqual(cook.shaderInventory.detail.settings, indirectBaseline.shaderInventory.detail.settings);
    const jobs = [...originalJobs, ...indirectFailures.keys()];
    assert(cook.validateShaderJobCache && fs.readFileSync(cook.log.file, 'utf8')
      .includes('Set CVar [[r.ShaderCompiler.DebugValidateJobCache:1]]'));
    const before = baseline.shaderInventory.detail, after = cook.shaderInventory.detail;
    assert.equal(after.registeredTypes, before.registeredTypes);
    assert.deepEqual(after.settings, before.settings);
    const bufferTypes = inventory => inventory.types.filter(item => sources.has(item.source));
    assert.deepEqual(bufferTypes(after), bufferTypes(before),
      'Recovered buffer shaders must retain their original eligibility');
    assert(!cook.shaderFailures.some(item => jobs.includes(item.detail.shader)));
    const candidates = new Map();
    const observedJobs = new Map();
    for (const entry of fs.readdirSync(path.join(cook.output, 'ShaderConversion'), {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(cook.output, 'ShaderConversion', entry.name);
      const inputFile = path.join(directory, 'input.json');
      if (!fs.existsSync(inputFile)) continue;
      const input = read(inputFile);
      if (!input.shader.startsWith('Global/')) continue;
      const failed = fs.existsSync(path.join(directory, 'failure.json'));
      const previousState = observedJobs.get(input.shader);
      assert(previousState === undefined || previousState === !failed, input.shader);
      observedJobs.set(input.shader, !failed);
      if (!jobs.includes(input.shader) || failed) continue;
      if (candidates.has(input.shader)) continue;
      const wgsl = path.join(directory, 'output.wgsl');
      const reflection = JSON.parse(cp.execFileSync(tintInfo, ['--json', wgsl], {encoding: 'utf8'}));
      const items = Array.from({length: indirectNames.has(input.shaderName) ? 3 : 1},
        (_, scenario) => makeCase(input, reflection, fs.readFileSync(wgsl, 'utf8'), scenario));
      candidates.set(input.shader, items);
      report.recoveredJobs.push({shader: input.shader, input: audit(inputFile),
        spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(wgsl),
        indirectArgs: indirectNames.has(input.shaderName), scenarios: items.length,
        workgroup: items[0].workgroup, checkedValues: items.reduce((sum, item) =>
          sum + item.buffers.reduce((count, buffer) => count + (buffer.expected?.length || 0), 0), 0)});
    }
    assert(jobs.every(job => candidates.has(job)), `Missing real Cook outputs: ${jobs.filter(job => !candidates.has(job))}`);
    assert.equal(candidates.size, 26);
    assert.equal(observedJobs.size, cook.shaderInventory.detail.permutations);
    report.observedUniqueJobs = observedJobs.size;
    report.observedSuccessfulUniqueJobs = [...observedJobs.values()].filter(Boolean).length;
    report.observedFailedUniqueJobs = [...observedJobs.values()].filter(value => !value).length;
    report.baseline = audit(baselineFile);
    report.indirectBaseline = audit(indirectBaselineFile);
    report.indirectRecoveredJobs = [...indirectFailures.keys()];
    report.indirectShaderInventoryUnchanged = true;
    const previousFailures = new Set(indirectBaseline.shaderFailures.map(item => item.detail.shader));
    const currentFailures = new Set(cook.shaderFailures.filter(item => item.detail.shader.startsWith('Global/'))
      .map(item => item.detail.shader));
    assert([...indirectFailures.keys()].every(name => !currentFailures.has(name)));
    report.otherPreviouslyFailedJobsNotRecorded = [...previousFailures]
      .filter(name => !currentFailures.has(name) && !indirectFailures.has(name));
    assert([...currentFailures].every(name => previousFailures.has(name)), 'New conversion failures');
    const cases = [...candidates.values()].flat();
    const indirectDispatches = cases.reduce((sum, item) => sum +
      item.buffers.reduce((count, binding) => count + (binding.indirect?.length || 0), 0), 0);
    report.cook = audit(cookFile);
    report.shaderSources = cook.shaderSourcesReport;
    report.conversionVerified = true;
    report.allPreviouslyFailedJobsRecompiled = true;
    report.shaderInventoryUnchanged = JSON.stringify(after) === JSON.stringify(before);
    report.bufferShaderInventoryUnchanged = true;
    report.eligiblePermutations = cook.shaderInventory.detail.permutations;
    report.currentDistinctFailedJobs = currentFailures.size;
    report.materialFailureDiagnosticsOutsideGlobalInventory = cook.shaderFailures
      .filter(item => !item.detail.shader.startsWith('Global/')).length;
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/buffer-cook-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Buffer Cook validation</title>'}));
      await page.goto('http://127.0.0.1:8765/buffer-cook-validation');
      const state = await page.evaluate(async cases => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU adapter unavailable');
        const largestWorkgroup = Math.max(...cases.map(item => item.workgroup[0]));
        const device = await adapter.requestDevice({requiredLimits: {
          maxComputeWorkgroupSizeX: largestWorkgroup,
          maxComputeInvocationsPerWorkgroup: largestWorkgroup,
        }});
        const errors = [], checks = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        const indirectProbe = await device.createComputePipelineAsync({layout: 'auto', compute: {
          module: device.createShaderModule({code: `
            @group(0) @binding(0) var<storage, read_write> counts: array<atomic<u32>>;
            @compute @workgroup_size(1) fn main() { atomicAdd(&counts[0], 1u); }
          `}), entryPoint: 'main',
        }});
        for (const item of cases) {
          const resources = [];
          const check = {shader: item.shader, scenario: item.scenario, pass: false,
            checkedValues: 0, indirectDispatches: 0, mismatches: []};
          device.pushErrorScope('validation');
          try {
            const module = device.createShaderModule({label: item.shader, code: item.code});
            const info = await module.getCompilationInfo();
            const moduleErrors = info.messages.filter(item => item.type === 'error');
            if (moduleErrors.length) throw Error(moduleErrors.map(item => item.message).join('\n'));
            const pipeline = await device.createComputePipelineAsync({
              layout: 'auto', compute: {module, entryPoint: item.entry},
            });
            const readbacks = [];
            const boundBuffers = new Map();
            const entries = item.buffers.map(binding => {
              const size = binding.data.length * 4;
              const usage = binding.descriptorType === 6 ? GPUBufferUsage.UNIFORM :
                GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
              const buffer = device.createBuffer({size, usage: usage | GPUBufferUsage.COPY_DST |
                (binding.indirect ? GPUBufferUsage.INDIRECT : 0)});
              boundBuffers.set(binding.name, buffer);
              resources.push(buffer);
              device.queue.writeBuffer(buffer, 0, new Uint32Array(binding.data));
              if (binding.expected) {
                const readback = device.createBuffer({size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
                resources.push(readback);
                readbacks.push({buffer, readback, size, binding});
              }
              return {binding: binding.binding, resource: {buffer}};
            });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries}));
            pass.dispatchWorkgroups(item.dispatch);
            pass.end();
            for (const binding of item.buffers) {
              for (const spec of binding.indirect || []) {
                const counter = device.createBuffer({size: 16,
                  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
                const readback = device.createBuffer({size: 16,
                  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
                resources.push(counter, readback);
                device.queue.writeBuffer(counter, 0, new Uint32Array([0, 0x7c123456, 0x7c123456, 0x7c123456]));
                const probe = encoder.beginComputePass();
                probe.setPipeline(indirectProbe);
                probe.setBindGroup(0, device.createBindGroup({layout: indirectProbe.getBindGroupLayout(0),
                  entries: [{binding: 0, resource: {buffer: counter}}]}));
                probe.dispatchWorkgroupsIndirect(boundBuffers.get(binding.name), spec.offset);
                probe.end();
                readbacks.push({buffer: counter, readback, size: 16,
                  binding: {name: `${binding.name}.dispatch@${spec.offset}`,
                    expected: [spec.dimensions.reduce((product, value) => product * value, 1),
                      0x7c123456, 0x7c123456, 0x7c123456]}});
                ++check.indirectDispatches;
              }
            }
            for (const {buffer, readback, size} of readbacks)
              encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
            device.queue.submit([encoder.finish()]);
            for (const {readback, binding} of readbacks) {
              await readback.mapAsync(GPUMapMode.READ);
              const actual = new Uint32Array(readback.getMappedRange());
              for (let index = 0; index < binding.expected.length; ++index) {
                ++check.checkedValues;
                if (actual[index] !== binding.expected[index] && check.mismatches.length < 8)
                  check.mismatches.push({buffer: binding.name, index,
                    expected: binding.expected[index], actual: actual[index]});
              }
              readback.unmap();
            }
          } catch (error) {
            check.failure = error.stack || error.message;
          }
          const validation = await device.popErrorScope();
          if (validation) check.validationError = validation.message;
          for (const resource of resources) resource.destroy();
          check.pass = check.checkedValues > 0 && check.mismatches.length === 0 &&
            !check.failure && !check.validationError;
          checks.push(check);
        }
        device.destroy();
        return {checks, errors,
          deviceMaxComputeWorkgroupSizeX: device.limits.maxComputeWorkgroupSizeX,
          deviceMaxComputeInvocationsPerWorkgroup: device.limits.maxComputeInvocationsPerWorkgroup};
      }, cases);
      const run = {browser: name, version: browser.version(), ...state,
        pass: state.checks.length === cases.length && state.checks.every(item => item.pass) &&
          state.checks.reduce((sum, item) => sum + item.indirectDispatches, 0) === indirectDispatches &&
          state.errors.length === 0};
      report.browserRuns.push(run);
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.every(item => item.pass));
    report.shaderGPUExecutionVerified = true;
    report.indirectDispatchGPUExecutionVerified = true;
    report.indirectDispatchesPerBrowser = indirectDispatches;
    report.pass = true;
    report.boundary = 'Executes 26 previously failing real ES31 Cook outputs: the prior 22 buffer jobs and four indirect-argument jobs with three scenarios each. Tests bounds, offsets, guards, zero/enabled conditions, padded strides and non-power-of-two mip dimensions. Generated argument buffers drive real dispatchWorkgroupsIndirect calls with atomic invocation-count readback. Subsurface validation covers its argument builder only. The test device requests 512 invocations for LargeBuffer; Engine device limit negotiation remains separate. Does not exercise Engine RHI, shader-map loading or a scene. Browser Engine runtime remains SM5.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-buffer-cook-regression-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, conversionVerified: report.conversionVerified,
      shaderGPUExecutionVerified: report.shaderGPUExecutionVerified, recoveredJobs: report.recoveredJobs.length,
      currentDistinctFailedJobs: report.currentDistinctFailedJobs,
      browserRuns: report.browserRuns.map(run => ({browser: run.browser, pass: run.pass,
        cases: run.checks.length, checkedValues: run.checks.reduce((count, item) => count + item.checkedValues, 0),
        failures: run.checks.filter(item => !item.pass), errors: run.errors})), failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
