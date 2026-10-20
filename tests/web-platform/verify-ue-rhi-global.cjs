const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {PNG} = require('pngjs');
const {decode} = require('./web-shader-code.js');

const root = path.resolve(__dirname, '../..');
const results = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-rhi-global');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const requiredChecks = [
  'module-global-device-and-mode', 'web-platform-and-serial-capabilities', 'global-shader-bytecode-hashes',
  'global-graphics-cache-reuses-pso', 'commands-obey-recording-mode', 'global-transition-private-data',
  'executor-submits-draws-and-keeps-split', 'global-marker-releases-transition',
  'global-vertex-declaration-cache', 'global-indexed-sampling-readback', 'global-copy-readback',
  'continue-drawing-after-readback', 'ordinary-command-lists-record-before-submit',
  'queued-command-lists-reuse-global-cache', 'queued-command-lists-execute-in-order',
  'global-compute-cache-reuses-pso', 'global-dispatch-copy-and-uav-reuse', 'executor-end-frame',
  'empty-flush-preserves-order', 'all-global-transitions-auto-released', 'global-gpu-validation-clean',
  'host-rhi-globals-and-mode-restored',
];
const report = {pass: false};
try {
  const core = read(path.join(results, 'ue-rhi-build-results.json'));
  const runtime = read(path.join(output, 'global-rhi-results.json'));
  assert(core.pass && core.runtime.pass);
  assert(runtime.pass && runtime.temporaryGlobalDispatchVerified && runtime.hostRHI === 'Null');
  assert.equal(runtime.importedRHIStartupImplemented, false);
  assert.equal(runtime.completeUERendererImplemented, false);
  assert.equal(runtime.browserEngineImplemented, false);
  assert.deepEqual(runtime.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  const images = runtime.modes.map(mode => {
    assert(mode.pass);
    assert.deepEqual(mode.errors, []);
    assert.deepEqual(mode.checks.map(check => check.name).sort(), [...requiredChecks].sort());
    assert(mode.checks.every(check => check.pass));
    assert.equal(mode.draws, 6);
    assert.equal(mode.dispatches, 2);
    assert.equal(mode.bindGroups, 14);
    assert.equal(mode.graphicsPipelinesCreated, 2);
    assert.equal(mode.computePipelinesCreated, 1);
    assert.equal(mode.privateDataSize, 16);
    assert.equal(mode.checkedValues, 66048);
    assert.equal(mode.finalizedCommandLists, mode.submittedCommandLists);
    assert.equal(mode.submittedCommandLists, mode.mode === 'recorded' ? 22 : 28);
    for (const event of ['Created', 'Begun', 'Ended', 'Released'])
      assert.equal(mode[`transitions${event}`], 6);
    const raw = path.join(output, `${mode.mode}-64x64.rgba`);
    const pixels = fs.readFileSync(raw);
    assert.equal(pixels.length, 16384);
    for (let offset = 0; offset < pixels.length; offset += 4)
      [64, 128, 191, 255].forEach((value, channel) =>
        assert(Math.abs(pixels[offset + channel] - value) <= (channel === 3 ? 0 : 1)));
    const png = new PNG({width: 64, height: 64});
    pixels.copy(png.data);
    const image = path.join(results, `ue-rhi-global-${mode.mode}-64x64.png`);
    fs.writeFileSync(image, PNG.sync.write(png));
    return {mode: mode.mode, raw, rawSha256: sha(raw), image, imageSha256: sha(image)};
  });
  assert.equal(images[0].rawSha256, images[1].rawSha256);
  const log = fs.readFileSync(path.join(results, 'ue-rhi-global-host.log'), 'utf8');
  assert(!/Assertion failed:|Fatal error:|P2_GLOBAL[^\r\n]*pass=0/.test(log));
  assert(log.includes('Object subsystem successfully closed.') && log.includes('LogExit: Exiting.'));
  assert.equal(sha(core.moduleFile), core.moduleSha256);
  for (const file of core.sourceFiles)
    assert.equal(sha(path.join(root, 'tests/ue-shader-host/Plugins/WebGPUShader/Source/WebGPURHI', file.file)),
      file.sha256);
  const packets = ['FScreenVS', 'FScreenPS', 'FClearReplacementVS', 'FClearReplacementPS',
    'WebFallback_FClearReplacementCS_Buffer_Uint'].map(name => {
    const file = path.join(__dirname, 'build/ue-platform-full-worker', `${name}.webshader`);
    const {metadata} = decode(fs.readFileSync(file));
    assert.equal(metadata.shaderPlatformEnum, 47);
    assert.equal(sha(file), core.shaderPackets.find(packet => packet.name === name).sha256);
    return {name, sha256: sha(file)};
  });
  const host = path.join(root, '.tools/ue58-web-platform-host/Engine/Binaries/Win64');
  assert.equal(sha(path.join(host, 'WebGPUHost.dll')), core.dawn.dllSha256);
  const commandlet = path.join(root, 'tests/ue-shader-host/Source/UEShaderHost/Private/WebShaderProbeCommandlet.cpp');
  const commandletDLL = path.join(root, 'tests/ue-shader-host/Binaries/Win64/UnrealEditor-UEShaderHost.dll');
  Object.assign(report, {
    pass: true, date: new Date().toISOString(), runtime, images, shaderPackets: packets,
    moduleFile: core.moduleFile, moduleSha256: core.moduleSha256, sourceFiles: core.sourceFiles,
    commandlet, commandletSha256: sha(commandlet), commandletDLLSha256: sha(commandletDLL),
    targetEngineCommit: core.targetEngineCommit, hostEngine: core.hostEngine, dawn: core.dawn,
    checksPassed: runtime.modes.reduce((sum, mode) => sum + mode.checks.length, 0),
    checkedValues: runtime.modes.reduce((sum, mode) => sum + mode.checkedValues, 0),
    boundary: 'NullRHI host temporarily swaps its global RHI on the render thread, restores globals and clears caches. ImportedRHI startup and complete Renderer are pending.',
  });
} catch (error) {
  report.failure = error.stack;
}
fs.writeFileSync(path.join(results, 'ue-rhi-global-build-results.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checks: report.checksPassed,
  checkedValues: report.checkedValues, failure: report.failure}));
process.exitCode = report.pass ? 0 : 1;
