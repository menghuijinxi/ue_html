const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, archiveStructureVerified: false,
  shaderPayloadDecompressionVerified: false, globalShaderMapDeserializationVerified: false,
  webgpuShaderCookVerified: false, browserShaderLibraryLoadVerified: false, completeUEScene: false,
  sourceFiles: [__filename,
    'H:/UE_5.8/Engine/Source/Runtime/RenderCore/Public/ShaderCodeArchive.h',
    'H:/UE_5.8/Engine/Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeArchive.cpp',
    'H:/UE_5.8/Engine/Source/Runtime/RenderCore/Private/ShaderLibrary/ShaderCodeLibraryUtilities.cpp',
  ].map(audit)};

try {
  const cookFile = path.join(results, 'web-engine-webgpu-es31-cook-results.json');
  const cook = read(cookFile);
  assert(valid(cook.log) && cook.sourceFiles.every(valid) && cook.hostProducts.every(valid));
  assert.equal(cook.shaderFailures.filter(item => item.detail.shader.startsWith('Global/')).length, 0);
  report.materialFailureDiagnostics = cook.shaderFailures.filter(item => !item.detail.shader.startsWith('Global/')).length;
  const log = fs.readFileSync(cook.log.file, 'utf8');
  const prefix = 'Global-SF_WEBGPU_ES31-SP_WEBGPU_ES31';
  const archiveFile = path.join(cook.output, 'UEShaderHost/Content', `ShaderArchive-${prefix}.ushaderbytecode`);
  const metadataFile = path.join(cook.output, 'UEShaderHost/Metadata/ShaderLibrarySource',
    `ShaderArchive-${prefix}.ushaderbytecode`);
  const mapFile = path.join(cook.output, 'Engine/GlobalShaderCache-SP_WEBGPU_ES31.bin');
  const assetFile = path.join(cook.output, 'UEShaderHost/Content', `ShaderAssetInfo-${prefix}.assetinfo.json`);
  const bytes = fs.readFileSync(archiveFile);
  assert.equal(sha(archiveFile), sha(metadataFile));
  assert.equal(bytes.readUInt32LE(0), 3);
  // FShaderHash is serialized as 64 bits; code entries are field-wise, without struct padding.
  let cursor = 4;
  const arrays = {};
  for (const [name, stride] of [
    ['mapHashes', 8], ['shaderHashes', 8], ['maps', 16],
    ['shaders', 17], ['preload', 16], ['indices', 4],
  ]) {
    const count = bytes.readInt32LE(cursor);
    assert(count > 0 && count <= bytes.length / stride, name);
    cursor += 4;
    arrays[name] = {count, offset: cursor, stride};
    cursor += count * stride;
    assert(cursor <= bytes.length, name);
  }
  assert.equal(arrays.mapHashes.count, arrays.maps.count);
  assert.equal(arrays.shaderHashes.count, arrays.shaders.count);
  const hashes = array => Array.from({length: array.count}, (_, i) =>
    bytes.subarray(array.offset + i * array.stride, array.offset + (i + 1) * array.stride).toString('hex'));
  assert.equal(new Set(hashes(arrays.mapHashes)).size, arrays.mapHashes.count);
  assert.equal(new Set(hashes(arrays.shaderHashes)).size, arrays.shaderHashes.count);
  const sizes = [], frequencies = {}, compressed = [];
  let codeOffset = 0;
  for (let i = 0; i < arrays.shaders.count; ++i) {
    const offset = arrays.shaders.offset + i * arrays.shaders.stride;
    const start = Number(bytes.readBigUInt64LE(offset));
    const size = bytes.readUInt32LE(offset + 8), uncompressedSize = bytes.readUInt32LE(offset + 12);
    const frequency = bytes[offset + 16];
    assert([0, 3, 5].includes(frequency));
    assert.equal(start, codeOffset);
    assert(size > 0 && uncompressedSize >= size && cursor + start + size <= bytes.length);
    sizes.push(size);
    if (size !== uncompressedSize) compressed.push(i);
    frequencies[frequency] = (frequencies[frequency] || 0) + 1;
    codeOffset += size;
  }
  assert.equal(cursor + codeOffset, bytes.length, 'Archive payload must have no missing or trailing data');
  const referenced = new Set();
  let totalReferences = 0;
  for (let i = 0; i < arrays.maps.count; ++i) {
    const offset = arrays.maps.offset + i * arrays.maps.stride;
    const first = bytes.readUInt32LE(offset), count = bytes.readUInt32LE(offset + 4);
    const preload = bytes.readUInt32LE(offset + 8), preloadCount = bytes.readUInt32LE(offset + 12);
    assert(count > 0 && first + count <= arrays.indices.count);
    assert(preload + preloadCount <= arrays.preload.count);
    totalReferences += count;
    for (let j = first; j < first + count; ++j) {
      const index = bytes.readUInt32LE(arrays.indices.offset + j * 4);
      assert(index < arrays.shaders.count);
      referenced.add(index);
    }
  }
  assert.equal(totalReferences, arrays.indices.count);
  assert.equal(referenced.size, arrays.shaders.count);
  for (let i = 0; i < arrays.preload.count; ++i) {
    const offset = arrays.preload.offset + i * arrays.preload.stride;
    const start = Number(bytes.readBigInt64LE(offset)), size = Number(bytes.readBigInt64LE(offset + 8));
    assert(Number.isSafeInteger(start) && Number.isSafeInteger(size));
    assert(start >= 0 && size > 0 && start + size <= codeOffset);
  }
  const assets = read(assetFile);
  assert.equal(assets.AssetInfoVersion, 2);
  assert.equal(assets.ShaderCodeToAssets.length, arrays.maps.count);
  const assetHashes = new Set(assets.ShaderCodeToAssets.map(item => item.ShaderMapHash.toLowerCase()));
  const serializedHashes = hashes(arrays.mapHashes).map(hex =>
    Buffer.from(hex, 'hex').readBigUInt64LE(0).toString(16).padStart(16, '0'));
  assert(serializedHashes.every(hash => assetHashes.has(hash)));
  const maps = log.match(/Unique Shadermaps: (\d+)/), shaders = log.match(/Total Shaders: (\d+), Unique Shaders: (\d+)/);
  assert(maps && shaders);
  assert.equal(arrays.maps.count, Number(maps[1]));
  assert.equal(totalReferences, Number(shaders[1]));
  assert.equal(arrays.shaders.count, Number(shaders[2]));
  report.cook = audit(cookFile);
  report.artifacts = [mapFile, archiveFile, metadataFile, assetFile].map(file =>
    ({...audit(file), bytes: fs.statSync(file).size}));
  assert(report.artifacts.every(item => item.bytes > 0));
  report.archiveVersion = 3;
  report.shaderMaps = arrays.maps.count;
  report.shaderReferences = totalReferences;
  report.uniqueShaders = arrays.shaders.count;
  report.compressedShaders = compressed.length;
  report.frequencies = frequencies;
  report.headerBytes = cursor;
  report.codeBytes = codeOffset;
  report.hostParameterMismatchObserved = log.includes('ConservativeDepthFillSize') &&
    log.includes('has unbound parameters not represented in the parameter struct');
  report.materialJobCacheAssertionObserved = /Assertion failed: Job \[File:.*ShaderCompilerJobCache.cpp/.test(log);
  assert.equal(report.hostParameterMismatchObserved, false);
  assert.equal(report.materialJobCacheAssertionObserved, false);
  assert(cook.jobCacheDDCDisabled && log.includes('Set CVar [[r.ShaderCompiler.JobCacheDDC:0]]') &&
    log.includes('Set CVar [[r.ShaderCompiler.DebugValidateJobCache:1]]'));
  assert.equal(cook.pass, true);
  assert.equal(cook.exitCode, 0);
  assert.equal(cook.shaderFailures.length, 0);
  assert(!log.includes('Ensure condition failed:'));
  report.archiveStructureVerified = true;
  report.pass = true;
  report.boundary = 'Verifies the emitted ES31 Global archive structure and agreement with asset metadata and native Global library log counts. Actual Cook succeeds without conversion failures, parameter ensures or job-cache assertions. Per-job DDC is disabled with full job validation retained. Compression is counted from actual entry sizes; this check does not decode payloads or deserialize the Global map. Full uncompressed payload and browser checks are separate. Scene rendering remains unverified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-global-archive-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, archiveStructureVerified: report.archiveStructureVerified,
    shaderMaps: report.shaderMaps, uniqueShaders: report.uniqueShaders,
    shaderReferences: report.shaderReferences, compressedShaders: report.compressedShaders,
    hostParameterMismatchObserved: report.hostParameterMismatchObserved,
    materialJobCacheAssertionObserved: report.materialJobCacheAssertionObserved,
    failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
