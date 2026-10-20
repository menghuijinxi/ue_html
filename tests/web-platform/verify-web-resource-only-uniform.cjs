const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
const output = path.join(__dirname, 'build', `resource-only-uniform-${stamp}`);
const editor = path.join(root, '.tools/ue58-web-es31-cook-host/Engine/Binaries/Win64/UnrealEditor-Cmd.exe');
const project = path.join(root, 'tests/ue-shader-host/UEShaderHost.uproject');
const tint = path.join(root, '.tools/dawn-v20261009.190412/bin/tint_info.exe');
const baselineFile = path.join(results, 'web-material-cache-probe-20261020-102034.json');
const buildFile = path.join(results, 'web-material-host-build-results.json');
const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const report = {date: new Date().toISOString(), pass: false, completeUEScene: false,
  productionBindingValidatorVerified: false, shaderGPUExecutionVerified: false,
  engineRHIIntegrationVerified: false, cookSucceeded: false,
  sourceFiles: [audit(__filename)], nativeChecks: [], browserRuns: [], recoveredJobs: []};
fs.mkdirSync(output, {recursive: true});
const reuseArgument = process.argv.find(argument => argument.startsWith('--reuse-native='));
const reuseFile = reuseArgument ? path.resolve(reuseArgument.slice('--reuse-native='.length)) : null;

function runEditor(args, name) {
  const log = path.join(output, `${name}.log`);
  const run = spawnSync(editor, [project, '-run=WebShaderProbe', '-nullrhi', '-unattended',
    '-nop4', '-nosplash', '-nosound', '-processaffinity=2', '-ddpi:Web:bIsEnabled=false',
    `-abslog=${log}`, ...args], {encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 4 * 1024 * 1024});
  fs.writeFileSync(path.join(output, `${name}.console.txt`), (run.stdout || '') + (run.stderr || ''));
  assert.equal(run.status, 0, `${name}: ${run.error || run.stderr}`);
  return audit(log);
}

(async () => {
  let browser;
  try {
    const build = read(buildFile), baseline = read(baselineFile);
    assert(build.pass && build.sources.every(valid) && build.products.every(valid) &&
      build.actions.length === 5 && build.actions.every(item => item.exitCode === 0 && valid(item.log) && valid(item.response)));
    assert(baseline.pass && valid(baseline.log) &&
      baseline.shaderFailures.every(item => valid(item.diagnostic)));
    assert(baseline.jobCacheDDCDisabled && baseline.debugValidationRetained && !baseline.jobCacheAssertionObserved);
    report.nativeBuild = audit(buildFile);
    report.baseline = audit(baselineFile);
    report.hostProducts = [editor, tint].map(audit);
    const old = [...new Map(baseline.shaderFailures
      .filter(item => item.detail.error === 'Binding contract: parameter descriptor missing' &&
        item.detail.shader.includes('/FLocalVertexFactory/'))
      .map(item => [item.detail.shader, item])).values()];
    assert.equal(old.length, 2);
    const modules = [];
    const reuse = reuseFile ? read(reuseFile) : null;
    if (reuse) {
      assert(reuse.productionBindingValidatorVerified && reuse.nativeBuild.sha256 === sha(buildFile));
      assert.equal(reuse.nativeChecks.length, 15);
      assert(reuse.nativeChecks.every(item => valid(item.input) && valid(item.reflection) && valid(item.result) && valid(item.log)));
      report.reusedNativeChecks = audit(reuseFile);
    }
    for (const [index, failure] of old.entries()) {
      assert(valid(failure.diagnostic));
      const directory = path.dirname(failure.diagnostic.file);
      const inputFile = path.join(directory, 'input.json'), wgslFile = path.join(directory, 'output.wgsl');
      const input = read(inputFile), metadata = input.metadata;
      assert.equal(metadata.ueParameterMap.length, 1);
      assert.deepEqual(metadata.ueParameterMap[0], {name: 'Material', bufferIndex: 0, baseIndex: 0, size: 0, type: 1});
      assert.deepEqual(metadata.spirvBindings.map(item => item.descriptorType), [2, 0]);
      const reflected = spawnSync(tint, ['--json', wgslFile], {encoding: 'utf8', windowsHide: true});
      assert.equal(reflected.status, 0);
      const reflectionFile = path.join(output, `reflection-${index}.json`);
      fs.writeFileSync(reflectionFile, reflected.stdout);
      const cases = [['resource-only-material', null, true]];
      if (index === 0) cases.push(
        ['missing-table-bit', m => { m.resourceTable.bits = 0; }, false],
        ['missing-layout-hash', m => { m.resourceTable.layoutHashes = []; }, false],
        ['zero-layout-hash', m => { m.resourceTable.layoutHashes[0] = 0; }, false],
        ['wrong-uniform-slot', m => { m.ueParameterMap[0].bufferIndex = 1; }, false],
        ['token-offset-out-of-range', m => { m.resourceTable.textures[0] = 999; }, false],
        ['wrong-resource-index', m => { m.resourceTable.textures[1] = 512; }, false],
        ['wrong-binding', m => { m.resourceTable.samplers[1] = 258; }, false],
        ['wrong-resource-kind', m => { m.uniformResourceEntries[0].type = 8; }, false],
        ['missing-active-texture-token', m => { m.resourceTable.textures[0] = 0; }, false],
        ['missing-token-terminator', m => { m.resourceTable.samplers.pop(); }, false],
        ['nonzero-constant-size', m => { m.ueParameterMap[0].size = 16; }, false],
        ['unknown-uniform', m => { m.ueParameterMap[0].name = 'Unknown'; }, false],
        ['missing-loose-parameter', m => { m.ueParameterMap.push({
          name: 'MissingConstant', bufferIndex: 0, baseIndex: 0, size: 4, type: 0,
        }); }, false],
      );
      for (const [name, mutate, accepted] of cases) {
        const fixture = structuredClone(input);
        if (mutate) mutate(fixture.metadata);
        const file = path.join(output, `${index}-${name}.json`);
        const resultFile = path.join(output, `${index}-${name}-result.json`);
        fs.writeFileSync(file, JSON.stringify(fixture));
        const cached = reuse?.nativeChecks.find(item => item.shader === input.shader && item.name === name);
        if (cached) {
          assert.equal(sha(file), cached.input.sha256);
          assert.equal(sha(reflectionFile), cached.reflection.sha256);
        }
        const log = cached ? cached.log : runEditor(['-BindingContractProbe', `-Input=${file}`,
          `-Reflection=${reflectionFile}`, `-Output=${resultFile}`], `${index}-${name}`);
        const actualResultFile = cached ? cached.result.file : resultFile;
        const result = read(actualResultFile);
        assert.equal(result.accepted, accepted, `${input.shader}: ${name}: ${result.error}`);
        if (!accepted) assert(result.error.startsWith('Binding contract: '));
        report.nativeChecks.push({shader: input.shader, name, expectedAccepted: accepted, ...result,
          input: audit(file), reflection: audit(reflectionFile), result: audit(actualResultFile), log});
      }
      modules.push({...input, code: fs.readFileSync(wgslFile, 'utf8')});
      report.recoveredJobs.push({shader: input.shader, name: input.shaderName,
        previousFailure: failure.diagnostic, previousInput: audit(inputFile), previousWgsl: audit(wgslFile)});
    }
    report.productionBindingValidatorVerified = true;
    const metadataDir = path.join(output, 'host-metadata');
    const metadataLog = runEditor(['-ShaderParameterMetadataProbe', `-Output=${metadataDir}`], 'host-metadata');
    const metadataFile = path.join(metadataDir, 'shader-parameter-metadata.json');
    const hostMetadata = read(metadataFile);
    assert.equal(hostMetadata.shader, 'FGenerateConservativeDepthBufferCS');
    assert(hostMetadata.members.some(item => item.name === 'ConservativeDepthTextureSize' && item.offset === 24));
    assert(!hostMetadata.members.some(item => item.name === 'ConservativeDepthFillSize'));
    const rendererSource = 'H:/UE_5.8/Engine/Source/Runtime/Renderer/Private/GenerateConservativeDepthBuffer.cpp';
    assert(fs.readFileSync(rendererSource, 'utf8').includes('SHADER_PARAMETER(FIntPoint, ConservativeDepthFillSize)'));
    report.hostMetadataMismatch = {verified: true, actualName: 'ConservativeDepthTextureSize',
      sourceName: 'ConservativeDepthFillSize', offset: 24, metadata: audit(metadataFile), log: metadataLog,
      installedRenderer: audit('H:/UE_5.8/Engine/Binaries/Win64/UnrealEditor-Renderer.dll'),
      installedRendererSource: audit(rendererSource)};

    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/resource-only-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Material binding validation</title>'}));
      await page.goto('http://127.0.0.1:8765/resource-only-validation');
      const state = await page.evaluate(async modules => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU unavailable');
        const device = await adapter.requestDevice();
        const errors = [], cases = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        const vertex = device.createShaderModule({code: `
          struct VertexOutput { @builtin(position) position: vec4f, @location(3) uv: vec4f };
          @vertex fn main(@builtin(vertex_index) i: u32) -> VertexOutput {
            let p = array<vec2f, 3>(vec2f(-1,-1), vec2f(3,-1), vec2f(-1,3))[i];
            return VertexOutput(vec4f(p, 0.25, 1), vec4f(p * 0.5 + 0.5, 0, 0));
          }`});
        for (const item of modules) {
          device.pushErrorScope('validation');
          const module = device.createShaderModule({label: item.shader, code: item.code});
          const compilation = await module.getCompilationInfo();
          errors.push(...compilation.messages.filter(message => message.type === 'error').map(message => message.message));
          const colorOutput = item.shaderName === 'FDepthOnlyPS';
          const pipeline = await device.createRenderPipelineAsync({layout: 'auto',
            vertex: {module: vertex, entryPoint: 'main'},
            fragment: {module, entryPoint: item.metadata.webEntry, targets: colorOutput ? [{format: 'rgba8unorm'}] : []},
            depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always'}});
          const texture = device.createTexture({size: [4, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
          const texels = new Uint8Array([0,0,0,255, 127,0,0,255, 129,0,0,255, 255,0,0,255]);
          device.queue.writeTexture({texture}, texels, {bytesPerRow: 16}, [4, 1]);
          const sampler = device.createSampler({minFilter: 'nearest', magFilter: 'nearest'});
          const depth = device.createTexture({size: [4, 1], format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
          const color = colorOutput ? device.createTexture({size: [4, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC}) : null;
          const depthRead = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          const colorRead = colorOutput ? device.createBuffer({size: 256,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ}) : null;
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({colorAttachments: colorOutput ? [{
            view: color.createView(), clearValue: [1, 0, 1, 1], loadOp: 'clear', storeOp: 'store',
          }] : [], depthStencilAttachment: {
            view: depth.createView(), depthClearValue: 0.875, depthLoadOp: 'clear', depthStoreOp: 'store',
          }});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: []}));
          pass.setBindGroup(1, device.createBindGroup({layout: pipeline.getBindGroupLayout(1), entries: [
            {binding: 0, resource: texture.createView()}, {binding: 1, resource: sampler},
          ]}));
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({texture: depth, aspect: 'depth-only'},
            {buffer: depthRead, bytesPerRow: 256}, [4, 1]);
          if (colorOutput) encoder.copyTextureToBuffer({texture: color},
            {buffer: colorRead, bytesPerRow: 256}, [4, 1]);
          device.queue.submit([encoder.finish()]);
          await depthRead.mapAsync(GPUMapMode.READ);
          const depths = Array.from(new Float32Array(depthRead.getMappedRange()).slice(0, 4));
          depthRead.unmap();
          const expectedDepths = [0.875, 0.875, 0.25, 0.25];
          if (depths.some((value, i) => value !== expectedDepths[i])) throw Error(`Depth/discard mismatch: ${depths}`);
          let colors = [];
          if (colorOutput) {
            await colorRead.mapAsync(GPUMapMode.READ);
            colors = Array.from(new Uint8Array(colorRead.getMappedRange()).slice(0, 16));
            colorRead.unmap();
            const expected = [255,0,255,255, 255,0,255,255, 0,0,0,0, 0,0,0,0];
            if (colors.some((value, i) => value !== expected[i])) throw Error(`Color/discard mismatch: ${colors}`);
          }
          const error = await device.popErrorScope();
          if (error) errors.push(error.message);
          cases.push({shader: item.shader, depths, colors, valueCount: depths.length + colors.length});
          for (const resource of [texture, depth, color, depthRead, colorRead]) resource?.destroy();
        }
        await device.queue.onSubmittedWorkDone();
        device.destroy();
        return {pass: errors.length === 0 && cases.length === 2, errors, cases,
          checkedValues: cases.reduce((total, item) => total + item.valueCount, 0)};
      }, modules);
      report.browserRuns.push({name, ...state});
      assert(state.pass, JSON.stringify(state.errors));
      await browser.close();
      browser = null;
    }
    report.shaderGPUExecutionVerified = true;
    // Validate the canonical Cook independently from the commandlet's binding fixtures.
    const deadline = Date.now() + 480000;
    while (!fs.existsSync(cookFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 3000));
    assert(fs.existsSync(cookFile), 'Material Cook report not ready');
    const cook = read(cookFile);
    assert(cook.pass && cook.exitCode === 0 && valid(cook.log) &&
      cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && valid(cook.shaderInventory.artifact));
    const formatDLL = build.products.find(item => item.file.endsWith('UnrealEditor-WebGPUShaderFormat.dll'));
    assert(formatDLL && cook.hostProducts.some(item => item.sha256 === formatDLL.sha256));
    assert(cook.jobCacheDDCDisabled && cook.validateShaderJobCache);
    const inventory = read(cook.shaderInventory.artifact.file);
    const baselineCook = read(read(baseline.baseline.file).shaderInventory.artifact.file);
    assert.deepEqual(inventory.settings, baselineCook.settings);
    const wanted = new Set(modules.map(item => item.shader));
    const found = new Map(), observed = new Map();
    for (const item of fs.readdirSync(path.join(cook.output, 'ShaderConversion'), {withFileTypes: true})) {
      if (!item.isDirectory()) continue;
      const directory = path.join(cook.output, 'ShaderConversion', item.name);
      const inputFile = path.join(directory, 'input.json');
      if (!fs.existsSync(inputFile)) continue;
      const input = read(inputFile);
      const succeeded = !fs.existsSync(path.join(directory, 'failure.json'));
      if (observed.has(input.shader)) assert.equal(observed.get(input.shader), succeeded);
      observed.set(input.shader, succeeded);
      if (!wanted.has(input.shader) || found.has(input.shader)) continue;
      assert(succeeded);
      const previous = report.recoveredJobs.find(job => job.shader === input.shader);
      const wgslFile = path.join(directory, 'output.wgsl');
      assert.equal(sha(wgslFile), previous.previousWgsl.sha256, 'Binding validation must not rewrite shader code');
      assert.notEqual(input.metadata.formatVersion, modules.find(module => module.shader === input.shader).metadata.formatVersion);
      found.set(input.shader, {input: audit(inputFile), wgsl: audit(wgslFile), spirv: audit(path.join(directory, 'input.spv'))});
    }
    assert.equal(found.size, 2, 'Both static-mesh material jobs must be recompiled successfully');
    for (const job of report.recoveredJobs) job.current = found.get(job.shader);
    const failures = [...new Map(cook.shaderFailures.map(item => [item.detail.shader, item])).values()];
    assert(failures.every(item => valid(item.diagnostic)));
    assert(!failures.some(item => wanted.has(item.detail.shader)));
    report.remainingMaterialFailures = failures.map(item => ({shader: item.detail.shader, error: item.detail.error}));
    report.remainingMaterialFailureCount = failures.length;
    const globals = [...observed].filter(([shader]) => shader.startsWith('Global/'));
    const materials = [...observed].filter(([shader]) => !shader.startsWith('Global/'));
    assert.equal(globals.length, 838);
    assert(globals.every(([, succeeded]) => succeeded));
    report.observedJobs = {
      global: {total: globals.length, succeeded: globals.length, failed: 0},
      material: {total: materials.length, succeeded: materials.filter(([, succeeded]) => succeeded).length,
        failed: materials.filter(([, succeeded]) => !succeeded).length},
    };
    report.cook = audit(cookFile);
    report.cookSucceeded = cook.pass;
    report.shaderEligibilityUnchanged = false;
    report.resourceOnlyShaderEligibilityUnchanged = true;
    report.pass = true;
    report.boundary = 'The production native binding validator accepts two resource-only Material allocations and rejects corrupted mappings. Chrome and Edge execute their unchanged WGSL and verify depth/color readback. Both jobs must be freshly compiled by the successful canonical ES31 Cook. This round excludes seven unsupported vertex factories and the unused volumetric-fog depth generator; resource-only static-mesh eligibility is preserved. The installed Renderer metadata/source mismatch remains in the installed binary, but that disabled fog path is no longer compiled for Web. Browser Engine shader loading and a UE scene remain unverified.';
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-resource-only-uniform-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, nativeChecks: report.nativeChecks.length,
      rejectedCases: report.nativeChecks.filter(item => !item.expectedAccepted).length,
      recoveredJobs: report.recoveredJobs.length, browserRuns: report.browserRuns,
      remainingMaterialFailureCount: report.remainingMaterialFailureCount,
      observedJobs: report.observedJobs, cookSucceeded: report.cookSucceeded, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
