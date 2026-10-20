const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const baselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-material-policy-20261020-1106.json');
const currentCookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
const abiBaselineFile = path.join(results, 'web-engine-webgpu-es31-cook-results-before-es31-runtime-20261020.json');
const factoryNames = new Set(['TGPUSkinVertexFactoryDefault', 'TGPUSkinVertexFactoryUnlimited',
  'TGPUSkinAPEXClothVertexFactoryDefault', 'TGPUSkinAPEXClothVertexFactoryUnlimited',
  'FParticleSpriteVertexFactory', 'FGPUSpriteVertexFactory', 'FLandscapeVertexFactory']);
const report = {date: new Date().toISOString(), pass: false, allFortyFailuresAccountedFor: false,
  cookSucceeded: false, completeUEScene: false, browserES31LoadVerified: false,
  sourceFiles: [audit(__filename)], excludedFailures: [], recoveredFailures: [], browserRuns: []};

function jobs(cook) {
  const found = new Map();
  const directory = path.join(cook.output, 'ShaderConversion');
  for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
    const dir = path.join(directory, item.name), file = path.join(dir, 'input.json');
    if (!item.isDirectory() || !fs.existsSync(file)) continue;
    const input = read(file), failed = fs.existsSync(path.join(dir, 'failure.json'));
    if (found.has(input.shader)) assert.equal(found.get(input.shader).failed, failed);
    else found.set(input.shader, {input, failed, directory: dir, inputAudit: audit(file)});
  }
  return found;
}

function matchMaterialMaps(previous, current) {
  const groups = records => {
    const maps = new Map(), signatures = new Map();
    for (const [shader, job] of records) {
      if (shader.startsWith('Global/') || factoryNames.has(shader.split('/')[2])) continue;
      const [map, ...permutation] = shader.split('/');
      const payload = shader.includes('/FDeferredDecalEmissivePS/') ? 'repaired-decal' :
        sha(path.join(job.directory, 'output.wgsl'));
      if (!maps.has(map)) maps.set(map, []);
      maps.get(map).push([permutation.join('/'), payload]);
    }
    for (const [map, members] of maps) {
      const material = map.replace(/_[0-9a-f]{1,16}$/, '');
      const signature = JSON.stringify([material, members.sort((a, b) => a[0].localeCompare(b[0]))]);
      if (!signatures.has(signature)) signatures.set(signature, []);
      signatures.get(signature).push(map);
    }
    return signatures;
  };
  const oldGroups = groups(previous), newGroups = groups(current), names = new Map();
  assert.deepEqual([...oldGroups.keys()].sort(), [...newGroups.keys()].sort(),
    'ABI changes must preserve each material map, every permutation and successful WGSL payload');
  report.materialMapCorrespondence = [];
  for (const [signature, oldNames] of oldGroups) {
    const newNames = newGroups.get(signature);
    assert.equal(newNames.length, oldNames.length, 'Equivalent material maps must retain their multiplicity');
    oldNames.sort(); newNames.sort();
    oldNames.forEach((oldName, index) => {
      names.set(newNames[index], oldName);
      report.materialMapCorrespondence.push({before: oldName, after: newNames[index]});
    });
  }
  const matched = new Map();
  for (const [shader, job] of current) {
    const [map, ...permutation] = shader.split('/');
    const identity = map === 'Global' ? shader : [names.get(map), ...permutation].join('/');
    assert(map === 'Global' || names.has(map));
    assert(!matched.has(identity), 'Distinct material maps must not merge');
    matched.set(identity, job);
  }
  return matched;
}

(async () => {
  let browser;
  try {
    const baseline = read(baselineFile), currentCook = read(currentCookFile);
    const historical = currentCook.shaderInventory?.detail.materialPolicy?.dbuffer === false;
    const cookFile = historical ? path.join(results,
      'web-engine-webgpu-es31-cook-results-before-material-runtime-20261020.json') : currentCookFile;
    const cook = historical ? read(cookFile) : currentCook;
    if (historical) {
      assert(currentCook.pass && currentCook.sourceFiles.every(valid) &&
        currentCook.hostProducts.every(valid) && currentCook.products.every(valid) &&
        valid(currentCook.log) && currentCook.shaderFailures.length === 0);
      for (const suffix of ['VertexFactory.cpp', 'WebShaderPlatform.h', 'MeshMaterialShader.cpp',
        'DeferredDecal.usf', 'RenderUtils.cpp']) {
        const source = cook.sourceFiles.find(item => item.file.endsWith(suffix));
        assert(source && valid(source), 'The original exclusion and decal repair sources must remain unchanged');
      }
      report.currentCook = audit(currentCookFile);
      report.originalFortyCookIsHistorical = true;
      report.originalFortyCookReason = 'DBuffer is now disabled consistently. The original Emissive decal permutation is no longer selected; its preserved successful WGSL is still executed in both browsers. Current variant coverage and runtime agreement are checked by verify-web-material-policy.cjs.';
    }
    assert(valid(baseline.log) && valid(baseline.shaderInventory.artifact));
    assert(cook.pass && cook.exitCode === 0 && cook.shaderFailures.length === 0 &&
      valid(cook.log) && (historical || cook.sourceFiles.every(valid) && cook.hostProducts.every(valid)) &&
      cook.products.every(valid) && valid(cook.shaderInventory.artifact) &&
      cook.validateShaderJobCache && cook.jobCacheDDCDisabled);
    const log = fs.readFileSync(cook.log.file, 'utf8');
    assert(!/Assertion failed:|Ensure condition failed:|WEB_SHADER_FAILURE:/.test(log));
    assert(log.includes('Set CVar [[r.ShaderCompiler.DebugValidateJobCache:1]]') &&
      log.includes('Set CVar [[r.ShaderCompiler.JobCacheDDC:0]]'));
    const packageArg = args => args.find(arg => arg.startsWith('-PACKAGE='));
    assert.equal(packageArg(cook.arguments), packageArg(baseline.arguments));
    assert.deepEqual(cook.shaderInventory.detail.settings, baseline.shaderInventory.detail.settings);
    const changes = cook.shaderInventory.detail.types.map((type, index) => {
      const old = baseline.shaderInventory.detail.types[index];
      assert.equal(type.name, old.name);
      return type.permutations === old.permutations ? null : {before: old, after: type};
    }).filter(Boolean);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].after.name, 'FGenerateConservativeDepthBufferCS');
    assert.equal(changes[0].before.permutations, 1);
    assert.equal(changes[0].after.permutations, 0);
    report.globalEligibilityChanges = changes;
    const abiBaseline = read(abiBaselineFile);
    assert(abiBaseline.pass && abiBaseline.exitCode === 0 && valid(abiBaseline.log) &&
      abiBaseline.products.every(valid), 'Preserved successful Cook must provide intact pre-ABI shader evidence');
    const previous = jobs(baseline), current = matchMaterialMaps(jobs(abiBaseline), jobs(cook));
    report.materialABIBaseline = audit(abiBaselineFile);
    const failures = new Map(baseline.shaderFailures.map(item => [item.detail.shader, item]));
    assert.equal(failures.size, 40);
    for (const failure of failures.values()) {
      assert(valid(failure.diagnostic));
      const factory = failure.detail.shader.split('/')[2];
      if (factoryNames.has(factory)) {
        assert(failure.detail.error.includes('SampledBuffer'));
        assert(!current.has(failure.detail.shader));
        report.excludedFailures.push({shader: failure.detail.shader, factory, diagnostic: failure.diagnostic});
      } else {
        assert.equal(failure.detail.shaderName, 'FDeferredDecalEmissivePS');
        const fixed = current.get(failure.detail.shader);
        assert(fixed && !fixed.failed);
        report.recoveredFailures.push({shader: failure.detail.shader, currentShader: fixed.input.shader,
          diagnostic: failure.diagnostic,
          input: fixed.inputAudit, spirv: audit(path.join(fixed.directory, 'input.spv')),
          wgsl: audit(path.join(fixed.directory, 'output.wgsl'))});
      }
    }
    assert.equal(report.excludedFailures.length, 39);
    assert.equal(report.recoveredFailures.length, 1);
    assert.deepEqual(new Set(report.excludedFailures.map(item => item.factory)), factoryNames);
    const expectedRetained = [...previous.keys()].filter(shader =>
      !factoryNames.has(shader.split('/')[2]) && !shader.startsWith('Global/FGenerateConservativeDepthBufferCS/'));
    assert.deepEqual([...current.keys()].sort(), expectedRetained.sort(),
      'Every job outside the declared feature exclusions must remain present');
    report.excludedMaterialJobs = [...previous.keys()].filter(shader => factoryNames.has(shader.split('/')[2])).length;
    assert.equal(report.excludedMaterialJobs, 72);
    report.excludedPreviouslySuccessfulMaterialJobs = report.excludedMaterialJobs - report.excludedFailures.length;
    for (const factory of factoryNames) {
      assert(log.includes(`WebGPU minimal Cook excludes vertex factory ${factory}`));
      assert(![...current.keys()].some(shader => shader.split('/')[2] === factory));
    }
    const oldLocal = [...previous].filter(([name, job]) => !job.failed && name.split('/')[2] === 'FLocalVertexFactory');
    assert.equal(oldLocal.length, 115);
    for (const [name, old] of oldLocal) {
      const retained = current.get(name);
      assert(retained && !retained.failed, name);
      assert.equal(sha(path.join(retained.directory, 'output.wgsl')), sha(path.join(old.directory, 'output.wgsl')),
        'ABI hash changes must preserve the ordinary static-mesh WGSL');
    }
    const globals = [...current].filter(([name]) => name.startsWith('Global/'));
    const materials = [...current].filter(([name]) => !name.startsWith('Global/'));
    assert.equal(globals.length, 838, 'All eligible Global jobs must be freshly compiled');
    assert([...current.values()].every(job => !job.failed &&
      fs.existsSync(path.join(job.directory, 'output.wgsl'))));
    const baselineVersion = previous.values().next().value.input.metadata.formatVersion;
    assert([...current.values()].every(job => job.input.metadata.formatVersion !== baselineVersion));
    report.observedJobs = {global: globals.length, material: materials.length,
      localVertexFactory: materials.filter(([name]) => name.split('/')[2] === 'FLocalVertexFactory').length,
      failed: 0};
    report.retainedPreviousStaticMeshJobs = oldLocal.length;
    const policyFile = path.join(results, 'web-vertex-factory-policy-results.json');
    const policy = read(policyFile);
    assert(policy.pass && policy.sources.every(valid) && policy.products.every(valid) &&
      policy.runs.length === 3 && policy.runs.every(run => run.exitCode === 0 && run.detail.pass &&
        valid(run.result) && valid(run.log) && run.detail.cases.length === 8));
    report.vertexFactoryPolicy = audit(policyFile);
    const linkFile = path.join(results, 'web-engine-webgpu-link-results.json'), link = read(linkFile);
    assert(link.pass && link.sourceFiles.every(valid) && link.linkInputs.every(valid) && link.products.every(valid));
    const compileLogs = fs.readdirSync(results).filter(name =>
      /^web-engine-webgpu-link-20261020-.*\.log\.Module\.(?:Engine\.33|RenderCore\.6|Renderer\.4)\.cpp\.o\.compile\.log$/.test(name));
    report.compileEvidence = [];
    for (const name of ['Engine.33', 'RenderCore.6', 'Renderer.4']) {
      const logName = compileLogs.filter(file => file.includes(`Module.${name}.cpp.o.compile.log`)).sort().at(-1);
      assert(logName);
      const logFile = path.join(results, logName);
      assert(!/(?:^|\n).*(?:error:|fatal error:)/.test(fs.readFileSync(logFile, 'utf8')));
      const object = link.linkInputs.find(item => path.basename(item.file) === `Module.${name}.cpp.o`);
      assert(object && valid(object));
      const response = object.file + '.rsp', source = object.file.slice(0, -2);
      assert(fs.readFileSync(object.file).subarray(0, 4).equals(Buffer.from([0, 97, 115, 109])));
      report.compileEvidence.push({object, response: audit(response), source: audit(source), log: audit(logFile)});
    }
    report.wasmLink = audit(linkFile);
    report.baseline = audit(baselineFile);
    report.cook = audit(cookFile);
    report.cookSucceeded = true;
    report.allFortyFailuresAccountedFor = true;
    const fixed = current.get(report.recoveredFailures[0].shader);
    const shader = {code: fs.readFileSync(report.recoveredFailures[0].wgsl.file, 'utf8'),
      metadata: fixed.input.metadata};
    for (const [name, executablePath] of [
      ['Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe'],
      ['Edge', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'],
    ]) {
      browser = await chromium.launch({executablePath, headless: true});
      const page = await browser.newPage();
      await page.route('http://127.0.0.1:8765/decal-validation', route =>
        route.fulfill({contentType: 'text/html', body: '<!doctype html><title>Decal validation</title>'}));
      await page.goto('http://127.0.0.1:8765/decal-validation');
      const state = await page.evaluate(async shader => {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error('WebGPU unavailable');
        const device = await adapter.requestDevice(), errors = [], cases = [];
        device.addEventListener('uncapturederror', event => errors.push(event.error.message));
        const module = device.createShaderModule({code: shader.code});
        const info = await module.getCompilationInfo();
        errors.push(...info.messages.filter(item => item.type === 'error').map(item => item.message));
        const vertex = device.createShaderModule({code: `
          @vertex fn main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0.5,1);
          }`});
        const pipeline = await device.createRenderPipelineAsync({layout: 'auto',
          vertex: {module: vertex, entryPoint: 'main'},
          fragment: {module, entryPoint: shader.metadata.webEntry, targets: [{format: 'rgba32float'}]}});
        for (const axis of [0, 1, 2]) {
          device.pushErrorScope('validation');
          const entries = new Map(), resources = [];
          for (const binding of shader.metadata.spirvBindings) {
            let resource;
            if (binding.descriptorType === 6) {
              const bytes = new ArrayBuffer(Math.ceil(binding.size / 16) * 16), floats = new Float32Array(bytes);
              for (const member of binding.members) {
                let values;
                if (member.name === 'SvPositionToDecal') {
                  values = Array(16).fill(0);
                  values[axis] = 1;
                  values[12 + axis] = -2;
                  values[15] = 1;
                } else {
                  values = {DecalParams: [1, 1], View_BufferSizeAndInvSize: [4, 1, 0.25, 1],
                    View_PreExposure: [1], Material_PreshaderBuffer: [0, 0, 0, 0, 0, 0, 0, 0]}[member.name];
                }
                if (!values) throw Error(`Uncovered uniform: ${member.name}`);
                floats.set(values, member.offset / 4);
              }
              const buffer = device.createBuffer({size: bytes.byteLength,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
              device.queue.writeBuffer(buffer, 0, bytes);
              resources.push(buffer);
              resource = {buffer};
            } else if (binding.descriptorType === 2) {
              const texture = device.createTexture({size: [1, 1], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST});
              device.queue.writeTexture({texture}, new Uint8Array([255, 0, 0, 255]), {bytesPerRow: 4}, [1, 1]);
              resources.push(texture);
              resource = texture.createView();
            } else if (binding.descriptorType === 0) {
              resource = device.createSampler({minFilter: 'linear', magFilter: 'linear'});
            } else throw Error(`Uncovered descriptor ${binding.descriptorType}`);
            if (!entries.has(binding.group)) entries.set(binding.group, []);
            entries.get(binding.group).push({binding: binding.binding, resource});
          }
          const target = device.createTexture({size: [4, 1], format: 'rgba32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC});
          const readback = device.createBuffer({size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({colorAttachments: [{view: target.createView(),
            clearValue: [1, 0, 1, 1], loadOp: 'clear', storeOp: 'store'}]});
          pass.setPipeline(pipeline);
          for (let group = 0; group <= Math.max(...entries.keys()); ++group) pass.setBindGroup(group,
            device.createBindGroup({layout: pipeline.getBindGroupLayout(group), entries: entries.get(group) || []}));
          pass.draw(3);
          pass.end();
          encoder.copyTextureToBuffer({texture: target}, {buffer: readback, bytesPerRow: 256}, [4, 1]);
          device.queue.submit([encoder.finish()]);
          await readback.mapAsync(GPUMapMode.READ);
          const actual = Array.from(new Float32Array(readback.getMappedRange()).slice(0, 16));
          readback.unmap();
          const expected = [1,0,1,1, 0,1,0,1, 0,1,0,1, 1,0,1,1];
          if (actual.some((value, index) => value !== expected[index])) throw Error(`Discard axis ${axis}: ${actual}`);
          const error = await device.popErrorScope();
          if (error) errors.push(error.message);
          cases.push({axis, checkedValues: actual.length, actual});
          [...resources, target, readback].forEach(resource => resource.destroy());
        }
        await device.queue.onSubmittedWorkDone();
        device.destroy();
        return {pass: errors.length === 0 && cases.length === 3, errors, cases};
      }, shader);
      report.browserRuns.push({browser: name, ...state});
      assert(state.pass, JSON.stringify(state.errors));
      await browser.close();
      browser = null;
    }
    report.decalShaderGPUExecutionVerified = true;
    report.pass = true;
    report.boundary = 'The original 40 failures are accounted for as 39 deliberately excluded unsupported vertex-factory jobs and one repaired decal shader. Actual ES31 Cook succeeds with a new shader cache version, all eligible Global jobs freshly converted, full job validation retained and per-job DDC disabled. ABI-dependent material-map hashes are matched by exact material, quality, factory and full permutation, without merging distinct maps; the prior 115 static-mesh jobs retain identical WGSL. Native factory callbacks are tested with Web, desktop and other-target process settings. Chrome/Edge execute the exact recovered decal WGSL and check all three clipping axes. This report does not verify the browser Engine shader-map load; see the separate runtime report. This is not a completed UE scene.';
    if (historical)
      report.boundary = report.originalFortyCookReason + ' Counts in observedJobs describe that preserved Cook, not the current Cook. Original exclusion/repair sources, shader artifacts and logs are checked; historical host/config hashes are not claimed current. ' + report.boundary;
  } catch (error) {
    report.failure = error.stack;
  } finally {
    if (browser) await browser.close();
    fs.writeFileSync(path.join(results, 'web-material-completion-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({pass: report.pass, allFortyFailuresAccountedFor: report.allFortyFailuresAccountedFor,
      cookSucceeded: report.cookSucceeded, excludedFailures: report.excludedFailures.length,
      recoveredFailures: report.recoveredFailures.length, observedJobs: report.observedJobs,
      browserRuns: report.browserRuns, failure: report.failure}, null, 2));
    process.exitCode = report.pass ? 0 : 1;
  }
})();
