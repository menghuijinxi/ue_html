const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {decode} = require('./web-shader-code.js');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const build = path.join(__dirname, 'build');
const reports = [];
const platformMode = process.env.P1_PLATFORM === '1';
for (const kind of platformMode ? ['ue-platform-full', 'ue-platform-material'] : ['ue-full', 'ue-material']) {
  const source = path.join(build, kind), output = path.join(build, `${kind}-worker`);
  const baseline = read(path.join(source, 'web-manifest.json'));
  const worker = read(path.join(source, 'worker/worker-results.json'));
  assert(baseline.pass && worker.pass, `${kind}: baseline or worker failed`);
  assert(worker.officialFormatDiscovery && worker.officialPreprocessAndInputHash &&
    worker.officialWorkerFormatVersions, 'Official Web format registration missing');
  assert.equal(worker.targetPlatformRegistration.name, 'WebGPUShaderHost');
  for (const flag of ['canCookPackages', 'canPackage', 'canBuildGame', 'runtimeSdkInstalled']) {
    assert.equal(worker.targetPlatformRegistration[flag], false, 'Shader host claims runtime support');
  }
  const registration = platformMode ? read(path.join(source, 'platform-registration.json')) : null;
  if (registration) {
    assert(registration.pass && !registration.runtimeCookEnabled && !registration.isPreviewPlatform);
    assert.equal(registration.name, baseline.shaderPlatform);
    assert.equal(registration.enum, baseline.shaderPlatformEnum);
  }
  fs.mkdirSync(output, {recursive: true});
  const cases = baseline.cases.map(item => {
    const compiled = worker.cases.find(candidate => candidate.name === item.name);
    assert(compiled?.pass && compiled.compiled === (item.converted ?? item.pass), `${item.name}: worker result differs`);
    if (!compiled.compiled) {
      assert(item.expectedRejection && compiled.expectedRejection);
      assert(compiled.errors.some(error => /WebGPU conversion:/.test(error)), 'Conversion diagnostics missing');
      return {...item, workerVerified: true, workerErrors: compiled.errors};
    }
    const bytes = fs.readFileSync(path.join(source, 'worker', compiled.packet));
    assert.deepEqual(bytes, fs.readFileSync(path.join(source, 'worker', `${item.name}.editor.webshader`)),
      'Worker bytecode differs from in-process ShaderFormat output');
    const packet = decode(bytes, registration);
    assert.equal(packet.metadata.formatVersion, worker.formatVersion);
    assert.equal(packet.metadata.frequency, item.frequency);
    if (registration) {
      assert.equal(packet.metadata.shaderPlatform, registration.name);
      assert.equal(packet.metadata.shaderPlatformEnum, registration.enum);
      assert.equal(packet.metadata.shaderPlatformPropertiesHash, registration.propertiesHash);
      for (const [field, value] of Object.entries({name: 'SP_VULKAN_SM5',
        enum: registration.enum ^ 1, propertiesHash: registration.propertiesHash ^ 1,
        format: registration.format === 'SF_WEBGPU_ES31' ? 'SF_WEBGPU_SM5' : 'SF_WEBGPU_ES31'})) {
        assert.throws(() => decode(bytes, {...registration, [field]: value}),
          /platform\/configuration mismatch/);
      }
    }
    const sort = values => [...values].sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(sort(packet.metadata.ueParameterMap), sort(item.ueParameterMap), 'Worker parameter map differs');
    assert.deepEqual(packet.metadata.reflection, item.reflection, 'Worker WGSL reflection differs');
    for (const field of ['bits', 'textures', 'samplers', 'srvs', 'uavs', 'layoutHashes']) {
      assert.deepEqual(packet.metadata.resourceTable[field], item.resourceTable[field], 'Worker resource table differs');
    }
    for (const native of item.spirvBindings) {
      const reflected = packet.metadata.spirvBindings.find(binding => binding.name === native.name);
      assert(reflected, 'Native descriptor missing from Worker metadata');
      for (const field of ['group', 'binding', 'descriptorType', 'size', 'paddedSize']) {
        assert.equal(reflected[field], native[field], 'Worker native descriptor changed');
      }
    }
    for (const entry of item.uniformResourceEntries || []) {
      if (!item.ueParameterMap.some(parameter => parameter.type === 1 && parameter.name === entry.uniformBuffer)) continue;
      assert(packet.metadata.uniformResourceEntries.some(candidate =>
        candidate.name === entry.name && candidate.uniformBuffer === entry.uniformBuffer &&
        candidate.resourceIndex === entry.resourceIndex && candidate.type === entry.type),
      'Worker uniform resource entry differs');
    }
    const sha = value => crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(sha(packet.wgsl), item.wgslSha256, 'Worker WGSL differs from standalone conversion');
    fs.copyFileSync(path.join(source, 'worker', compiled.packet), path.join(output, compiled.packet));
    // Reject corrupted packets using the same decoder that runs in the browser.
    assert.throws(() => decode(bytes.subarray(0, 27)), /truncated/);
    const badMagic = Buffer.from(bytes); badMagic.writeUInt32LE(0, 0);
    assert.throws(() => decode(badMagic), /magic/);
    const badVersion = Buffer.from(bytes); badVersion.writeUInt32LE((worker.formatVersion ^ 1) >>> 0, 16);
    assert.throws(() => decode(badVersion), /mismatch/);
    const badLength = Buffer.from(bytes); badLength.writeUInt32LE(0xffffffff, 24);
    assert.throws(() => decode(badLength), /lengths/);
    return {...item, packet: compiled.packet, packetSha256: sha(bytes), packetBytes: bytes.length,
      workerVerified: true, inputHash: compiled.inputHash, outputHash: compiled.outputHash};
  });
  for (const artifact of baseline.uniformArtifacts || []) {
    fs.copyFileSync(path.join(source, artifact.filename), path.join(output, artifact.filename));
  }
  if (baseline.uniformLayoutArtifact) {
    const artifact = baseline.uniformLayoutArtifact;
    const file = path.join(source, artifact.filename);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), artifact.sha256);
    fs.copyFileSync(file, path.join(output, artifact.filename));
  }
  const report = {...baseline, kind: `${kind}-worker-bytecode`, cases,
    compilerExecution: platformMode ?
      'Unmodified ShaderCompileWorker executable with isolated static platform map and WebGPUShaderFormat DLL' :
      'Unmodified stock ShaderCompileWorker with custom WebGPUShaderFormat DLL',
    shaderCompileWorkerIPCVerified: true, format: worker.format, formatVersion: worker.formatVersion,
    workerProtocol: {input: worker.inputVersion, output: worker.outputVersion, compression: worker.taskCompression},
    officialFormatDiscovery: worker.officialFormatDiscovery,
    officialPreprocessAndInputHash: worker.officialPreprocessAndInputHash,
    officialWorkerFormatVersions: worker.officialWorkerFormatVersions,
    targetPlatformRegistration: worker.targetPlatformRegistration,
    shaderPlatformRegistration: registration, independentWebShaderPlatformVerified: !!registration,
    workerRegistrationBoundary: worker.registrationBoundary, completeWebShaderFormat: false,
    badInputVersionRejected: worker.badInputVersionRejected, badFormatVersionRejected: worker.badFormatVersionRejected,
    packetDecoderNegativeChecks: cases.filter(item => item.packet).length * 4,
    packetPlatformNegativeChecks: registration ? cases.filter(item => item.packet).length * 4 : 0};
  fs.writeFileSync(path.join(output, 'web-manifest.json'), JSON.stringify(report, null, 2));
  reports.push({kind, pass: report.pass, jobs: cases.length, packets: cases.filter(item => item.packet).length,
    officialFormatRegistrationVerified: true,
    independentWebShaderPlatformVerified: !!registration,
    expectedRejections: cases.filter(item => item.expectedRejection).length,
    decoderNegativeChecks: report.packetDecoderNegativeChecks,
    decoderPlatformNegativeChecks: report.packetPlatformNegativeChecks});
}
const moduleBuild = read(path.join(__dirname, 'results/worker-module-build.json'));
const root = path.resolve(__dirname, '../..');
const compilerInputs = [
  moduleBuild.worker,
  path.join(path.dirname(moduleBuild.worker), 'ShaderCompileWorker-VulkanShaderFormat.dll'),
  path.join(path.dirname(moduleBuild.worker), 'ShaderCompileWorker-ShaderCompilerCommon.dll'),
  path.join(root, '.tools/dawn-v20261009.190412/bin/tint.exe'),
  path.join(root, '.tools/dawn-v20261009.190412/bin/tint_info.exe'),
].map(file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
fs.writeFileSync(path.join(__dirname, `results/${platformMode ? 'ue-platform' : 'ue-webformat'}-build-results.json`), JSON.stringify({
  pass: reports.length === 2 && reports.every(report => report.pass), reports,
  module: moduleBuild, compilerInputs,
  staticPlatformHost: platformMode ? read(path.join(__dirname, 'results/static-platform-host-build.json')) : null,
}, null, 2));
console.log(JSON.stringify(reports, null, 2));
