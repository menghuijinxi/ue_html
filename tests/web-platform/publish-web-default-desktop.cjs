const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const results = path.join(__dirname, 'results');
const candidate = path.join(__dirname, 'build/ue-default-template-desktop');
const output = path.join(__dirname, 'build/ue-default-template');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, renderer: 'desktop-deferred',
  output, sourceFiles: [audit(__filename)]};
try {
  const packageFile = path.join(results, 'web-default-template-desktop-package-results.json');
  const packaged = read(packageFile);
  assert(packaged.pass && packaged.renderer === report.renderer &&
    packaged.products.every(valid) && packaged.sourceFiles.every(valid));
  assert.equal(fs.realpathSync(candidate), candidate);
  report.packageReport = audit(packageFile);
  const comparisonFile = path.join(results, 'web-default-desktop-comparison-results.json');
  const comparison = read(comparisonFile);
  assert(comparison.pass && comparison.sourceFiles.every(valid) &&
    valid(comparison.nativeReport) && valid(comparison.nativeInput) && valid(comparison.nativeLog) &&
    comparison.comparisons.length === 2 &&
    comparison.comparisons.every(item => valid(item.report) && valid(item.image)));
  report.comparisonReport = audit(comparisonFile);
  const resourcesFile = path.join(results, 'web-desktop-resources-results.json');
  const resources = read(resourcesFile);
  assert(resources.pass && resources.sourceFiles.every(valid) && resources.inputs.every(valid) &&
    valid(resources.nativeBuildLog) && resources.runs.every(run => valid(run.runtime) &&
      valid(run.log) && run.shaderPackets.every(valid) && run.readbacks.every(valid)));
  report.resourcesReport = audit(resourcesFile);
  const startupFile = path.join(results, 'web-default-startup-desktop-candidate-results.json');
  const startup = read(startupFile);
  assert(startup.pass && startup.desktop && startup.candidate && !startup.gpuHooks &&
    !startup.startupOnly && valid(startup.source) &&
    startup.package.sha256 === report.packageReport.sha256 &&
    startup.products.every(valid));
  for (const browser of ['Chrome', 'Edge'])
    for (const scale of [1, 1.5, 2])
      assert(startup.browserRuns.some(run => run.browser === browser && run.scale === scale &&
        run.pass && run.errors.length === 0 && run.views.length === 3 &&
        run.views.every(view => !view.failure && view.ready.featureLevel === 3 &&
          view.ready.shaderPlatform === 47 && (!view.screenshot || valid(view.screenshot)))));
  report.highDPIStartupReport = audit(startupFile);
  report.browserReports = [];
  for (const suffix of ['', '-edge']) {
    const file = path.join(results, `web-default-desktop${suffix}-results.json`);
    const browser = read(file);
    assert(browser.pass && browser.completeUEScene && browser.soakSeconds >= 60 && browser.renderer === report.renderer &&
      valid(browser.packageReport) && browser.packageReport.sha256 === report.packageReport.sha256 &&
      browser.sourceFiles.every(valid) && browser.runs.length === 1 &&
      browser.runs.every(run => run.pass &&
        run.ready.featureLevel === 3 && run.ready.shaderPlatform === 47 &&
        Object.values(run.images).every(valid)));
    report.browserReports.push(audit(file));
  }
  fs.mkdirSync(output, {recursive: true});
  assert.equal(fs.realpathSync(output), output);
  const names = packaged.products.map(item => {
    assert.equal(path.dirname(item.file), candidate);
    return path.basename(item.file);
  });
  const original = path.join(output, 'index.html');
  if (fs.existsSync(original) &&
    !fs.readFileSync(original, 'utf8').includes('"renderer":"desktop"')) {
    const backup = path.join(__dirname, 'build',
      `ue-default-template-before-desktop-${audit(original).sha256.slice(0, 12)}`);
    fs.mkdirSync(backup, {recursive: true});
    assert.equal(fs.realpathSync(backup), backup);
    report.previousBuild = [];
    for (const name of names) {
      const source = path.join(output, name);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(backup, name);
      if (fs.existsSync(destination)) assert.equal(audit(destination).sha256, audit(source).sha256);
      else fs.copyFileSync(source, destination);
      report.previousBuild.push(audit(destination));
    }
  }
  report.products = [...packaged.products].sort((a, b) =>
    Number(path.basename(a.file) === 'index.html') - Number(path.basename(b.file) === 'index.html')).map(item => {
    const destination = path.join(output, path.basename(item.file));
    fs.copyFileSync(item.file, destination);
    const product = audit(destination);
    assert.equal(product.sha256, item.sha256);
    return product;
  });
  report.completeUEScene = true;
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(results, 'web-default-desktop-publish-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, previousBuild: report.previousBuild?.[0]?.file,
    failure: report.failure}, null, 2));
}
