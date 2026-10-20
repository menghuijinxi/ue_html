const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-finite-capture-shadow-20261020-1008.json');
const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const names = new Set(['FSceneCapturePS', 'FScreenSpaceShadowsUpsamplePS']);
const report = {date: new Date().toISOString(), pass: false, conversionVerified: false,
  shaderGPUExecutionVerified: false, engineRHIIntegrationVerified: false, completeUEScene: false,
  sourceFiles: [audit(__filename)], recoveredJobs: [], retainedJobs: [], browserRuns: []};

function nonfiniteConstants(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length % 4, 0);
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  assert.equal(words[0], 0x07230203);
  const types = new Map(), found = [];
  for (let offset = 5; offset < words.length;) {
    const size = words[offset] >>> 16, opcode = words[offset] & 65535;
    assert(size > 0 && offset + size <= words.length);
    if (opcode === 22) types.set(words[offset + 1], words[offset + 2]);
    if ([43, 50].includes(opcode) && types.get(words[offset + 1]) === 32 &&
        (words[offset + 3] & 0x7f800000) === 0x7f800000) found.push(words[offset + 3]);
    offset += size;
  }
  return found;
}

(async () => {
  let browser;
  try {
    const baseline = read(baselineFile), cook = read(cookFile);
    assert(valid(baseline.log) && valid(baseline.shaderInventory.artifact));
    assert(valid(cook.log) && valid(cook.shaderInventory.artifact) &&
      cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && cook.validateShaderJobCache);
    assert.deepEqual(cook.shaderInventory.detail.settings, baseline.shaderInventory.detail.settings);
    const beforeTypes = new Map(baseline.shaderInventory.detail.types.map(type => [type.name, type]));
    for (const type of cook.shaderInventory.detail.types) {
      const prior = beforeTypes.get(type.name);
      assert(prior);
      assert.deepEqual(type, type.name === 'FGenerateConservativeDepthBufferCS' ?
        {...prior, permutations: 0} : prior,
      'Only the unused volumetric-fog depth generator may change eligibility');
    }
    assert(valid(cook.shaderSourcesReport));
    const sources = read(cook.shaderSourcesReport.file);
    assert(sources.pass && sources.sourceFiles.every(valid) &&
      sources.installedInputs.length === 13 && sources.installedInputs.every(valid) &&
      sources.files.every(item => sha(path.join(sources.output, item.relative)) === item.sha256));
    const failed = new Map(baseline.shaderFailures.map(item => [item.detail.shader, item]));
    assert.equal(failed.size, 2);
    assert([...failed.values()].every(item => valid(item.diagnostic) && names.has(item.detail.shaderName)));
    const oldCapture = [...failed.values()].find(item => item.detail.shaderName === 'FSceneCapturePS');
    const oldShadow = [...failed.values()].find(item => item.detail.shaderName === 'FScreenSpaceShadowsUpsamplePS');
    assert(oldCapture.detail.error.includes('zero length vector can not be normalized'));
    assert(oldShadow.detail.error.includes('std::isfinite'));
    assert(nonfiniteConstants(path.join(path.dirname(oldShadow.diagnostic.file), 'input.spv')).length > 0);
    report.previousFailures = [...failed.values()];
    const jobs = new Map();
    for (const entry of fs.readdirSync(path.join(cook.output, 'ShaderConversion'), {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(cook.output, 'ShaderConversion', entry.name);
      const file = path.join(directory, 'input.json');
      if (!fs.existsSync(file)) continue;
      const input = read(file);
      if (!names.has(input.shaderName) || jobs.has(input.shader)) continue;
      assert(!fs.existsSync(path.join(directory, 'failure.json')), input.shader);
      const job = {shader: input.shader, name: input.shaderName, input: audit(file),
        spirv: audit(path.join(directory, 'input.spv')), wgsl: audit(path.join(directory, 'output.wgsl'))};
      assert.deepEqual(nonfiniteConstants(job.spirv.file), [], input.shader);
      jobs.set(input.shader, job);
      (failed.has(input.shader) ? report.recoveredJobs : report.retainedJobs).push(job);
    }
    assert.equal(jobs.size, 10);
    assert.equal(report.recoveredJobs.length, 2);
    assert.equal(report.retainedJobs.length, 8);
    assert(!cook.shaderFailures.some(item => names.has(item.detail.shaderName)));
    report.baseline = audit(baselineFile);
    report.cook = audit(cookFile);
    report.shaderSources = cook.shaderSourcesReport;
    report.shaderInventoryUnchanged = false;
    report.numericalShaderEligibilityUnchanged = true;
    report.conversionVerified = true;
    const modules = [...jobs.values()].map(job => ({...read(job.input.file),
      recovered: failed.has(job.shader), code: fs.readFileSync(job.wgsl.file, 'utf8')}));
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/finite-capture-shadow-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Finite capture and shadow validation</title>'}));
      await page.goto('http://127.0.0.1:8765/finite-capture-shadow-validation');
      const state = await page.evaluate(async modules => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU adapter unavailable');
        const device = await adapter.requestDevice();
        const errors = [], checks = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        const vertex = device.createShaderModule({code: `
          @vertex fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
            return vec4f(positions[i], 0, 1);
          }`});
        for (const item of modules) {
          device.pushErrorScope('validation');
          const module = device.createShaderModule({label: item.shader, code: item.code});
          const info = await module.getCompilationInfo();
          errors.push(...info.messages.filter(m => m.type === 'error').map(m => `${item.shader}: ${m.message}`));
          const error = await device.popErrorScope();
          if (error) errors.push(error.message);
          if (!item.recovered) continue;
          const capture = item.shaderName === 'FSceneCapturePS';
          const scenarios = capture ? ['zero-normal'] : ['bilateral-depth', 'constant-shadow', 'no-valid-corners'];
          for (const scenario of scenarios) {
            device.pushErrorScope('validation');
            const resources = [];
            const pipeline = await device.createRenderPipelineAsync({
              layout: 'auto', vertex: {module: vertex, entryPoint: 'main'},
              fragment: {module, entryPoint: item.metadata.webEntry, targets: [{format: 'rgba32float'}]},
            });
            const texels = scenario === 'bilateral-depth' ?
              [[0.25, 10], [0.5625, -20], [1, 0], [1, 30]] :
              scenario === 'constant-shadow' ? Array(4).fill([0.25, 16]) : Array(4).fill([1, 0]);
            const entries = new Map();
            for (const binding of item.metadata.spirvBindings) {
              let resource;
              if (binding.descriptorType === 6) {
                const bytes = new ArrayBuffer(Math.max(16, Math.ceil(binding.size / 16) * 16));
                const floats = new Float32Array(bytes), ints = new Int32Array(bytes);
                for (const member of binding.members) {
                  const values = {
                    ScissorRectMinAndSize: [0, 0, 4, 4],
                    ShadowFactorsUVBilinearMax: [0.75, 0.75],
                    OneOverDownsampleFactor: [0.5],
                    View_BufferSizeAndInvSize: [4, 4, 0.25, 0.25],
                    View_InvDeviceZToWorldZTransform: [0, 15, 0, -1],
                  }[member.name];
                  if (!values) throw Error(`Uncovered uniform: ${member.name}`);
                  (member.name === 'ScissorRectMinAndSize' ? ints : floats).set(values, member.offset / 4);
                }
                const buffer = device.createBuffer({size: bytes.byteLength,
                  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
                device.queue.writeBuffer(buffer, 0, bytes);
                resources.push(buffer);
                resource = {buffer};
              } else if (binding.descriptorType === 2) {
                const shadow = binding.name === 'ShadowFactorsTexture';
                if (!shadow && binding.name !== 'MobileSceneTextures_SceneDepthTexture') {
                  throw Error(`Uncovered texture: ${binding.name}`);
                }
                const size = shadow ? 2 : 1;
                const texture = device.createTexture({size: [size, size], format: 'rgba16float',
                  usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
                const data = new Uint16Array(size * size * 4);
                // All fixture values are exactly representable half floats.
                const half = value => {
                  if (value === 0) return 0;
                  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
                  return ((bits >>> 16) & 0x8000) | ((((bits >>> 23) & 255) - 112) << 10) |
                    ((bits >>> 13) & 1023);
                };
                for (let i = 0; i < size * size; ++i) {
                  data[i * 4] = half(shadow ? texels[i][0] : 0.5);
                  data[i * 4 + 1] = half(shadow ? texels[i][1] : 0);
                }
                device.queue.writeTexture({texture}, data, {bytesPerRow: size * 8}, [size, size]);
                resources.push(texture);
                resource = texture.createView();
              } else if (binding.descriptorType === 0) {
                resource = device.createSampler();
              } else {
                throw Error(`Uncovered descriptor: ${binding.descriptorType}`);
              }
              if (!entries.has(binding.group)) entries.set(binding.group, []);
              entries.get(binding.group).push({binding: binding.binding, resource});
            }
            const target = device.createTexture({size: [4, 4], format: 'rgba32float',
              usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
            const readback = device.createBuffer({size: 4 * 256,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({colorAttachments: [{
              view: target.createView(), clearValue: [9, 9, 9, 9], loadOp: 'clear', storeOp: 'store',
            }]});
            pass.setPipeline(pipeline);
            // Auto layouts contain an empty group 0 when reflected resources begin at group 1.
            const largestGroup = Math.max(-1, ...entries.keys());
            for (let group = 0; group <= largestGroup; ++group) {
              pass.setBindGroup(group, device.createBindGroup({
                layout: pipeline.getBindGroupLayout(group), entries: entries.get(group) || [],
              }));
            }
            pass.draw(3);
            pass.end();
            encoder.copyTextureToBuffer({texture: target}, {buffer: readback, bytesPerRow: 256}, [4, 4]);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(GPUMapMode.READ);
            const data = new Float32Array(readback.getMappedRange()), mismatches = [];
            let maxError = 0;
            for (let y = 0; y < 4; ++y) {
              for (let x = 0; x < 4; ++x) {
                let expected = 0;
                if (!capture) {
                  const u = (x + 0.5) / 4, v = (y + 0.5) / 4;
                  const bx = Math.floor(u * 2), by = Math.floor(v * 2);
                  const wx = Math.max(0, Math.min(1, (u - (bx / 2 + 0.125)) * 2));
                  const wy = Math.max(0, Math.min(1, (v - (by / 2 + 0.125)) * 2));
                  let weight = 0, weightedShadow = 0;
                  for (let j = 0; j < 2; ++j) {
                    for (let i = 0; i < 2; ++i) {
                      const [shadow, signedDepth] = texels[Math.min(1, by + j) * 2 + Math.min(1, bx + i)];
                      const depth = Math.abs(signedDepth);
                      if (!(depth > 0 && depth < 3.4028234663852886e38) && shadow >= 1) continue;
                      const w = (i ? wx : 1 - wx) * (j ? wy : 1 - wy) / (Math.abs(depth - 16) + 0.0001);
                      weight += w;
                      weightedShadow += shadow * w;
                    }
                  }
                  expected = Math.sqrt(weight ? weightedShadow / weight : 1);
                }
                for (let c = 0; c < 4; ++c) {
                  const actual = data[y * 64 + x * 4 + c], difference = Math.abs(actual - expected);
                  maxError = Math.max(maxError, difference);
                  if (!Number.isFinite(actual) || difference > 0.0001) {
                    mismatches.push({x, y, channel: c, expected, actual});
                  }
                }
              }
            }
            readback.unmap();
            target.destroy();
            readback.destroy();
            resources.forEach(resource => resource.destroy());
            const error = await device.popErrorScope();
            if (error) errors.push(error.message);
            checks.push({shader: item.shader, scenario, checkedValues: 64, maxError,
              mismatches: mismatches.slice(0, 8), pass: mismatches.length === 0 && !error});
          }
        }
        device.destroy();
        return {modules: modules.length, checks, errors};
      }, modules);
      report.browserRuns.push({browser: name, version: browser.version(), ...state,
        pass: state.modules === 10 && state.checks.length === 4 &&
          state.checks.every(item => item.pass) && state.errors.length === 0});
      await browser.close();
      browser = null;
    }
    assert(report.browserRuns.every(item => item.pass));
    report.shaderGPUExecutionVerified = true;
    report.pass = true;
    report.boundary = 'Two previously failing real ES31 Cook jobs are freshly converted with unchanged eligibility/settings. Ten capture/upsample modules are validated per browser; the recovered zero-normal capture and bilateral shadow pass render to float targets and read back against CPU expectations. Forward rendering still has no captured GBuffer normal; finite zero is not reconstructed geometry. This does not verify UE pass/resource binding, actual scene capture, scene rendering, material Cook or browser ES31 startup. Installed shaders are unchanged.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-finite-capture-shadow-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, conversionVerified: report.conversionVerified,
      shaderGPUExecutionVerified: report.shaderGPUExecutionVerified,
      recoveredJobs: report.recoveredJobs.length, retainedJobs: report.retainedJobs.length,
      browserRuns: report.browserRuns, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
