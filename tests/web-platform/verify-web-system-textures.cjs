const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const text = file => fs.readFileSync(file, 'utf8').replaceAll('\r', '');
const report = {date: new Date().toISOString(), pass: false, systemDefaultsVerified: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false, sourceFiles: [audit(__filename)],
  reports: [], browserRuns: []};

// Select only the explicit Web guards added to these files; preserve nested desktop directives verbatim.
function selectPlatform(source, web) {
  const lines = source.split('\n'), output = [];
  for (let index = 0; index < lines.length; ++index) {
    const guard = /^#if (!)?PLATFORM_WEB$/.exec(lines[index]);
    if (!guard) { output.push(lines[index]); continue; }
    let depth = 1, first = true;
    const branches = [[], []];
    for (++index; index < lines.length; ++index) {
      const line = lines[index];
      if (/^#if(?:def|ndef)?\b/.test(line)) ++depth;
      if (/^#endif\b/.test(line) && --depth === 0) break;
      if (depth === 1 && line === '#else') { first = false; continue; }
      branches[first ? 0 : 1].push(line);
    }
    assert.equal(depth, 0);
    output.push(...branches[web !== Boolean(guard[1]) ? 0 : 1]);
  }
  return output.join('\n');
}

try {
  const load = name => {
    const file = path.join(results, name + '.json');
    report.reports.push(audit(file));
    return read(file);
  };
  const overlays = [
    ['Renderer/Private/SystemTextures.cpp', 'e558424819663bcc4c8cced3408c9a170325585cd9efa3f1d1f5e9bf99014b16'],
    ['Engine/Private/UnrealEngine.cpp', 'a856525bd245039126444ff9978c1bf68ffadd76aeaf340b01da30d608af84bf']
  ];
  for (const [relative, expectedHash] of overlays) {
    const installed = path.join('H:/UE_5.8/Engine/Source/Runtime', relative);
    const target = path.join(root, 'reference-engine/Engine/Source/Runtime', relative);
    const overlay = path.join(root, '.tools/ue58-web-build-host/Engine/Source/Runtime', relative);
    assert.equal(sha(installed), expectedHash);
    assert.equal(text(overlay), text(target));
    assert.equal(selectPlatform(text(target), false), text(installed),
      'Removing only the Web branches must restore the entire desktop source');
    report.sourceFiles.push(...[installed, target, overlay].map(audit));
    const web = selectPlatform(text(target), true);
    if (relative.startsWith('Renderer')) {
      for (const name of ['BlackArrayDummy', 'ZeroUIntArrayDummy', 'GreenDummy', 'ZeroUIntArrayAtomicCompatDummy'])
        assert(!web.includes(`Create2DArray(TEXT("${name}")`));
      assert(!web.includes('Create3D(TEXT("PerlinNoise3D")'));
      assert(!web.includes('Format = PF_G16R16;'));
      assert(web.includes('EPixelFormat Format = PF_R8G8;'));
      assert(web.includes('FeatureLevelInitializedTo = InFeatureLevel;'));
      assert(web.includes('StencilDummySRV = RHICmdList.CreateShaderResourceView'));
      assert(web.includes('return TryRegisterExternalTexture(GraphBuilder, RenderTarget, ERDGTextureFlags::SkipTracking);') &&
        web.includes('SystemTextures.BlackArray = Register(GSystemTextures.BlackArrayDummy);'));
    } else {
      assert(!web.includes('LoadEngineTexture(WeightMapArrayPlaceholderTexture,'));
      assert(web.includes('LoadEngineTexture(DefaultTexture,') &&
        web.includes('LoadEngineTexture(WeightMapPlaceholderTexture,'));
    }
  }
  const build = load('web-engine-webgpu-link-results');
  assert(build.pass && !build.fullNormalUBTBuildVerified && build.sourceFiles.every(valid) &&
    build.linkInputs.length === 415 && build.linkInputs.every(valid) && build.products.every(valid) && valid(build.log));
  const unity = build.recompiledObjects.find(item => item.source.file.endsWith('web-system-textures-unity.cpp'));
  assert(unity && unity.exitCode === 0 &&
    ['response', 'source', 'product', 'log'].every(key => valid(unity[key])));
  const previousUnity = path.join(root,
    'tests/ue-web-smoke/Intermediate/Build/Web/wasm64/UEWebEngine/Development/Renderer/Module.Renderer.34.cpp.old');
  const includes = source => source.split('\n').filter(line => line.startsWith('#include'));
  assert.deepEqual(includes(text(unity.source.file)), includes(text(previousUnity)),
    'The incremental unity must retain the compiled baseline membership');
  report.sourceFiles.push(audit(previousUnity));
  for (const line of includes(text(unity.source.file)))
    report.sourceFiles.push(audit(path.join(root, '.tools/ue58-web-build-host/Engine/Source',
      /^#include "(.+)"$/.exec(line)[1])));
  for (const name of ['BrowserDynamicRHI.cpp', 'Module.GeometryCollectionEngine.2.cpp', 'Module.Engine.65.cpp'])
    assert(build.recompiledObjects.some(item => path.basename(item.source.file) === name && item.exitCode === 0 &&
      ['response', 'source', 'product', 'log'].every(key => valid(item[key]))));
  const native = load('web-system-textures-native-results');
  assert(native.pass && native.buildExitCode === 0 && native.exitCode === 0 && native.sources.every(valid) &&
    native.products.every(valid) && native.shaderPackets.length === 3 && native.shaderPackets.every(valid) &&
    valid(native.runtime) && valid(native.log) && valid(native.buildLog));
  const typed = read(native.runtime.file);
  assert(typed.pass && typed.hostRHI === 'Null' && typed.textureSampleTypeValidated);
  assert.deepEqual(typed.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const checks = [28, 32, 60, 10, 71, 3, 40].flatMap(format =>
    ['creation-valid', 'view-valid', 'direct-type-compatible', 'srv-type-compatible', 'reject-scalar-mismatch',
      'reject-srgb', 'reject-array', 'volume-scope-retained'].map(name => `system-2d-${format}-${name}`));
  for (const mode of typed.modes) {
    assert(mode.pass && mode.errors.length === 0 && mode.checks.length === 116 &&
      mode.checks.every(check => check.pass) && mode.dispatches === 10 && mode.checkedValues === 840 &&
      mode.finalizedCommandLists === mode.submittedCommandLists);
    assert.deepEqual(mode.checks.filter(check => check.name.startsWith('system-2d-')).map(check => check.name), checks);
  }
  report.nativeFormatChecks = checks.length * typed.modes.length;
  report.nativeRegression = {checks: 232, dispatches: 20, comparedValues: 1680};
  const before = load('web-engine-webgpu-es31-results-before-system-textures-20261020');
  const beforeGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(beforeGPU.length, 2);
  assert(beforeGPU.every(run =>
    run.frames === 0 && run.startupBlocker.startsWith(
      'WebGPU texture creation unsupported: dimension=1 format=2 extent=1x1') &&
    run.errors.some(error => error.includes('FSystemTextures::InitializeCommonTextures'))));
  const beforeEngine = load('web-engine-webgpu-es31-results-before-engine-defaults-20261020');
  const beforeEngineGPU = beforeEngine.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(beforeEngineGPU.length, 2);
  assert(beforeEngineGPU.every(run =>
    run.consoleLog.some(line => line.includes('P3_TEXTURE_CREATE name=WeightMapArrayPlaceholderTexture dimension=1')) &&
    run.errors.some(error => error.includes('UEngine::InitializeObjectReferences'))));
  report.beforeFixRecordsAreHistorical = true;
  const textures = load('web-texture2d-results'), runtime = load('web-engine-webgpu-es31-results');
  assert(textures.pass && textures.textureMipUploadsVerified && textures.sources.every(valid) &&
    valid(textures.runtime) && valid(textures.build) && valid(textures.cook));
  assert(runtime.es31LibraryIntegrationVerified && runtime.sourceFiles.every(valid) &&
    runtime.configFiles.every(valid) && valid(runtime.buildReport) && valid(runtime.webgpuStageReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.deviceReady && run.stagedContentVerified && run.textureUploads.pass && !run.gpuValidationErrors.length);
    for (const marker of ['P3_WEB system array and cube defaults omitted',
      'P3_WEB Perlin volume noise omitted', 'P3_WEB Landscape weight-map array default omitted'])
      assert(run.consoleLog.some(line => line.includes(marker)));
    assert(!run.consoleLog.some(line => /P3_TEXTURE_CREATE name=(?:BlackArrayDummy|ZeroUIntArrayDummy|GreenDummy|ZeroUIntArrayAtomicCompatDummy|PerlinNoise3D|WeightMapArrayPlaceholderTexture) /.test(line)));
    assert(run.contentFiles.some(item => item.path.endsWith('/WeightMapArrayPlaceholderTexture.uasset')),
      'The unused array asset must still be mounted');
    assert(run.textureUploads.mips.some(mip => mip.name === 'SSAORandomization' && mip.pass) &&
      run.textureUploads.mips.some(mip => mip.name === 'DefaultTexture' && mip.pass));
    for (const [name, bytes] of [
      ['ZeroUIntDummy', [0, 0, 0, 0]],
      ['StencilDummy', [255, 255, 255, 255]],
      ['MidGreyDummy', [0, 56, 0, 56, 0, 56, 0, 56]]
    ]) {
      const expected = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
      assert.equal(run.textureUploads.mips.find(mip => mip.name === name)?.actualSHA256, expected);
    }
    report.browserRuns.push({browser: run.browser, version: run.version, systemTexturesInitialized: true,
      engineObjectReferencesPassed: Boolean(run.ready || run.errors.some(error =>
        error.includes('UGameEngine::CreateGameWindow()')) || run.viewportConfigured),
      textures: run.textureUploads.textures,
      mips: run.textureUploads.mips.length, checkedBytes: run.textureUploads.checkedBytes,
      frames: run.frames, startupBlocker: run.startupBlocker});
  }
  const nullRuns = runtime.browserRuns.filter(run => run.rhi === 'null');
  assert.equal(nullRuns.length, 2);
  assert(nullRuns.every(run => run.pass && run.frames >= 9 && run.fileCacheVerified && !run.errors.length));
  report.systemDefaultsVerified = true;
  report.pass = true;
  report.boundary = 'Web omits unused system array/cube defaults, Perlin volume-noise initialization and the Landscape weight-map array default. Required ordinary system textures retain actual dimensions and scalar types; PreintegratedGF uses the existing RG8 fallback. Installed files are unchanged and the full desktop implementations are preserved. Native recorded/bypass guards and actual browser GPU byte readbacks are verified independently. Baseline unity membership is retained explicitly for the incremental link; a fresh complete normal Web UBT build is still unverified. No array/cube or new volume support, compressed shader execution, Engine frame or complete scene is implied.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-system-textures-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, systemDefaultsVerified: report.systemDefaultsVerified,
    nativeFormatChecks: report.nativeFormatChecks, browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
