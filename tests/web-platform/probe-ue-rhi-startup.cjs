const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const host = path.join(root, '.tools/ue58-web-platform-host/Engine');
const results = path.join(__dirname, 'results');
const logFile = path.join(results, 'ue-rhi-startup-host.log');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const report = {diagnosticVerified: false, startupSucceeded: false, importedRHIStartupImplemented: false,
  completeBrowserUERuntime: false, globalShaderLoadingTested: false, globalShaderCompilationTested: false};
try {
  const config = path.join(host, 'Platforms/WebGPU/Config/WebGPUEngine.ini');
  assert.equal(sha(config), sha(path.join(__dirname, 'platform-extension/Config/WebGPUEngine.ini')));
  if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  const args = [path.join(root, 'tests/ue-shader-host/UEShaderHost.uproject'), '-run=WebShaderProbe',
    '-WebRHIStartupProbe', '-PlatformRHI=WebGPU', '-AllowCommandletRendering', '-norhithread', '-onethread',
    '-unattended', '-nosplash', '-nop4', '-NoSound', '-NoShaderCompile', `-abslog=${logFile}`];
  const run = cp.spawnSync(path.join(host, 'Binaries/Win64/UnrealEditor-Cmd.exe'), args,
    {cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024});
  assert.ifError(run.error);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.equal(run.status, 3, 'Expected startup to stop at unsupported 2D array texture initialization');
  assert(log.includes('Using Forced RHI: WebGPU') && log.includes('Loading RHI module WebGPURHI') &&
    log.includes('RHI WebGPU with Feature Level SM5 is supported and will be used.'));
  assert(log.includes('P2_STARTUP factory selected WebGPU platform=47'));
  assert(log.includes('P2_STARTUP device initialized; initializing pre-RHI resources'));
  const textureSRVs = [...log.matchAll(/P2_STARTUP TextureSRV created name=(\S+) format=(\d+)/g)]
    .map(match => ({name: match[1], format: Number(match[2])}));
  assert.deepEqual(textureSRVs, ['FWhiteTexture', 'FBlackTextureWithSRV', 'FBlackTexture']
    .map(name => ({name, format: 37})));
  const bufferSRVs = [...log.matchAll(
    /P2_STARTUP BufferSRV created name=(\S+) format=(\d+) stride=(\d+) count=(\d+) offset=(\d+)/g)]
    .map(match => ({name: match[1], format: Number(match[2]), stride: Number(match[3]),
      count: Number(match[4]), offset: Number(match[5])}));
  const expectedBuffers = [{name: 'EmptyVertexBuffer', format: 28, stride: 4, count: 4, offset: 0},
    {name: 'EmptyUInt4VertexBuffer', format: 48, stride: 16, count: 1, offset: 0},
    {name: 'EmptyStructuredBuffer', format: 0, stride: 4, count: 4, offset: 0},
    {name: 'BlackFloat4StructuredBuffer', format: 0, stride: 16, count: 1, offset: 0},
    {name: 'BlackFloat4VertexBuffer', format: 1, stride: 16, count: 1, offset: 0}];
  assert.deepEqual(bufferSRVs, [...expectedBuffers,
    {name: 'WhiteVertexBuffer', format: 1, stride: 16, count: 1, offset: 0},
    {name: 'BlackVertexBuffer', format: 1, stride: 16, count: 1, offset: 0}]);
  const bufferUAVs = [...log.matchAll(
    /P2_STARTUP BufferUAV created name=(\S+) format=(\d+) stride=(\d+) count=(\d+) offset=(\d+)/g)]
    .map(match => ({name: match[1], format: Number(match[2]), stride: Number(match[3]),
      count: Number(match[4]), offset: Number(match[5])}));
  assert.deepEqual(bufferUAVs, expectedBuffers);
  const locks = [...log.matchAll(
    /P2_STARTUP BufferLock released name=(\S+) offset=(\d+) size=(\d+) mode=(\d+)/g)]
    .map(match => ({name: match[1], offset: Number(match[2]), size: Number(match[3]), mode: Number(match[4])}));
  assert.deepEqual(locks, [{name: 'WhiteVertexBufferWithRDG', offset: 0, size: 16, mode: 1}]);
  assert(log.includes('P2_STARTUP BufferLock requested name=WhiteVertexBufferWithRDG offset=0 size=16 mode=1'));
  const volumeUploads = [...log.matchAll(
    /P2_STARTUP Texture uploaded name=(\S+) dimension=(\d+) format=(\d+) depth=(\d+)/g)]
    .map(match => ({name: match[1], dimension: Number(match[2]), format: Number(match[3]), depth: Number(match[4])}))
    .filter(item => item.dimension === 2);
  assert.deepEqual(volumeUploads, [2, 2, 60].map(format =>
    ({name: 'BlackVolumeTexture3D', dimension: 2, format, depth: 1})));
  const description = log.match(
    /WebGPU texture creation unsupported: dimension=1 format=2 extent=1x1 depth=1 array=1 mips=1 samples=1 init=2 flags=0x8/)?.[0];
  assert(description && log.includes('FWebGPUDynamicRHI::RHICreateTextureInitializer()'));
  assert(!log.includes('P2_STARTUP pre-RHI resources initialized'));
  assert(!log.includes('P2_STARTUP optional default unregistered'));
  const minimalLogFile = path.join(results, 'ue-rhi-minimal-startup-host.log');
  if (fs.existsSync(minimalLogFile)) fs.unlinkSync(minimalLogFile);
  const minimalArgs = args.filter(arg => !arg.startsWith('-abslog='))
    .concat('-WebMinimalStartup', `-abslog=${minimalLogFile}`);
  const minimalRun = cp.spawnSync(path.join(host, 'Binaries/Win64/UnrealEditor-Cmd.exe'), minimalArgs,
    {cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024});
  assert.ifError(minimalRun.error);
  assert.equal(minimalRun.status, 3, 'Expected minimal startup to stop at the distance-field ByteAddress SRV');
  const minimalLog = fs.readFileSync(minimalLogFile, 'utf8');
  for (const marker of ['Using Forced RHI: WebGPU', 'Loading RHI module WebGPURHI',
    'P2_STARTUP factory selected WebGPU platform=47',
    'P2_STARTUP device initialized; initializing pre-RHI resources'])
    assert(minimalLog.includes(marker), `Minimal startup missing: ${marker}`);
  const optionalDefaults = [...minimalLog.matchAll(/P2_STARTUP optional default unregistered name=(\S+)/g)]
    .map(match => match[1]);
  assert.deepEqual(optionalDefaults, ['GBlackArrayTexture', 'GWhiteTextureCube', 'GBlackTextureCube',
    'GBlackTextureDepthCube', 'GBlackCubeArrayTexture', 'GBlackUintTexture']);
  assert(minimalLog.indexOf('P2_STARTUP optional default unregistered') <
    minimalLog.indexOf('P2_STARTUP device initialized; initializing pre-RHI resources'));
  const completedResources = text => [...text.matchAll(
    /P2_STARTUP (?:TextureSRV created|BufferSRV created|BufferUAV created|BufferLock released|Texture uploaded)[^\r\n]*/g)]
    .map(match => match[0]);
  const previousResources = completedResources(log);
  const minimalResources = completedResources(minimalLog);
  assert.deepEqual(minimalResources.slice(0, previousResources.length), previousResources,
    'Minimal startup must retain all previously verified defaults');
  assert.deepEqual(minimalResources.slice(previousResources.length),
    ['P2_STARTUP BufferSRV created name=FPrimitiveIdDummyBuffer format=28 stride=4 count=1 offset=0']);
  const omittedVertexSRVs = [...minimalLog.matchAll(
    /P2_STARTUP default vertex SRV omitted name=(\S+) bytes=(\d+) value=(\d+) gpuReadbackVerified=1/g)]
    .map(match => ({name: match[1], bytes: Number(match[2]), value: Number(match[3]), gpuReadbackVerified: true}));
  assert.deepEqual(omittedVertexSRVs, [
    {name: 'FNullColorVertexBuffer', bytes: 16, value: 255, gpuReadbackVerified: true},
    {name: 'FNullVertexBuffer', bytes: 12, value: 0, gpuReadbackVerified: true}]);
  const retainedRasterizers = [...minimalLog.matchAll(
    /P2_STARTUP rasterizer descriptor retained fill=(\d+) cull=(\d+) msaa=(\d+)/g)]
    .map(match => ({fill: Number(match[1]), cull: Number(match[2]), msaa: Number(match[3])}));
  const retainedSamplers = [...minimalLog.matchAll(
    /P2_STARTUP sampler descriptor retained filter=(\d+) comparison=(\d+)/g)]
    .map(match => ({filter: Number(match[1]), comparison: Number(match[2])}));
  assert(retainedRasterizers.some(item => item.fill !== 2 && item.msaa === 1));
  assert(retainedSamplers.some(item => item.filter !== 0));
  const minimalDescription = minimalLog.match(
    /P2_STARTUP BufferSRV requested name=FDFDummyByteAddress format=0 bufferType=4 stride=0 count=0 offset=0/)?.[0];
  assert(minimalDescription);
  assert(minimalLog.includes('WebGPU BufferSRV unsupported: Only non-structured ShaderResource buffers with Typed uint32/uint4/float4 SRVs are implemented') &&
    minimalLog.includes('FWebGPUDynamicRHI::RHICreateShaderResourceView()'));
  assert(!minimalLog.includes('WebGPU texture creation unsupported:'));
  assert(!minimalLog.includes('P2_STARTUP BufferSRV created name=FNullColorVertexBuffer'));
  assert(!minimalLog.includes('P2_STARTUP BufferSRV created name=FNullVertexBuffer'));
  assert(!minimalLog.includes('P2_STARTUP pre-RHI resources initialized'));
  const deferredStateCases = [];
  for (const test of [
    {name: 'rasterizer', flag: 'WebRejectDeferredRasterizer',
      functionName: 'FWebGPUDynamicRHI::RHICreateGraphicsPipelineState()', error: 'Rasterizer.FillMode == FM_Solid'},
    {name: 'sampler', flag: 'WebRejectDeferredSampler',
      functionName: 'FWebGPUDynamicRHI::ResolveSampler()',
      error: 'WebGPU sampler binding only supports point filtering without mip bias or comparison'}]) {
    const testLogFile = path.join(results, `ue-rhi-deferred-${test.name}-host.log`);
    if (fs.existsSync(testLogFile)) fs.unlinkSync(testLogFile);
    const testArgs = [args[0], '-run=WebShaderProbe', '-WebRHIProbe', `-${test.flag}`,
      `-WebShaderDirectory=${path.join(__dirname, 'build/ue-platform-full-worker')}`,
      `-WebMaterialShaderDirectory=${path.join(__dirname, 'build/ue-platform-material-worker')}`,
      `-Output=${path.join(__dirname, `build/ue-rhi-deferred-${test.name}`)}`,
      '-nullrhi', '-norhithread', '-unattended', '-nosplash', '-nop4', '-NoSound', `-abslog=${testLogFile}`];
    const testRun = cp.spawnSync(path.join(host, 'Binaries/Win64/UnrealEditor-Cmd.exe'), testArgs,
      {cwd: root, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024});
    assert.ifError(testRun.error);
    assert.equal(testRun.status, 3, `Expected deferred ${test.name} use to be rejected`);
    const testLog = fs.readFileSync(testLogFile, 'utf8');
    const marker = `P2_DEFERRED_STATE ${test.name} descriptor retained; testing`;
    assert(testLog.includes(marker) && testLog.includes(test.error) && testLog.includes(test.functionName));
    assert(testLog.indexOf(marker) < testLog.indexOf('Assertion failed:'));
    assert(!testLog.includes('P2_RHI indexed16-64x64 pass='));
    deferredStateCases.push({name: test.name, descriptorRetained: true, unsupportedUseRejected: true,
      exitCode: testRun.status, rejectionFunction: test.functionName, args: testArgs,
      logFile: testLogFile, logSha256: sha(testLogFile)});
  }
  const moduleFile = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll');
  const sourceFile = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI/Private/WebGPUDynamicRHI.cpp');
  Object.assign(report, {diagnosticVerified: true, date: new Date().toISOString(), exitCode: run.status,
    importedModuleSelectionVerified: true, deviceCreationVerified: true, preRHIResourcesInitialized: false,
    preRHITextureSRVsCreated: textureSRVs, preRHIBufferSRVsCreated: bufferSRVs,
    preRHIBufferUAVsCreated: bufferUAVs, preRHIBufferLocksReleased: locks,
    preRHITexture3DUploads: volumeUploads,
    blocker: 'Texture2DArrayInitializer', resourceDescription: description,
    minimalStartup: {diagnosticVerified: true, startupSucceeded: false, exitCode: minimalRun.status,
      optionalDefaultPruningVerified: true, optionalDefaultsUnregistered: optionalDefaults,
      preRHIResourcesInitialized: false, blocker: 'DistanceFieldDummyByteAddressSRV',
      omittedVertexSRVs, defaultVertexBufferGPUReadbackBytes: 28,
      retainedRasterizers, retainedSamplers, deferredStateValidationVerified: true, deferredStateCases,
      additionalBufferSRVsCreated: [{name: 'FPrimitiveIdDummyBuffer', format: 28, stride: 4, count: 1, offset: 0}],
      resourceDescription: minimalDescription, args: minimalArgs,
      logFile: minimalLogFile, logSha256: sha(minimalLogFile),
      boundary: 'Explicit -WebMinimalStartup in the Win64 startup probe unregisters six audited optional defaults before InitPreRHIResources. Both default vertex buffers remain allocated and their 28 bytes are checked by GPU readback; only their unused RGBA8 SRVs are omitted while manual vertex fetch and vertex shader SRVs are disabled. State objects retain descriptors; native sampler creation is deferred until binding, and unsupported rasterizer/sampler use is separately rejected. This is not a production Renderer/Uniform capability guard. Startup now stops at the distance-field ByteAddress dummy SRV; no Raw Buffer or additional texture/filter/rasterizer features were added. Scene rendering, source-platform integration and browser UE runtime remain unverified.'},
    sourceFile, sourceSha256: sha(sourceFile),
    args, moduleFile, moduleSha256: sha(moduleFile), configSha256: sha(config), logFile, logSha256: sha(logFile),
    boundary: 'Real RHIInit -> Windows PlatformCreateDynamicRHI -> ImportedRHI module -> Init. Three default texture SRVs, seven Buffer SRVs and five Buffer UAVs created; WhiteVertexBufferWithRDG encodes a 16-byte WriteOnly upload. Two BGRA8 and one RGBA8_UINT BlackVolumeTexture3D BulkData initializers submit queue.writeTexture uploads. Expected fatal at Texture2DArray BGRA8 1x1 array=1 initializer creation. This startup does not read back those defaults; separate native probes verify buffer ordering and float/integer volume data. Pre-RHI resources, engine boot, Renderer and browser UE runtime remain incomplete.'});
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-startup-diagnostic.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({diagnosticVerified: report.diagnosticVerified, startupSucceeded: false,
  importedModuleSelectionVerified: report.importedModuleSelectionVerified,
  unprunedBlocker: report.blocker, minimalStartupDiagnosticVerified: report.minimalStartup?.diagnosticVerified,
  optionalDefaultsUnregistered: report.minimalStartup?.optionalDefaultsUnregistered,
  blocker: report.minimalStartup?.blocker, resourceDescription: report.minimalStartup?.resourceDescription,
  failure: report.failure}));
process.exitCode = report.diagnosticVerified ? 0 : 1;
