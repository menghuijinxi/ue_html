const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const directory = path.join(__dirname, 'results');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const report = {date: new Date().toISOString(), pass: false, completeUEScene: false,
  renderer: 'desktop-deferred', startupStabilityVerified: false,
  sourceFiles: [audit(__filename)], reports: [], checkedFiles: 0};
try {
  const reports = {};
  const check = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.file === 'string' && /^[0-9a-f]{64}$/i.test(value.sha256 || '')) {
      assert.equal(audit(value.file).sha256, value.sha256, `Stale evidence: ${value.file}`);
      report.checkedFiles++;
      return;
    }
    for (const item of Object.values(value)) check(item);
  };
  for (const name of [
    'web-engine-full-build', 'web-engine-webgpu-sm5-default-cook',
    'web-engine-webgpu-sm5-default-stage', 'web-default-template-desktop-package',
    'web-desktop-shader-modules', 'web-desktop-shader-modules-edge', 'web-desktop-resources',
    'web-desktop-interpolants', 'web-default-diagnostics-interpolant-fix',
    'web-image-quality-desktop-quality-chrome', 'web-image-quality-desktop-quality-edge',
    'web-default-startup-desktop-candidate', 'web-default-startup-desktop-published',
    'default-shadow-native-desktop', 'web-default-desktop', 'web-default-desktop-edge',
    'web-default-desktop-comparison', 'web-default-desktop-publish',
    'web-default-desktop-published', 'web-default-desktop-published-edge'
  ]) {
    const file = path.join(directory, `${name}-results.json`);
    const evidence = read(file);
    assert(evidence.pass, `Failed evidence: ${name}`);
    check(evidence);
    reports[name] = evidence;
    report.reports.push(audit(file));
  }
  const packaged = reports['web-default-template-desktop-package'];
  assert(packaged.fullNormalUBTBuildVerified && packaged.renderer === report.renderer);
  const release = reports['web-default-desktop-publish'];
  for (const browser of ['chrome', 'edge']) {
    const quality = reports[`web-image-quality-desktop-quality-${browser}`];
    assert(quality.nativeResolution && quality.temporalAAVerified && quality.cloudOcclusionVerified &&
      quality.resolution.canvas.width === 3840 && quality.resolution.canvas.height === 2160 &&
      quality.products.every(item => packaged.products.some(product =>
        product.file === item.file && product.sha256 === item.sha256)));
    assert(release.imageQualityReports.some(item => item.sha256 === audit(path.join(directory,
      `web-image-quality-desktop-quality-${browser}-results.json`)).sha256));
  }
  assert.equal(release.packageReport.sha256, audit(path.join(directory,
    'web-default-template-desktop-package-results.json')).sha256);
  assert.equal(release.products.length, packaged.products.length);
  for (const name of ['desktop-candidate', 'desktop-published']) {
    const startup = reports[`web-default-startup-${name}`];
    assert(startup.desktop && !startup.gpuHooks && !startup.startupOnly &&
      startup.package.sha256 === release.packageReport.sha256);
    if (name === 'desktop-published')
      assert.equal(startup.publishReport.sha256,
        audit(path.join(directory, 'web-default-desktop-publish-results.json')).sha256);
    for (const browser of ['Chrome', 'Edge'])
      for (const scale of [1, 1.5, 2])
        assert(startup.browserRuns.some(run => run.browser === browser && run.scale === scale &&
          run.pass && run.errors.length === 0 && run.views.length === 3));
  }
  for (const product of release.products) {
    const candidate = packaged.products.find(item => path.basename(item.file) === path.basename(product.file));
    assert(candidate && candidate.sha256 === product.sha256);
  }
  report.browsers = [];
  for (const suffix of ['', '-edge']) {
    const evidence = reports[`web-default-desktop-published${suffix}`];
    assert(evidence.published && evidence.completeUEScene && evidence.soakSeconds >= 60);
    assert.equal(evidence.publishReport.sha256,
      audit(path.join(directory, 'web-default-desktop-publish-results.json')).sha256);
    assert.equal(evidence.packageReport.sha256, release.packageReport.sha256);
    assert.equal(evidence.runs.length, 1);
    const run = evidence.runs[0];
    assert(run.pass && run.ready.featureLevel === 3 && run.ready.shaderPlatform === 47 &&
      !run.materialPolicy.mobile && run.samples.count === 8 && run.samples.sceneUnchanged &&
      run.errors.length === 0 && run.gpu.gpuErrors.length === 0 &&
      run.soak.at(-1).elapsedSeconds >= 60 && run.heapGrowthBytes < 64 * 1024 * 1024);
    for (const name of ['FDeferredLightPS', 'FReflectionEnvironmentSkyLightingPS', 'FTonemapPS'])
      assert(run.passes.draws[name] > 0);
    assert(run.passes.textures.some(texture => /^GBuffer/.test(texture.label)));
    report.browsers.push({name: run.browser, frames: run.frames,
      seconds: run.soak.at(-1).elapsedSeconds, heapGrowthBytes: run.heapGrowthBytes});
  }
  const failureFile = path.join(directory, 'web-default-desktop-published-edge-cold-start-failure.json');
  if (fs.existsSync(failureFile)) {
    const failure = read(failureFile);
    assert(!failure.pass && failure.runs.some(run =>
      run.failure === 'A valid external Instance reference no longer exists.'));
    report.knownColdStartFailure = audit(failureFile);
  }
  report.completeUEScene = true;
  report.pass = true;
  report.boundary = 'Desktop SM5 default-map delivery, native 4K SceneColor/viewport, executed main TAA, sampled matte-sphere cloud occlusion, same-profile native comparison and one-minute browser tests passed. Cloud checks do not cover all motion histories or silhouettes. Intermittent cold-start device failure remains unresolved. This does not establish long-term stability, complete SM6/Lumen, villa desktop rendering, mobile support or an 8 GB total VRAM budget.';
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, 'web-default-desktop-delivery-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
