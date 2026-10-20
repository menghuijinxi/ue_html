const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const results = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const audit = file => ({file, sha256: sha(file)});
const valid = item => item?.file && fs.existsSync(item.file) && sha(item.file) === item.sha256;
const report = {date: new Date().toISOString(), pass: false, staticUniformBindingVerified: false,
  reports: [], sources: [audit(__filename)], browserRuns: []};
const load = name => {
  const file = path.join(results, `${name}.json`);
  report.reports.push(audit(file));
  return read(file);
};
try {
  const before = load('web-engine-webgpu-es31-results-before-static-uniforms-20261020');
  const oldGPU = before.browserRuns.filter(run => run.rhi === 'webgpu');
  assert(oldGPU.length === 2 && oldGPU.every(run => run.frames === 0 &&
    run.startupBlocker === 'WebGPURHI operation is not implemented: RHISetStaticUniformBuffers'));
  report.beforeFixRecordsAreHistorical = true;
  const native = load('web-static-uniforms-native-results');
  assert(native.pass && native.sources.every(valid) && native.products.every(valid) &&
    native.fixtures.every(valid) && native.runs.length === 4);
  assert.deepEqual(native.runs.map(run => run.mode), ['global', 'material', 'direct-material', 'viewport']);
  for (const run of native.runs)
    assert(run.exitCode === 0 && valid(run.runtime) && valid(run.log) && read(run.runtime.file).pass);
  const global = read(native.runs.find(run => run.mode === 'global').runtime.file);
  assert.deepEqual(global.modes.map(mode => mode.mode), ['recorded', 'bypass']);
  for (const mode of global.modes) {
    assert(mode.pass && mode.staticUniformProbe && mode.errors.length === 0 &&
      mode.checks.every(check => check.pass) && mode.staticUniformBatches >= 6 &&
      mode.staticUniformUpdates >= 4 && mode.staticUniformResolutions >= 5);
    const checks = mode.checks.filter(check => check.name.startsWith('static-'));
    assert.equal(checks.length, 19);
    const empty = mode.checks.filter(check => /^empty-(?:uniform-|primitive-uniform-)/.test(check.name));
    assert.deepEqual(empty.map(check => check.name), [
      'empty-uniform-has-no-invented-constants', 'empty-uniform-update-snapshots-queued-data',
      'empty-uniform-supports-subsequent-updates', 'empty-primitive-uniform-keeps-null-resource-slots'
    ]);
    for (const name of ['static-runtime-layout-hash-mismatch-rejected',
      'static-and-direct-double-binding-rejected', 'static-only-missing-binding-rejected',
      'static-empty-batch-clears-all-bindings', 'static-final-clear-releases-context-references'])
      assert(checks.some(check => check.name === name));
  }
  report.nativeStaticChecks = 38;
  report.nativeEmptyUniformChecks = 8;
  const materialRun = native.runs.find(run => run.mode === 'material');
  const directRun = native.runs.find(run => run.mode === 'direct-material');
  const material = read(materialRun.runtime.file), direct = read(directRun.runtime.file);
  for (const value of [material, direct]) {
    assert(value.materialOnlyProbe && value.hostRestored && value.errors.length === 0 &&
      value.material.pass && value.material.draws > 0 && value.material.checkedValues >= 1000000 &&
      value.material.checks.every(check => check.pass));
  }
  assert(material.material.staticViewBindingVerified && material.material.staticUniformResolutions > 0);
  assert(!direct.material.staticViewBindingVerified && direct.material.staticUniformResolutions === 0);
  assert.equal(material.material.draws, direct.material.draws);
  assert.equal(material.material.checkedValues, direct.material.checkedValues);
  for (const name of ['UnlitColor', 'UnlitTexture']) {
    const staticImage = path.join(path.dirname(materialRun.runtime.file), `${name}-64x64.rgba`);
    const directImage = path.join(path.dirname(directRun.runtime.file), `${name}-64x64.rgba`);
    assert.equal(fs.statSync(staticImage).size, 64 * 64 * 4);
    assert.equal(sha(staticImage), sha(directImage));
    report.sources.push(audit(staticImage), audit(directImage));
    for (const suffix of ['view-projection', 'large-world-origin', 'pre-exposure'])
      assert(material.material.checks.some(check => check.name === `${name}-${suffix}` && check.pass));
  }
  report.nativeMaterial = {drawsPerBindingMode: material.material.draws,
    checkedValuesPerBindingMode: material.material.checkedValues,
    checksStatic: material.material.checks.length, checksDirect: direct.material.checks.length,
    staticResolutions: material.material.staticUniformResolutions, imagesIdentical: true};
  const nativeBuild = load('web-system-textures-native-results');
  assert(nativeBuild.pass && valid(nativeBuild.buildLog) &&
    nativeBuild.products.every(valid) && nativeBuild.sources.every(valid) && valid(nativeBuild.runtime));
  assert(native.products.every(item => nativeBuild.products.some(product =>
    product.file === item.file && product.sha256 === item.sha256)));
  const link = load('web-engine-webgpu-link-results');
  assert(link.pass && !link.fullNormalUBTBuildVerified && link.sourceFiles.every(valid) &&
    link.linkInputs.every(valid) && link.products.every(valid) && valid(link.log));
  for (const name of ['BrowserDynamicRHI', 'BrowserViewport', 'BrowserBreadcrumbs', 'BrowserBufferLock',
    'BrowserTransitions', 'WebGPUBrowserModule'])
    assert(link.recompiledObjects.some(item => path.basename(item.source.file) === `${name}.cpp` &&
      item.exitCode === 0 && ['source', 'response', 'product', 'log'].every(key => valid(item[key]))));
  const runtime = load('web-engine-webgpu-es31-results');
  assert(runtime.staticUniformStartupVerified && runtime.es31LibraryIntegrationVerified &&
    runtime.sourceFiles.every(valid) && valid(runtime.buildReport));
  const gpu = runtime.browserRuns.filter(run => run.rhi === 'webgpu');
  assert.equal(gpu.length, 2);
  for (const run of gpu) {
    assert(run.textureUploads.pass && run.gpuValidationErrors.length === 0);
    const batches = run.consoleLog.filter(line => line.includes('P3_STATIC_UNIFORMS '));
    assert(batches.length > 0);
    assert(!run.errors.some(error => error.includes('operation is not implemented: RHISetStaticUniformBuffer')));
    report.browserRuns.push({browser: run.browser, version: run.version, batches,
      frames: run.frames, startupBlocker: run.startupBlocker});
  }
  report.staticUniformBindingVerified = true;
  report.pass = true;
  report.boundary = 'Shared RHI static bindings retain context-owned references, replace or clear batches and single slots, resolve runtime slots by UE layout hash and validate binding flags/layouts. Both native command recording modes verify 19 positive/negative/lifetime cases. Real Unlit GPU draws verify static View projection/exposure and match the direct-binding baseline; resource-table lookups use the same uniform resolver. Browser Engine startup executes the actual RDG API; empty startup batches alone do not prove browser shader creation, scene rendering or presentation. Full normal Web Engine UBT remains unverified.';
} catch (error) {
  report.failure = error.stack;
} finally {
  fs.writeFileSync(path.join(results, 'web-static-uniforms-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, staticUniformBindingVerified: report.staticUniformBindingVerified,
    nativeStaticChecks: report.nativeStaticChecks, nativeMaterial: report.nativeMaterial,
    browserRuns: report.browserRuns, failure: report.failure}, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
