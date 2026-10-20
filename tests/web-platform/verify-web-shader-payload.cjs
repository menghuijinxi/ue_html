const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..'), results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sha = file => digest(fs.readFileSync(file));
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, uncompressedArchivesVerified: false,
  browserShaderCreationVerified: false, browserClearDrawSubmittedVerified: false,
  engineLoopBrowserTickVerified: false, completeUEScene: false,
  sources: [audit(__filename)], reports: [], libraries: [], browserRuns: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};

function archive(file, decode) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt32LE(0), 3);
  let cursor = 4;
  const arrays = {};
  for (const [name, stride] of [
    ['mapHashes', 8], ['shaderHashes', 8], ['maps', 16], ['shaders', 17], ['preload', 16], ['indices', 4]
  ]) {
    const count = bytes.readInt32LE(cursor);
    assert(count > 0 && count <= bytes.length / stride, name);
    cursor += 4;
    arrays[name] = {count, offset: cursor, stride};
    cursor += count * stride;
    assert(cursor <= bytes.length);
  }
  assert.equal(arrays.mapHashes.count, arrays.maps.count);
  assert.equal(arrays.shaderHashes.count, arrays.shaders.count);
  const hash = (name, index) => bytes.subarray(arrays[name].offset + index * 8,
    arrays[name].offset + (index + 1) * 8).toString('hex');
  const entries = new Map(), maps = new Map(), wgsl = new Set();
  let offset = 0, compressed = 0, attachments = 0;
  for (let index = 0; index < arrays.shaders.count; ++index) {
    const entry = arrays.shaders.offset + index * 17;
    const start = Number(bytes.readBigUInt64LE(entry)), size = bytes.readUInt32LE(entry + 8);
    const uncompressed = bytes.readUInt32LE(entry + 12), frequency = bytes[entry + 16];
    assert.equal(start, offset);
    assert(size > 0 && uncompressed >= size && cursor + start + size <= bytes.length);
    assert([0, 3, 5].includes(frequency));
    compressed += size !== uncompressed ? 1 : 0;
    const key = hash('shaderHashes', index);
    assert(!entries.has(key));
    entries.set(key, {frequency, uncompressed});
    if (decode) {
      assert.equal(size, uncompressed, 'Every Web library entry must use UE uncompressed storage');
      const code = bytes.subarray(cursor + start, cursor + start + size);
      const optional = code.readInt32LE(size - 4);
      assert(optional >= 4 && optional <= size - 28);
      const payloadSize = size - optional;
      let attachment = payloadSize;
      while (attachment < size - 4) {
        assert(attachment + 5 <= size - 4);
        const length = code.readUInt32LE(attachment + 1);
        attachment += 5 + length;
        ++attachments;
        assert(attachment <= size - 4);
      }
      assert.equal(attachment, size - 4);
      assert.equal(code.readUInt32LE(0), 0x53475057);
      assert.equal(code.readUInt32LE(4), 1);
      assert.equal(code.readUInt32LE(8), 28);
      assert.equal(code.readUInt32LE(12), frequency);
      const metadataSize = code.readUInt32LE(20), wgslSize = code.readUInt32LE(24);
      assert.equal(28 + metadataSize + wgslSize, payloadSize);
      const metadata = JSON.parse(code.subarray(28, 28 + metadataSize).toString('utf8'));
      assert.equal(metadata.formatVersion, code.readUInt32LE(16));
      assert.equal(metadata.frequency, frequency);
      assert.equal(metadata.shaderPlatformEnum, 46);
      assert.equal(metadata.format, 'SF_WEBGPU_ES31');
      assert.equal(metadata.shaderPlatform, 'SP_WEBGPU_ES31');
      assert.equal(metadata.bindingContractVerified, true);
      assert(wgslSize > 0 && metadata.webEntry);
      wgsl.add(digest(code.subarray(28 + metadataSize, payloadSize)));
    }
    offset += size;
  }
  assert.equal(cursor + offset, bytes.length);
  let references = 0;
  for (let index = 0; index < arrays.maps.count; ++index) {
    const entry = arrays.maps.offset + index * 16;
    const first = bytes.readUInt32LE(entry), count = bytes.readUInt32LE(entry + 4);
    const preload = bytes.readUInt32LE(entry + 8), preloadCount = bytes.readUInt32LE(entry + 12);
    assert(count > 0 && first + count <= arrays.indices.count);
    assert(preload + preloadCount <= arrays.preload.count);
    const members = [];
    for (let member = first; member < first + count; ++member) {
      const shader = bytes.readUInt32LE(arrays.indices.offset + member * 4);
      assert(shader < arrays.shaders.count);
      members.push(hash('shaderHashes', shader));
    }
    const key = hash('mapHashes', index);
    assert(!maps.has(key));
    maps.set(key, members);
    references += count;
  }
  assert.equal(references, arrays.indices.count);
  for (let index = 0; index < arrays.preload.count; ++index) {
    const entry = arrays.preload.offset + index * 16;
    const start = Number(bytes.readBigUInt64LE(entry)), size = Number(bytes.readBigUInt64LE(entry + 8));
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(size) && size > 0 && start + size <= offset);
  }
  return {entries, maps, wgsl, compressed, attachments, bytes: bytes.length, codeBytes: offset};
}

try {
  const previous = load('web-engine-webgpu-es31-cook-results-before-uncompressed-shaders-20261020');
  const cook = load('web-engine-webgpu-es31-cook-results');
  assert(previous.pass && previous.products.every(valid) && valid(previous.log));
  assert(cook.pass && cook.exitCode === 0 && cook.shaderFailures.length === 0 &&
    cook.sourceFiles.every(valid) && cook.hostProducts.every(valid) && cook.products.every(valid) &&
    valid(cook.log) && valid(cook.moduleBuildLog) && valid(cook.shaderInventory.artifact) &&
    cook.validateShaderJobCache && cook.jobCacheDDCDisabled && cook.shaderMapDDCDisabled &&
    cook.arguments.includes('-noshaderddc'));
  assert.deepEqual(cook.shaderInventory.detail, previous.shaderInventory.detail);
  const expectedWGSL = new Set();
  const jobs = cookReport => {
    const found = new Map(), directory = path.join(cookReport.output, 'ShaderConversion');
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const input = read(path.join(directory, entry.name, 'input.json'));
      const hash = sha(path.join(directory, entry.name, 'output.wgsl'));
      if (found.has(input.shader)) assert.equal(found.get(input.shader), hash);
      found.set(input.shader, hash);
    }
    return found;
  };
  const currentJobs = jobs(cook);
  assert.deepEqual(currentJobs, jobs(previous), 'Retain every Cook job identity and exact WGSL');
  assert.equal(currentJobs.size, 1049);
  report.unchangedJobs = currentJobs.size;
  const directory = path.join(cook.output, 'ShaderConversion');
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const file = path.join(directory, entry.name, 'output.wgsl');
    assert(!fs.existsSync(path.join(directory, entry.name, 'failure.json')));
    expectedWGSL.add(sha(file));
  }
  for (const [library, shaderCount] of [['Global', 726], ['UEShaderHost', 108]]) {
    const name = `ShaderArchive-${library}-SF_WEBGPU_ES31-SP_WEBGPU_ES31.ushaderbytecode`;
    const beforeFile = path.join(previous.output, 'UEShaderHost/Content', name);
    const file = path.join(cook.output, 'UEShaderHost/Content', name);
    const before = archive(beforeFile, false), after = archive(file, true);
    assert.equal(after.entries.size, shaderCount);
    assert(before.compressed > 0 && after.compressed === 0);
    assert.deepEqual(after.entries, before.entries, 'Keep every shader hash, frequency and uncompressed size');
    assert.deepEqual(after.maps, before.maps, 'Keep every map hash and its ordered shader references');
    assert([...after.wgsl].every(value => expectedWGSL.has(value)));
    assert.equal(sha(file), sha(path.join(cook.output, 'UEShaderHost/Metadata/ShaderLibrarySource', name)));
    report.libraries.push({library, before: audit(beforeFile), archive: audit(file),
      shaderMaps: after.maps.size, uniqueShaders: after.entries.size,
      previouslyCompressedShaders: before.compressed, compressedShaders: after.compressed,
      bytesBefore: before.bytes, bytes: after.bytes, optionalAttachments: after.attachments,
      hashesAndMapReferencesUnchanged: true, payloadHeadersAndWGSLVerified: true});
  }
  report.uncompressedArchivesVerified = true;
  const native = load('web-static-uniforms-native-results');
  assert(native.pass && native.sources.every(valid) && native.products.every(valid) &&
    native.fixtures.every(valid) && native.runs.every(run =>
      run.exitCode === 0 && valid(run.runtime) && valid(run.log)));
  const global = read(native.runs.find(run => run.mode === 'global').runtime.file);
  const expectedChecks = [
    'shader-packet-ue-attachments-accepted', 'shader-packet-empty-attachments-accepted',
    'shader-packet-negative-footer-rejected', 'shader-packet-oversize-footer-rejected',
    'shader-packet-attachment-overrun-rejected', 'shader-packet-wrapped-frequency-rejected',
    'shader-packet-trailing-byte-rejected', 'shader-packet-payload-truncation-rejected'
  ];
  assert.equal(global.modes.length, 2);
  for (const mode of global.modes) {
    assert(mode.pass && mode.errors.length === 0);
    const checks = mode.checks.filter(check => check.name.startsWith('shader-packet-'));
    assert.deepEqual(checks.map(check => check.name).sort(), [...expectedChecks].sort());
    assert(checks.every(check => check.pass));
    assert(mode.checks.some(check =>
      check.name === 'global-default-rasterizer-permission-keeps-single-sample' && check.pass));
  }
  report.nativePacketChecks = 16;
  report.nativeSingleSampleChecks = 2;
  const beforeWrapper = load('web-engine-webgpu-es31-results-before-shader-attachments-20261020');
  const wrapperFailures = beforeWrapper.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(wrapperFailures.length, 2);
  assert(wrapperFailures.every(run => run.canvas.shaderModules === 0 &&
    run.consoleLog.some(line => line.includes('Web shader header/frequency invalid')) &&
    run.errors.some(error => error.includes('FShaderCodeArchive::CreateShader') &&
      error.includes('RHICreateVertexShader'))));
  const beforeRaster = load('web-engine-webgpu-es31-results-before-single-sample-raster-20261020');
  const rasterFailures = beforeRaster.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(rasterFailures.length, 2);
  assert(rasterFailures.every(run => run.canvas.shaderModules === 2 &&
    run.canvas.renderPipelines === 0 && run.canvas.drawCalls === 0 &&
    run.consoleLog.some(line => line.includes('!Rasterizer.bAllowMSAA')) &&
    run.errors.some(error => error.includes('RHICreateGraphicsPipelineState') &&
      error.includes('ClearQuadSetup'))));
  const stage = load('web-engine-webgpu-es31-stage-results');
  assert(stage.pass && valid(stage.cookReport) && stage.cookReport.sha256 ===
    sha(path.join(results, 'web-engine-webgpu-es31-cook-results.json')) &&
    valid(stage.pack) && valid(stage.manifest) && stage.sourceFiles.every(valid));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.es31LibraryIntegrationVerified && runtime.sourceFiles.every(valid) &&
    valid(runtime.buildReport) && valid(runtime.webgpuStageReport) &&
    runtime.browserShaderCreationVerified && runtime.browserClearDrawSubmittedVerified);
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.stagedContentVerified && run.textureUploads.pass && run.gpuValidationErrors.length === 0);
    assert(!run.consoleLog.some(line => /Could not decompress shader with Oodle|Web does not support Oodle/.test(line)));
    assert(run.canvas.shaderModules >= 2 && run.canvas.renderPipelines >= 1 && run.canvas.drawCalls >= 1 &&
      run.engineQueueCompletion.pass && run.canvas.submittedCommandBuffers >= 15 &&
      run.canvas.debugMarkers.some(marker => marker.label === 'CanvasClear'));
    report.browserRuns.push({browser: run.browser, frames: run.frames,
      shaderModules: run.canvas.shaderModules, renderPipelines: run.canvas.renderPipelines,
      drawCalls: run.canvas.drawCalls, startupBlocker: run.startupBlocker});
  }
  report.browserShaderCreationVerified = true;
  report.browserClearDrawSubmittedVerified = true;
  const rhiSource = path.join(root,
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp');
  const rhi = fs.readFileSync(rhiSource, 'utf8');
  assert(rhi.includes('check(In.NumSamples == 1 &&') && !rhi.includes('!Rasterizer.bAllowMSAA'));
  report.sources.push(...[
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPUShaderFormat/Private/WebGPUShaderFormat.cpp',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp',
    'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUGlobalProbe.cpp',
    'H:/UE_5.8/Engine/Source/Runtime/RenderCore/Private/ShaderCore.cpp',
    'H:/UE_5.8/Engine/Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp'
  ].map(file => audit(path.isAbsolute(file) ? file : path.join(root, file))));
  report.pass = true;
  report.boundary = 'Actual normal Cook emits both loose Web libraries with every entry uncompressed. All 1049 job identities/WGSL, shader hashes, frequencies, uncompressed sizes, map hashes and ordered references match the preserved compressed Cook; payload headers, optional attachments and duplicated metadata archives are validated. The Web format owns compression policy and cache invalidation. Native codecs and archive runtime are unchanged. Shared RHI accepts both standalone packets and UE optional-data framing, with 16 native positive/negative checks in two command modes. Two native default-rasterizer checks retain single-sample rendering; NumSamples==1 remains enforced. Both actual browser Engines create two shader modules and a graphics pipeline, issue a CanvasClear draw, submit its commands and complete the queue before texture audit readbacks, with zero GPU validation errors. Actual clear pixels, physical presentation, Engine ticks and a scene frame are not verified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-shader-payload-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, uncompressedArchivesVerified: report.uncompressedArchivesVerified,
    browserShaderCreationVerified: report.browserShaderCreationVerified, libraries: report.libraries,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
