const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
const results = path.join(__dirname, 'results');
const candidate = path.join(__dirname, 'build', id + '-desktop');
const output = path.join(__dirname, 'build', id);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, id, output,
  renderer: 'desktop-deferred', nativeVisualParityVerified: false, sourceFiles: [audit(__filename)]};
try {
  const packageFile = path.join(results, `web-project-${id}-desktop-package-results.json`);
  const packaged = read(packageFile);
  assert(packaged.pass && packaged.fullNormalUBTBuildVerified && packaged.renderer === report.renderer &&
    packaged.products.every(valid) && packaged.sourceFiles.every(valid) &&
    [packaged.buildReport, packaged.stageReport, packaged.preparationReport].every(valid));
  report.packageReport = audit(packageFile);
  const probeFile = path.join(results, `web-project-${id}-desktop-candidate-results.json`);
  const probe = read(probeFile);
  assert(probe.pass && probe.desktop && !probe.published && probe.sources.every(valid) &&
    probe.packageReport.sha256 === report.packageReport.sha256);
  for (const browser of ['Chrome', 'Edge'])
    for (const scale of [1, 1.5])
      assert(probe.runs.some(run => run.browser === browser && run.profile.dpr === scale &&
        run.pass && run.ready.shaderPlatform === 47 && run.ready.featureLevel === 3 &&
        !run.errors.length && !run.gpu.errors.length && !run.gpu.deviceLosses.length &&
        valid(run.screenshot)));
  report.browserReport = audit(probeFile);
  const startupFile = path.join(results, `web-default-startup-${id}-desktop-candidate-results.json`);
  const startup = read(startupFile);
  assert(startup.pass && startup.desktop && startup.candidate && startup.projectId === id &&
    !startup.gpuHooks && !startup.startupOnly && valid(startup.source) &&
    startup.package.sha256 === report.packageReport.sha256 && startup.products.every(valid));
  for (const browser of ['Chrome', 'Edge'])
    for (const scale of [1, 1.5, 2])
      assert(startup.browserRuns.some(run => run.browser === browser && run.scale === scale &&
        run.pass && !run.errors.length && run.views.length === 3 &&
        run.views.every(view => !view.failure && view.ready.shaderPlatform === 47 &&
          view.ready.featureLevel === 3 && view.world.package === packaged.map &&
          (!view.screenshot || valid(view.screenshot)))));
  report.highDPIStartupReport = audit(startupFile);
  report.stabilityReports = [];
  for (const browser of ['Chrome', 'Edge']) {
    const file = path.join(results, `web-project-${id}-desktop-stability-${browser.toLowerCase()}-results.json`);
    const stability = read(file);
    assert(stability.pass && stability.desktop && !stability.published && stability.resize &&
      stability.mode === 'tour' && stability.seconds >= 60 &&
      stability.project === id && stability.browser === browser && valid(stability.source) &&
      stability.packageReport.sha256 === report.packageReport.sha256 && valid(stability.screenshot) &&
      !stability.errors.length && !stability.engineErrors.length);
    report.stabilityReports.push(audit(file));
  }
  assert.equal(fs.realpathSync(candidate), candidate);
  fs.mkdirSync(output, {recursive: true});
  assert.equal(fs.realpathSync(output), output);
  const original = path.join(output, 'index.html');
  if (fs.existsSync(original)) {
    const backup = path.join(__dirname, 'build', `${id}-before-desktop-${audit(original).sha256.slice(0, 12)}`);
    fs.mkdirSync(backup, {recursive: true});
    assert.equal(fs.realpathSync(backup), backup);
    report.previousBuild = [];
    for (const product of packaged.products) {
      const source = path.join(output, path.basename(product.file));
      if (!fs.existsSync(source)) continue;
      const destination = path.join(backup, path.basename(product.file));
      if (fs.existsSync(destination)) assert.equal(audit(destination).sha256, audit(source).sha256);
      else fs.copyFileSync(source, destination);
      report.previousBuild.push(audit(destination));
    }
  }
  report.products = [...packaged.products].sort((a, b) =>
    Number(path.basename(a.file) === 'index.html') - Number(path.basename(b.file) === 'index.html')).map(item => {
    assert.equal(path.dirname(item.file), candidate);
    const destination = path.join(output, path.basename(item.file));
    fs.copyFileSync(item.file, destination);
    const product = audit(destination);
    assert.equal(product.sha256, item.sha256);
    return product;
  });
  report.pass = true;
  report.boundary = 'Publishes the checked desktop SM5 project candidate. Browser startup/rendering checks do not establish native visual parity, long-term stability, Lumen, mobile compatibility or an 8 GB VRAM budget.';
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(results, `web-project-${id}-desktop-publish-results.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, failure: report.failure}, null, 2));
}
