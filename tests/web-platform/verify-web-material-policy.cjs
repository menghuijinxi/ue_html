const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, causeVerified: false,
  defaultDecalShaderMismatchResolved: false, completeUEScene: false, reports: [],
  sourceFiles: [audit(__filename)], browserRuns: []};
function load(name) {
  const file = path.join(results, name + '.json');
  report.reports.push(audit(file));
  return read(file);
}
function jobs(cook) {
  const directory = path.join(cook.output, 'ShaderConversion'), found = new Map();
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(directory, entry.name), input = read(path.join(dir, 'input.json'));
    const wgsl = path.join(dir, 'output.wgsl');
    assert(!fs.existsSync(path.join(dir, 'failure.json')) && fs.existsSync(wgsl));
    const job = {input, wgsl: audit(wgsl), inputAudit: audit(path.join(dir, 'input.json'))};
    if (found.has(input.shader)) assert.equal(found.get(input.shader).wgsl.sha256, job.wgsl.sha256);
    else found.set(input.shader, job);
  }
  return found;
}
try {
  const before = load('web-material-policy-before-settings-20261020');
  const native = load('web-material-policy-native');
  assert.deepEqual(before, {platform: 46, mobile: true, dbuffer: true, substrateBlendable: true,
    mobileDeferred: false, dbufferSetting: 1, mobileDBufferSetting: 0, substrateSetting: 0,
    registeredWebSettings: 0});
  assert.deepEqual(native, {...before, dbuffer: false, fullDepthPrepass: true, registeredWebSettings: 1});
  report.sourceFiles.push(...['web-material-policy-before-settings-20261020.log',
    'web-material-policy-native.log', 'web-cook-settings-host-build-20261020.log',
    'web-cook-settings-depth-host-build-20261020.log'].map(name => audit(path.join(results, name))));
  for (const name of ['web-cook-settings-host-build-20261020.log', 'web-cook-settings-depth-host-build-20261020.log'])
    assert(fs.readFileSync(path.join(results, name), 'utf8').includes('Result: Succeeded'));
  const previousRuntime = load('web-engine-webgpu-es31-results-before-material-runtime-20261020');
  const previous = load('web-engine-webgpu-es31-cook-results-before-material-runtime-20261020');
  assert(previous.pass && valid(previous.log) && previous.products.every(valid));
  const oldGPU = previousRuntime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(oldGPU.length, 2);
  assert(oldGPU.every(run => run.startupBlocker === 'default-material-shader-map-incomplete' &&
    run.consoleLog.some(line => line.includes('missing FMaterialShader (FDeferredDecalMobilePS, 0)'))));
  const cook = load('web-engine-webgpu-es31-cook-results');
  assert(cook.pass && cook.exitCode === 0 && cook.validateShaderJobCache && cook.jobCacheDDCDisabled &&
    cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && cook.products.every(valid) &&
    valid(cook.log) && valid(cook.shaderInventory.artifact) && cook.shaderFailures.length === 0 &&
    cook.minimalRendererSettingsVerified);
  assert.deepEqual(cook.shaderInventory.detail.types, previous.shaderInventory.detail.types);
  const expectedPolicy = {dbuffer: false, substrateBlendable: true, mobileDeferred: false, fullDepthPrepass: true};
  assert.deepEqual(cook.shaderInventory.detail.materialPolicy, expectedPolicy);
  for (const [name, value] of [['r.Mobile.DBuffer', '0'], ['r.Mobile.EarlyZPass', '1'], ['r.Substrate', '0']])
    assert.deepEqual(cook.shaderInventory.detail.settings[name], {host: value, target: value});
  const oldJobs = jobs(previous), current = jobs(cook);
  const removed = [...oldJobs.keys()].filter(name => !current.has(name));
  const added = [...current.keys()].filter(name => !oldJobs.has(name));
  const decal = 'DefaultDeferredDecalMaterial_bb30c6084ed43b1e/Default/';
  assert.deepEqual(removed.sort(), [
    decal + 'FDeferredDecalEmissivePS/0:/Engine/Private/DeferredDecal.usf|MainPS',
    decal + 'FLocalVertexFactory/FMeshDecalsEmissivePS/0:/Engine/Private/MeshDecals.usf|MainPS',
    decal + 'FSplineMeshVertexFactory/FMeshDecalsEmissivePS/0:/Engine/Private/MeshDecals.usf|MainPS'
  ].sort());
  assert.deepEqual(added, [decal + 'FDeferredDecalMobilePS/0:/Engine/Private/DeferredDecal.usf|MainPS']);
  // Keep full map hashes and identities; no same-name material maps may be merged.
  const allowedChangedTypes = new Set(['TMobileBasePassPSFNoLightMapPolicy',
    'TMobileBasePassPSFMobileDirectionalLightAndCSMPolicy', 'FMeshDecalsPS', 'FDeferredDecalPS']);
  report.changedPayloads = [];
  let unchanged = 0, unchangedLocal = 0;
  for (const [name, job] of current) {
    if (!oldJobs.has(name)) continue;
    const old = oldJobs.get(name);
    assert.notEqual(job.input.metadata.formatVersion, old.input.metadata.formatVersion);
    if (job.wgsl.sha256 === old.wgsl.sha256) {
      ++unchanged;
      unchangedLocal += name.split('/')[2] === 'FLocalVertexFactory' ? 1 : 0;
    } else {
      assert(!name.startsWith('Global/') && allowedChangedTypes.has(job.input.shaderName), name);
      report.changedPayloads.push({shader: name, before: old.wgsl, after: job.wgsl});
    }
  }
  assert.equal(report.changedPayloads.length, 63);
  assert.equal(unchanged, 985);
  assert.equal(unchangedLocal, 82);
  const excluded = new Set(['TGPUSkinVertexFactoryDefault', 'TGPUSkinVertexFactoryUnlimited',
    'TGPUSkinAPEXClothVertexFactoryDefault', 'TGPUSkinAPEXClothVertexFactoryUnlimited',
    'FParticleSpriteVertexFactory', 'FGPUSpriteVertexFactory', 'FLandscapeVertexFactory']);
  assert([...current.keys()].every(name => !excluded.has(name.split('/')[2])));
  report.observedJobs = {global: [...current.keys()].filter(name => name.startsWith('Global/')).length,
    material: [...current.keys()].filter(name => !name.startsWith('Global/')).length,
    localVertexFactory: [...current.keys()].filter(name => name.split('/')[2] === 'FLocalVertexFactory').length,
    failed: 0};
  assert.deepEqual(report.observedJobs, {global: 838, material: 211, localVertexFactory: 114, failed: 0});
  report.variantDelta = {removed, added, unchangedPayloads: unchanged, unchangedLocalPayloads: unchangedLocal};
  report.mobileDecal = current.get(added[0]);
  const original = load('web-material-completion-results');
  assert(original.pass && original.allFortyFailuresAccountedFor && original.originalFortyCookIsHistorical &&
    valid(original.cook) && valid(original.currentCook) && original.sourceFiles.every(valid) &&
    original.excludedFailures.every(item => valid(item.diagnostic)) &&
    original.recoveredFailures.every(item => valid(item.diagnostic) && valid(item.wgsl) && valid(item.spirv)) &&
    original.browserRuns.length === 2 && original.browserRuns.every(run => run.pass));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.es31LibraryIntegrationVerified && runtime.materialPolicyMatched &&
    runtime.sourceFiles.every(valid) && runtime.configFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.stagedContentVerified && run.gpuValidationErrors.length === 0);
    for (const [key, value] of Object.entries(expectedPolicy))
      assert.equal(run.materialPolicy[key], value);
    assert(!run.consoleLog.some(line => /Incomplete material|Failed to find shader map for default material/.test(line)));
    report.browserRuns.push({browser: run.browser, materialPolicy: run.materialPolicy,
      frames: run.frames, startupBlocker: run.startupBlocker});
  }
  report.sourceFiles.push(...['tests/web-platform/probe-web-material-policy.ps1',
    'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp',
    'tests/ue-shader-host/Config/DefaultEditor.ini',
    'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor.modules'
  ].map(name => audit(path.join(root, name))));
  report.causeVerified = true;
  report.defaultDecalShaderMismatchResolved = true;
  report.pass = true;
  report.boundary = 'Actual before/after native probes confirm missing target-settings registration left Web with desktop DBuffer state. WebCook registers its owned settings through the normal manager. Current Cook and both browser engines agree on no DBuffer and a full depth prepass, and both engines advance past the original default-decal failure. The existing audited Cook retains all 838 Global jobs with identical WGSL; exactly three DBuffer-only decal variants are replaced by one Mobile variant. The 63 changed retained payloads are explicitly limited to mobile base-pass and decal pixel types; all other 985 retained payloads match. Original 40-error evidence and the old Emissive shader GPU test are historical and explicitly separate. This does not verify compressed shader execution, volume textures, Engine frames or a scene.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-material-policy-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, causeVerified: report.causeVerified,
    defaultDecalShaderMismatchResolved: report.defaultDecalShaderMismatchResolved,
    observedJobs: report.observedJobs, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
