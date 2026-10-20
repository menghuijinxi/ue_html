const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const {decode} = require('./web-shader-code.js');
const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi');
const shaderDirectory = path.join(__dirname, 'build/ue-platform-full-worker');
const materialDirectory = path.join(__dirname, 'build/ue-platform-material-worker');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const requiredChecks = [
  'indexed16-64x64', 'indexed32-64x64', 'indexed16-96x48', 'indexed32-96x48',
  'uniform-update-per-draw-and-texture-copy',
  'texture-update-preserves-earlier-draw', 'texture-update-after-draw',
  'loose-parameter-snapshots-and-scissor', 'reversed-z-depth-occlusion',
  'alpha-blend', 'color-write-mask',
  'compute-uav-subrange-and-dispatch-order', 'buffer-copy-offsets-and-sentinels',
  'reject-uav-offset-alignment', 'reject-uav-out-of-range', 'reject-unsupported-typed-uav',
  'batched-finalize-submit-order', 'reject-wrong-shader-frequency', 'reject-truncated-bytecode',
  'reject-bad-magic', 'reject-metadata-shaderPlatformPropertiesHash', 'reject-metadata-shaderPlatformEnum',
  'reject-metadata-formatVersion', 'reject-metadata-schema', 'reject-sampling-active-render-attachment',
];
const requiredMaterialChecks = ['UnlitColor', 'UnlitTexture'].flatMap(material => [
  'runtime-member-offsets', 'default-index16', 'index32', 'uniform-override', 'primitive-transform',
  'view-projection', 'large-world-origin', 'pre-exposure',
  material === 'UnlitColor' ? 'constant-update-per-draw' : 'resource-reference-update-per-draw',
].map(name => `${material}-${name}`)).concat([
  'resource-table-current-texture', 'resource-table-current-sampler',
  'reject-resource-table-unbound-uniform', 'reject-resource-table-layout-hash',
  'reject-resource-table-missing-layout-hash', 'reject-resource-table-offset',
  'reject-resource-table-member-token', 'reject-resource-table-missing-token',
  'reject-resource-table-null-texture', 'reject-resource-table-null-sampler',
  'reject-direct-uniform-wrong-slot', 'reject-resource-table-wrong-rhi-type',
  'uniform-owns-resources-after-caller-release', 'resource-table-resource-lifetime',
]);
const requiredTransitionChecks = [
  'reject-sampling-without-transition', 'reject-copy-source-without-transition',
  'reject-end-before-begin', 'reject-release-before-end', 'reject-double-begin',
  'reject-overlapping-transition', 'reject-resource-use-during-split', 'reject-readback-during-split',
  'split-begin-keeps-old-state', 'split-pending-survives-submit', 'reject-double-end',
  'split-end-enables-sampling', 'reject-transition-inside-render-pass',
  'reject-internal-copy-inside-render-pass', 'reject-active-attachment-sampling',
  'combined-read-states', 'unknown-before-resolves-current-state', 'rtv-to-srv-sampled-pixels',
  'copy-preserves-earlier-render', 'return-to-rtv-reuses-target', 'reject-depth-write-in-read-only-pass',
  'depth-write-to-read-only-preserves-occlusion', 'reject-wrong-access-before',
  'reject-invalid-batch-atomically', 'reject-async-compute-transition', 'reject-allow-during-pass-flag',
  'reject-unknown-after-state', 'reject-read-write-access-combination',
  'reject-multiple-write-access-combination', 'reject-texture-uav-capability', 'reject-buffer-rtv-capability',
  'reject-mip-out-of-range', 'reject-array-slice-out-of-range', 'reject-stencil-plane',
  'reject-ignore-after-state', 'reject-reserved-resource-commit', 'reject-null-transition-resource',
  'reject-duplicate-resource-transition', 'reject-transient-aliasing',
  'reject-uav-copy-without-transition', 'reject-dispatch-in-copy-state', 'uav-same-state-and-reuse-order',
  'uav-to-copy-preserves-previous-write', 'internal-buffer-readback-preserves-state',
  'transition-owns-resource-after-caller-release', 'transition-resource-lifetime-copy',
  'reject-out-of-order-command-submission', 'ordered-submission-after-rejection', 'transition-lifecycle-balanced',
];
const report = {pass: false};
try {
  const runtime = read(path.join(output, 'rhi-results.json'));
  assert(runtime.pass && runtime.hostRHI === 'Null' && runtime.probeRHI === 'WebGPU');
  assert.equal(runtime.globalRHIReplaced, false);
  assert.equal(runtime.completeUEScene, false);
  assert.equal(runtime.fullRHITransitionsImplemented, false);
  assert.equal(runtime.singleQueueTransitionsImplemented, true);
  assert.equal(runtime.materialResourceTableImplemented, true);
  assert.equal(runtime.fullLocalVertexFactoryImplemented, false);
  assert.equal(runtime.uniformViewImplemented, false);
  assert.deepEqual(runtime.errors, []);
  assert.deepEqual(runtime.checks.map(check => check.name).sort(), [...requiredChecks].sort());
  assert(runtime.checks.every(check => check.pass));
  assert.deepEqual(runtime.coreCounters, {draws: 19, dispatches: 2, finalizedCommandLists: 29,
    submittedCommandLists: 29, bindGroups: 40, checkedValues: 164352});
  const material = runtime.material;
  assert(material.pass && material.profile === 'WebVertexInput');
  assert.equal(material.fullLocalVertexFactoryImplemented, false);
  assert.equal(material.uniformViewImplemented, false);
  assert.deepEqual(material.checks.map(check => check.name).sort(), [...requiredMaterialChecks].sort());
  assert(material.checks.every(check => check.pass));
  assert.equal(material.shaderCount, 4);
  assert.equal(material.pipelineCount, 2);
  assert.equal(material.draws, 19);
  assert.equal(material.bindGroups, 38);
  assert.equal(material.resourceTableBindings, 20);
  assert.equal(material.checkedValues, 1114112);
  const transitions = runtime.transitions;
  assert(transitions.pass);
  assert.equal(transitions.globalTransitionDispatchImplemented, false);
  assert.equal(transitions.asyncComputeImplemented, false);
  assert.equal(transitions.transientAliasingImplemented, false);
  assert.deepEqual(transitions.checks.map(check => check.name).sort(), [...requiredTransitionChecks].sort());
  assert(transitions.checks.every(check => check.pass));
  for (const name of ['created', 'begun', 'ended', 'released']) assert.equal(transitions[name], 15);
  assert.equal(transitions.accessChecks, 26);
  assert.equal(transitions.draws, 5);
  assert.equal(transitions.dispatches, 3);
  assert.equal(transitions.bindGroups, 13);
  assert.equal(transitions.checkedValues, 66056);
  for (const name of ['Created', 'Begun', 'Ended', 'Released']) assert.equal(runtime[`transitions${name}`], 24);
  assert.equal(runtime.pendingTransitionCount, 0);
  assert.equal(runtime.resourceAccessChecks, 305);
  assert.equal(runtime.draws, 43);
  assert.equal(runtime.dispatches, 5);
  assert.equal(runtime.checkedValues, 1344520);
  assert.equal(runtime.finalizedCommandLists, runtime.submittedCommandLists);
  assert.equal(runtime.submittedCommandLists, 130);
  assert.equal(runtime.bindGroups, 91);
  assert.equal(runtime.resourceTableBindings, 20);
  const log = fs.readFileSync(path.join(results, 'ue-rhi-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_(?:RHI|MATERIAL|TRANSITION)[^\r\n]*pass=0/.test(log));
  const pixels = fs.readFileSync(path.join(output, 'indexed-64x64.rgba'));
  assert.equal(pixels.length, 64 * 64 * 4);
  const palette = [[32, 64, 96, 255], [96, 128, 160, 255], [160, 192, 224, 255], [224, 64, 128, 255]];
  for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) {
    const offset = (y * 64 + x) * 4;
    assert.deepEqual([...pixels.subarray(offset, offset + 4)], palette[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)]);
  }
  const png = new PNG({width: 64, height: 64});
  pixels.copy(png.data);
  const image = path.join(results, 'ue-rhi-indexed-64x64.png');
  fs.writeFileSync(image, PNG.sync.write(png));
  const transitionRaw = path.join(output, 'transition-sampled-64x64.rgba');
  const transitionPixels = fs.readFileSync(transitionRaw);
  assert.equal(transitionPixels.length, 16384);
  for (let offset = 0; offset < transitionPixels.length; offset += 4)
    [64, 128, 191, 255].forEach((value, channel) =>
      assert(Math.abs(transitionPixels[offset + channel] - value) <= (channel === 3 ? 0 : 1)));
  const transitionPreview = new PNG({width: 64, height: 64});
  transitionPixels.copy(transitionPreview.data);
  const transitionImage = path.join(results, 'ue-rhi-transition-sampled-64x64.png');
  fs.writeFileSync(transitionImage, PNG.sync.write(transitionPreview));
  const materialImages = ['UnlitColor', 'UnlitTexture'].map(name => {
    const raw = path.join(output, `${name}-64x64.rgba`);
    const data = fs.readFileSync(raw);
    assert.equal(data.length, 16384);
    for (let y = 0; y < 64; ++y) for (let x = 0; x < 64; ++x) {
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
      const color = !inside ? [0, 0, 0, 0] : name === 'UnlitColor' ? [32, 128, 191, 0] :
        [...palette[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)].slice(0, 3), 0];
      const offset = (y * 64 + x) * 4;
      color.forEach((value, channel) => assert(Math.abs(data[offset + channel] - value) <= (channel === 3 ? 0 : 2)));
    }
    const preview = new PNG({width: 64, height: 64});
    data.copy(preview.data);
    // The mobile shader writes alpha zero. Preview RGB opaquely, like the browser canvas.
    for (let offset = 3; offset < preview.data.length; offset += 4) preview.data[offset] = 255;
    const file = path.join(results, `ue-rhi-${name}-64x64.png`);
    fs.writeFileSync(file, PNG.sync.write(preview));
    return {name, file, previewAlphaMode: 'opaque', imageSha256: sha(file), rawPixelsSha256: sha(raw)};
  });
  const engine = process.env.UE_ENGINE_ROOT || 'H:/UE_5.8/Engine';
  const platform = read(path.join(results, 'ue-platform-build-results.json'));
  const dawn = read(path.join(results, 'dawn-host-build.json'));
  assert(platform.pass && platform.staticPlatformHost.pass && dawn.pass);
  const packets = [
    'FScreenVS', 'FScreenPS', 'FClearReplacementVS', 'FClearReplacementPS',
    'FClearReplacementVS_Depth', 'WebFallback_FClearReplacementCS_Buffer_Uint',
  ].map(name => {
    const file = path.join(shaderDirectory, `${name}.webshader`);
    const {metadata} = decode(fs.readFileSync(file));
    assert.equal(metadata.shaderPlatform, 'SP_WEBGPU_SM5');
    assert.equal(metadata.shaderPlatformEnum, 47);
    return {name, sha256: sha(file), shaderPlatform: metadata.shaderPlatform,
      shaderPlatformEnum: metadata.shaderPlatformEnum,
      shaderPlatformPropertiesHash: metadata.shaderPlatformPropertiesHash, formatVersion: metadata.formatVersion};
  });
  const materialManifest = read(path.join(materialDirectory, 'web-manifest.json'));
  assert(materialManifest.pass && materialManifest.independentWebShaderPlatformVerified);
  const layoutArtifact = materialManifest.uniformLayoutArtifact;
  assert.equal(sha(path.join(materialDirectory, layoutArtifact.filename)), layoutArtifact.sha256);
  const layouts = read(path.join(materialDirectory, layoutArtifact.filename));
  assert.equal(layouts.source, 'UE runtime FRHIUniformBufferLayout');
  const materialPackets = materialManifest.cases.filter(item => item.vertexProfile === 'WebVertexInput' ||
    item.name.includes('_WebVertexInput_')).map(item => {
    const file = path.join(materialDirectory, item.packet);
    assert.equal(sha(file), item.packetSha256);
    const {metadata} = decode(fs.readFileSync(file), materialManifest.shaderPlatformRegistration);
    assert.equal(metadata.shaderPlatform, 'SP_WEBGPU_ES31');
    assert.equal(metadata.shaderPlatformEnum, 46);
    for (const parameter of metadata.ueParameterMap) {
      const layout = layouts[`${item.material}:${parameter.name}`];
      assert.equal(layout.hash, metadata.resourceTable.layoutHashes[parameter.bufferIndex]);
    }
    return {name: item.name, sha256: sha(file), shaderPlatform: metadata.shaderPlatform,
      shaderPlatformEnum: metadata.shaderPlatformEnum, shaderPlatformPropertiesHash: metadata.shaderPlatformPropertiesHash,
      formatVersion: metadata.formatVersion, layoutHashes: metadata.resourceTable.layoutHashes};
  });
  assert.equal(materialPackets.length, 4);
  for (const artifact of materialManifest.uniformArtifacts)
    assert.equal(sha(path.join(materialDirectory, artifact.filename)), artifact.sha256);
  const binaries = path.join(root, '.tools/ue58-web-platform-host/Engine/Binaries/Win64');
  assert.equal(sha(path.join(binaries, 'WebGPUHost.dll')), dawn.dllSha256);
  const dxc = path.join(root, '.tools/dxc-v1.9.2609/bin/x64');
  for (const name of ['dxcompiler.dll', 'dxil.dll'])
    assert.equal(sha(path.join(binaries, name)), sha(path.join(dxc, name)));
  const moduleFile = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll');
  const sourceDirectory = path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI');
  const sourceFiles = [
    'WebGPURHI.Build.cs', 'Public/WebGPURHIProbe.h', 'Private/WebGPUUnsupportedRHI.h',
    'Private/WebGPUDynamicRHI.h', 'Private/WebGPUDynamicRHI.cpp', 'Private/WebGPURHIProbe.cpp',
    'Private/WebGPUProbeUtils.h', 'Private/WebGPUMaterialProbe.h', 'Private/WebGPUMaterialProbe.cpp',
    'Private/WebGPUTransitions.cpp', 'Private/WebGPUTransitionProbe.h', 'Private/WebGPUTransitionProbe.cpp',
    'Private/WebGPUGlobalProbe.h', 'Private/WebGPUGlobalProbe.cpp',
    'Private/WebGPUGlobalScope.h', 'Private/WebGPUGlobalScope.cpp', 'Private/WebGPUViewport.cpp',
    'Private/WebGPUViewportProbe.h', 'Private/WebGPUViewportProbe.cpp', 'Private/WebGPUBreadcrumbs.cpp',
    'Private/WebGPUTextureSRVProbe.h', 'Private/WebGPUTextureSRVProbe.cpp',
    'Private/WebGPUBufferSRVProbe.h', 'Private/WebGPUBufferSRVProbe.cpp',
    'Private/WebGPUBufferUAVProbe.h', 'Private/WebGPUBufferUAVProbe.cpp',
    'Private/WebGPUUint4Probe.h', 'Private/WebGPUUint4Probe.cpp',
    'Private/WebGPUStructuredProbe.h', 'Private/WebGPUStructuredProbe.cpp',
    'Private/WebGPUFloat4Probe.h', 'Private/WebGPUFloat4Probe.cpp',
    'Private/WebGPUBufferLock.cpp', 'Private/WebGPUBufferLockProbe.h', 'Private/WebGPUBufferLockProbe.cpp',
    'Private/WebGPUTexture3DProbe.h', 'Private/WebGPUTexture3DProbe.cpp',
    'Private/WebGPUTextureUintProbe.h', 'Private/WebGPUTextureUintProbe.cpp',
  ].map(file => ({file, sha256: sha(path.join(sourceDirectory, file))}));
  Object.assign(report, {
    pass: true, date: new Date().toISOString(), runtime, shaderPackets: packets, materialPackets, sourceFiles,
    materialUniformLayoutArtifact: layoutArtifact, materialUniformArtifacts: materialManifest.uniformArtifacts,
    materialImages,
    hostEngine: read(path.join(engine, 'Build/Build.version')),
    targetEngineCommit: cp.execFileSync('git', ['-C', path.join(root, 'reference-engine'), 'rev-parse', 'HEAD'],
      {encoding: 'utf8'}).trim(),
    dawn, moduleFile, moduleSha256: sha(moduleFile),
    copiedDxcSha256: sha(path.join(binaries, 'dxcompiler.dll')),
    image, imageSha256: sha(image), rawPixelsSha256: sha(path.join(output, 'indexed-64x64.rgba')),
    transitionImage, transitionImageSha256: sha(transitionImage), transitionRawPixelsSha256: sha(transitionRaw),
    boundary: 'Installed UE 5.8.0 host; target 5.8.3 shader snapshot. Isolated native RHI probe, no global RHI replacement or browser UE runtime.',
  });
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.runtime?.checks.length,
  materialChecks: report.runtime?.material.checks.length,
  transitionChecks: report.runtime?.transitions.checks.length,
  draws: report.runtime?.draws, dispatches: report.runtime?.dispatches,
  checkedValues: report.runtime?.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
