const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, textureMipUploadsVerified: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false, browserRuns: [], sources: [audit(__filename)]};
try {
  const runtimeFile = path.join(results, 'web-engine-webgpu-es31-results.json'), runtime = read(runtimeFile);
  const buildFile = path.join(results, 'web-engine-webgpu-link-results.json'), build = read(buildFile);
  const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json'), cook = read(cookFile);
  assert(runtime.es31LibraryIntegrationVerified && runtime.textureMipUploadsVerified &&
    runtime.sourceFiles.every(valid) && valid(runtime.buildReport) &&
    runtime.buildReport.sha256 === sha(buildFile) && valid(runtime.webgpuStageReport));
  assert(build.pass && build.sourceFiles.every(valid) && build.linkInputs.every(valid) &&
    build.products.every(valid) && valid(build.moduleCompileLog) && valid(build.log));
  assert(cook.pass && cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && cook.products.every(valid));
  const stage = read(runtime.webgpuStageReport.file);
  assert(stage.pass && valid(stage.cookReport) && stage.cookReport.sha256 === sha(cookFile));
  report.runtime = audit(runtimeFile); report.build = audit(buildFile); report.cook = audit(cookFile);
  const conversion = path.join(cook.output, 'ShaderConversion');
  const decalJobs = fs.readdirSync(conversion, {withFileTypes: true}).filter(item => item.isDirectory())
    .map(item => path.join(conversion, item.name, 'input.json')).filter(file => fs.existsSync(file))
    .map(file => ({file, input: read(file)}))
    .filter(({input}) => input.shader.startsWith('DefaultDeferredDecalMaterial_'));
  assert(decalJobs.some(({input}) => input.shader.includes('/FDeferredDecalMobilePS/')));
  assert(!decalJobs.some(({input}) => input.shader.includes('/FDeferredDecalEmissivePS/')));
  assert(runtime.materialPolicyMatched);
  report.defaultDecalVariantMatched = {material: 'DefaultDeferredDecalMaterial',
    runtimeShader: 'FDeferredDecalMobilePS', cookJobs: decalJobs.map(({file, input}) =>
      ({shader: input.shader, input: audit(file)}))};
  report.sources.push(...[
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.h',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUTransitions.cpp',
    'tests/web-platform/capture-web-texture-uploads.cjs'
  ].map(name => audit(path.join(root, name))));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.stagedContentVerified && run.deviceReady && !run.gpuValidationErrors.length);
    assert(!run.consoleLog.some(line => line.includes('Failed to find shader map for default material')));
    const uploads = run.textureUploads;
    assert(uploads.pass && !uploads.failures.length && uploads.mips.every(mip =>
      mip.pass && /^[0-9a-f]{64}$/.test(mip.expectedSHA256) && mip.expectedSHA256 === mip.actualSHA256));
    const groups = new Map();
    for (const mip of uploads.mips) {
      if (!groups.has(mip.name)) groups.set(mip.name, []);
      groups.get(mip.name).push(mip);
    }
    const required = [
      ['WhiteSquareTexture', 32, 32, 6, 'bgra8unorm-srgb'],
      ['GradientTexture0', 32, 32, 6, 'bgra8unorm-srgb'],
      ['Black', 32, 32, 6, 'bgra8unorm-srgb'],
      ['RobotoDistanceField_PageA', 512, 256, 1, 'r8unorm'],
      ['T_Default_Material_Grid_M', 512, 512, 10, 'bgra8unorm'],
      ['T_Default_Material_Grid_N', 256, 256, 9, 'bgra8unorm'],
      ['DefaultDiffuse', 1024, 1024, 11, 'bgra8unorm-srgb'],
      ['BlackDummy', 1, 1, 1, 'bgra8unorm'],
      ['ZeroUIntDummy', 1, 1, 1, 'r32uint'],
      ['BlackAlphaOneDummy', 1, 1, 1, 'bgra8unorm'],
      ['DefaultNormal8Bit', 1, 1, 1, 'bgra8unorm'],
      ['PerlinNoiseGradient', 128, 128, 1, 'bgra8unorm'],
      ['MaxFP16Depth', 1, 1, 1, 'rgba16float'],
      ['StencilDummy', 1, 1, 1, 'rgba8uint'],
      ['MidGreyDummy', 1, 1, 1, 'rgba16float'],
      ['SobolSampling', 32, 16, 1, 'r16uint'],
      ['AsciiTexture', 768, 8, 1, 'r8unorm'],
      ['PreintegratedGF', 128, 32, 1, 'rg8unorm'],
      ['SSAORandomization', 64, 64, 1, 'rg8unorm']
    ];
    const pixelBytes = {r8unorm: 1, r16uint: 2, rg8unorm: 2, rgba16float: 8};
    for (const [name, width, height, count, format] of required) {
      const mips = groups.get(name);
      assert(mips && mips.length === count, `Every resident mip must be uploaded: ${name}`);
      for (let level = 0; level < count; ++level) {
        const mip = mips.find(item => item.mip === level);
        assert(mip && mip.width === Math.max(1, width >> level) &&
          mip.height === Math.max(1, height >> level) && mip.format === format);
        assert.equal(mip.checkedBytes, mip.width * mip.height * (pixelBytes[format] || 4));
        assert(run.consoleLog.some(line => line.includes(`P3_TEXTURE_UPLOAD name=${name} mip=${level} `)));
      }
    }
    assert(uploads.textures >= 23 && uploads.mips.length >= 65 && uploads.checkedBytes >= 7576620);
    assert.equal(uploads.textures, groups.size);
    assert.equal(uploads.writes, uploads.mips.length);
    assert.equal(uploads.mips.reduce((sum, mip) => sum + mip.checkedBytes, 0), uploads.checkedBytes);
    assert(!run.consoleLog.some(line => /NumOfNonStreamingMips > MaxRuntimeMipCount/.test(line)));
    // The nonuniform gradient and font distinguish real texels from cleared or all-white storage.
    assert(new Set(groups.get('GradientTexture0').map(mip => mip.actualSHA256)).size > 1);
    assert.notEqual(groups.get('GradientTexture0')[0].actualSHA256, groups.get('WhiteSquareTexture')[0].actualSHA256);
    report.browserRuns.push({browser: run.browser, version: run.version, pass: true,
      textures: uploads.textures, mips: uploads.mips.length, checkedBytes: uploads.checkedBytes,
      gpuValidationErrors: run.gpuValidationErrors, startupBlocker: run.startupBlocker, frames: run.frames,
      uploads: uploads.mips});
  }
  assert.deepEqual(report.browserRuns[0].uploads, report.browserRuns[1].uploads);
  const nullRuns = runtime.browserRuns.filter(run => run.rhi === 'null');
  assert.equal(nullRuns.length, 2);
  assert(nullRuns.every(run => run.pass && run.frames >= 9 && run.fileCacheVerified && !run.errors.length));
  report.textureMipUploadsVerified = true;
  report.pass = true;
  report.boundary = 'Actual shared C++ WebGPURHI creates textures and uploads cooked UTexture2D data through write locks, plus ordinary system defaults through bulk-data and subresource initializers. The observer forwards original WebGPU calls and retains GPU handles for raw per-mip copy/map readback. Both browsers compare all observed resident mips byte-for-byte against CPU upload data, including R32_UINT, RGBA8_UINT, R16_UINT, RGBA16F, R8 and RG8 system defaults. Counts are recorded from each run; startup must reach at least all 23 initial textures and 65 mips, and both browser readbacks must match. This verifies stored texels, not sampling/filtering, multi-mip SRVs, later texture updates, streaming, arrays/cubes, shader decompression or a rendered Engine frame. Texture memory queries are descriptor estimates, not driver allocation sizes.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-texture2d-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, textureMipUploadsVerified: report.textureMipUploadsVerified,
    browsers: report.browserRuns.map(({browser, textures, mips, checkedBytes}) =>
      ({browser, textures, mips, checkedBytes})), failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
