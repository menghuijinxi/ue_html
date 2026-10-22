const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const id = option('project') || 'triplex-house-villa';
const suffix = option('report') || 'lighting-final';
assert(/^[a-z0-9-]+$/.test(id) && /^[a-z0-9-]+$/.test(suffix));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), checked: 0,
  reports: [], performanceAccepted: false, nativeVisualParityVerified: false, vramBudgetVerified: false};
const checked = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.file && value.sha256) {
    const file = path.resolve(value.file);
    if (!checked.has(file)) checked.set(file, audit(file).sha256);
    assert.equal(checked.get(file), value.sha256, file);
    ++report.checked;
  }
  for (const child of Object.values(value)) visit(child);
}
try {
  for (const name of ['web-engine-full-build-results.json', 'native-rendercore-build-results.json',
    'native-renderer-build-results.json', 'web-cook-shader-sources.json',
    ...['prepare', 'cook', 'stage', 'package', suffix, 'skylight-cache'].map(name => `web-project-${id}-${name}-results.json`),
    'web-engine-webgpu-es31-default-cook-results.json',
    'web-engine-webgpu-es31-default-stage-results.json',
    'web-default-template-package-results.json', 'web-default-scene-results.json',
    'triplex-textures-lighting-final.json']) {
    const file = path.join(directory, name), result = read(file);
    assert.equal(result.pass, true, file);
    visit(result);
    report.reports.push(audit(file));
  }
  const shaderSources = read(path.join(directory, 'web-cook-shader-sources.json'));
  for (const shader of shaderSources.files)
    visit({file: path.join(shaderSources.output, shader.relative), sha256: shader.sha256});
  const nativeTextureFile = path.join(__dirname, 'build/lighting-native-texture/texture-srv-results.json');
  const nativeTexture = read(nativeTextureFile);
  assert(nativeTexture.pass && nativeTexture.modes.length === 2 && nativeTexture.modes.every(mode =>
    mode.pass && mode.checks.length === 86 && mode.checks.every(check => check.pass) && !mode.errors.length &&
    mode.checks.some(check => check.name === 'ies-array-raster-clear-layer-isolation' && check.pass)));
  report.nativeTextureChecks = nativeTexture.modes.reduce((sum, mode) => sum + mode.checks.length, 0);
  report.nativeTexture = [nativeTextureFile, path.join(directory, 'lighting-native-texture.log'),
    path.resolve(__dirname, '../ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll')].map(audit);
  const textures = read(path.join(directory, 'triplex-textures-lighting-final.json'));
  const baseline = read(path.join(directory, 'triplex-textures-uncompressed.json'));
  assert.equal(textures.count, baseline.count);
  const original = new Map(baseline.textures.map(item => [item.file, item]));
  for (const item of textures.textures) {
    const previous = original.get(item.file);
    assert(previous && previous.width === item.width && previous.height === item.height &&
      previous.mips === item.mips && previous.faces === item.faces, item.file);
  }
  assert(textures.estimatedBytes < baseline.estimatedBytes * 0.2);
  report.textures = {count: textures.count, multiMip: textures.multiMip, singleMip: textures.singleMip,
    compressedBytes: textures.estimatedBytes, expandedBytes: baseline.estimatedBytes};
  const cook = read(path.join(directory, `web-project-${id}-cook-results.json`));
  assert.equal(cook.disabledSkyLight, false);
  assert(cook.skyLightCapture && cook.skyLightInventory && cook.skyLightLog);
  for (const entry of [cook.skyLightCapture, cook.skyLightInventory, cook.skyLightLog]) visit(entry);
  const log = fs.readFileSync(cook.skyLightLog.file, 'utf8');
  assert(log.includes('WEB_SKY_CAPTURE: component=') && !/Error:|Handled ensure|Fatal error/.test(log));
  const native = /brightness=([0-9.e+-]+) sh0=\(([0-9.e+-]+),([0-9.e+-]+),([0-9.e+-]+)\)/.exec(log);
  assert(native, 'Native capture values must be recorded');
  const values = native.slice(1).map(Number);
  assert(values.every(Number.isFinite) && values[0] > 0);
  report.nativeCapture = {brightness: values[0], sh0: values.slice(1), bytes: fs.statSync(cook.skyLightCapture.file).size};
  const runtime = read(path.join(directory, `web-project-${id}-${suffix}-results.json`));
  assert(runtime.lightingControlsRequired && runtime.localLightsRequired);
  assert(runtime.runs.length === 2 && runtime.runs.every(run => run.pass && run.lighting &&
    run.textureCompressionVerified && !run.gpu.errors.length && !run.gpu.deviceLosses.length));
  report.browsers = runtime.runs.map(run => {
    assert(run.skyCaptureLog.some(line => line.includes('WEB_SKY_CAPTURE: loaded') && line.includes(native[0])));
    assert(run.pixels.interiorMean > 18 && run.pixels.interiorVisibleFraction > 0.65);
    assert(run.pixels.interiorMean - run.lighting['sky-off'].pixels.interiorMean > 8);
    assert(Math.abs(run.pixels.interiorMean - run.lighting.restored.pixels.interiorMean) < 5);
    const local = run.lighting['local-off'].difference, restored = run.lighting.restored.difference;
    assert(local.rms > 2 && local.changedFraction > 0.02 && local.rms > restored.rms * 3 && restored.rms < 3);
    return {browser: run.browser, camera: run.camera, interior: run.pixels,
      skyOff: run.lighting['sky-off'].pixels, localOff: run.lighting['local-off'].pixels,
      fps: run.performance.engineFps};
  });
  const cache = read(path.join(directory, `web-project-${id}-skylight-cache-results.json`));
  assert(cache.runs.length === 2 && cache.runs.every(run => run.pass && run.omitted === 1 && run.frames < 2));
  const beforeFile = path.join(directory, `web-project-${id}-lighting-before-results.json`);
  const before = read(beforeFile);
  report.before = before.runs.map(run => {
    visit(run.screenshot);
    return {browser: run.browser, screenshot: run.screenshot, pixels: run.pixels};
  });
  report.boundary = 'Verifies native HDRI coefficients, matching browser capture values, interior visibility, ' +
    'SkyLight/local-light off/restoration controls, missing capture rejection, BC GPU uploads, ' +
    'IES array layer isolation, preserved BC mip chains, default-scene regression and audited current inputs. ' +
    'Native desktop visual parity, Lumen GI, performance and total VRAM remain separate acceptance work.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
report.uniqueFiles = checked.size;
const file = path.join(directory, `${id}-lighting-audit-results.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checked: report.checked, uniqueFiles: report.uniqueFiles,
  file, failure: report.failure}, null, 2));
