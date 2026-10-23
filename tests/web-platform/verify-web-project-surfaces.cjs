const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const suffix = option('report') || 'pbr-final';
const textureProbe = option('texture-probe') || 'pbr-native-texture';
const output = option('output') || 'triplex-house-villa-surfaces-audit-results';
const textureInventory = option('texture-inventory') || 'triplex-textures-pbr-final';
assert([suffix, textureProbe, output, textureInventory].every(value => /^[a-z0-9-]+$/.test(value)));
const text = file => {
  const bytes = fs.readFileSync(file);
  return bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
};
const read = file => JSON.parse(text(file));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename), checked: 0,
  reports: [], nativeVisualParityVerified: false, performanceAccepted: false, vramBudgetVerified: false};
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
function evidence(name) {
  const file = path.join(directory, name), result = read(file);
  assert.equal(result.pass, true, file);
  visit(result);
  report.reports.push(audit(file));
  return result;
}
try {
  for (const name of ['web-engine-full-build-results.json', 'native-rendercore-build-results.json',
    'native-renderer-build-results.json', 'web-cook-shader-sources.json',
    ...['prepare', 'cook', 'stage', 'package'].map(name => `web-project-triplex-house-villa-${name}-results.json`),
    'web-engine-webgpu-es31-default-cook-results.json', 'web-engine-webgpu-es31-default-stage-results.json',
    'web-default-template-package-results.json', 'web-default-scene-results.json']) evidence(name);
  const shaders = read(path.join(directory, 'web-cook-shader-sources.json'));
  for (const shader of shaders.files)
    visit({file: path.join(shaders.output, shader.relative), sha256: shader.sha256});
  const runtime = evidence(`web-project-triplex-house-villa-${suffix}-results.json`);
  assert(runtime.surfaceControlsRequired && runtime.requestedView.join(',') === '-175,-80,160,-5,50');
  assert(runtime.runs.length === 2 && new Set(runtime.runs.map(run => run.browser)).size === 2);
  report.browsers = runtime.runs.map(run => {
    assert(run.pass && run.visualTestClock.renderTimeFrozen && run.textureCompressionVerified);
    assert(!run.errors.length && !run.gpu.errors.length && !run.gpu.deviceLosses.length);
    assert.equal(run.gpu.textureFormats.rg11b10ufloat.count, 31);
    const restored = run.surfaces.restored.difference;
    for (const label of ['ao-restored', 'reflection-restored', 'restored'])
      assert(run.surfaces[label].difference.rms < 3);
    for (const [label, key, disabled] of [['ao-off', 'aoLevels', 0],
      ['reflection-off', 'reflectionMode', 1], ['shadows-off', 'shadowQuality', 0]]) {
      const control = run.surfaces[label], change = control.difference;
      assert.equal(control.settings[key], disabled);
      assert(change.rms > 0.5 && change.changedFraction > 0.001 && change.rms > restored.rms * 2);
    }
    const settings = run.surfaces.restored.settings;
    assert(settings.original.aoLevels > 0 && settings.original.shadowQuality > 0);
    for (const key of ['aoLevels', 'reflectionMode', 'shadowQuality'])
      assert.equal(settings[key], settings.original[key]);
    return {browser: run.browser, screenshot: run.screenshot, fps: run.performance.engineFps,
      differences: Object.fromEntries(Object.entries(run.surfaces).map(([key, value]) => [key, value.difference])),
      contentErrors: run.contentErrors, textureDescriptorBytesCreated: run.gpu.textureDescriptorBytesCreated};
  });
  const nativeTextureFile = path.join(__dirname, `build/${textureProbe}/texture-srv-results.json`);
  const nativeTexture = read(nativeTextureFile);
  assert(nativeTexture.pass && nativeTexture.modes.length === 2);
  for (const mode of nativeTexture.modes) {
    assert([119, 181].includes(mode.checks.length) && mode.checks.every(check => check.pass) && !mode.errors.length);
    assert.equal(mode.checks.filter(check => /^stream-(rgba8|bc1)-/.test(check.name)).length,
      mode.checks.length === 181 ? 62 : 0);
    assert(mode.checks.filter(check => /reflection/.test(check.name)).length >= 33);
  }
  report.nativeTextureChecks = nativeTexture.modes.reduce((sum, mode) => sum + mode.checks.length, 0);
  report.nativeTexture = [nativeTextureFile, path.join(directory, `${textureProbe}.log`),
    path.resolve(__dirname, '../ue-shader-host/Plugins/WebGPUShader/Binaries/Win64/UnrealEditor-WebGPURHI.dll')].map(audit);
  const textures = evidence(`${textureInventory}.json`);
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
  const nativeMap = read(path.join(directory, 'triplex-pbr-native-map.json'));
  const captures = nativeMap.actors.flatMap(actor => actor.components)
    .filter(component => /ReflectionCaptureComponent$/.test(component.class));
  assert.equal(captures.length, 31);
  assert(captures.every(component => component.captureSize === 128 && component.encodedHDRBytes === 524280));
  const nativeLog = text(path.join(directory, 'pbr-native-reference.log'));
  assert(nativeLog.includes('WEB_NATIVE_VIEW: saved=') && nativeLog.includes('view=-175,-80,160,-5,50') &&
    !/Error:|Handled ensure|Fatal error/.test(nativeLog));
  report.nativeReference = ['triplex-pbr-native.png', 'triplex-pbr-native-map.json', 'pbr-native-reference.log']
    .map(name => audit(path.join(directory, name)));
  report.nativeReferenceBoundary = 'Same camera geometry, native SceneCapture2D in an editor world; ' +
    'not the editor viewport or gameplay state, and not a pixel parity assertion.';
  const before = read(path.join(directory, 'web-project-triplex-house-villa-pbr-before-results.json'));
  report.before = before.runs.map(run => {
    visit(run.screenshot);
    return run.screenshot;
  });
  report.boundary = 'Audits current source/build/cook/package/screenshot hashes, packed HDR capture faces/mips, ' +
    'browser AO/reflection/shadow disable and restoration controls, preserved compressed mip chains and default scene. ' +
    'Room-scale sky occlusion, Lumen GI, native viewport parity, performance, residency and phone acceptance remain open.';
  report.pass = true;
} catch (error) { report.failure = error.stack; process.exitCode = 1; }
report.uniqueFiles = checked.size;
const file = path.join(directory, `${output}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({pass: report.pass, checked: report.checked, uniqueFiles: report.uniqueFiles,
  file, failure: report.failure}, null, 2));
