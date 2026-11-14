'use strict';
const {initializeProjectOutput, assertProjectOutputTree, assertProjectOutput} = require('./project-output.cjs');
initializeProjectOutput();
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {audit, metadata} = require('./content-file-metadata.cjs');
const {readPage, writePage} = require('./web-pipeline-prewarm-package.cjs');
const {finalizeDesktopRelease, verifyDesktopRelease} = require('./web-release-defaults.cjs');
const {applyAcceptedDefaults} = require('./web-accepted-defaults.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const folder = process.argv[2];
assert(folder && /^[a-z0-9-]+$/.test(folder));
const source = path.join(__dirname, 'build/villa-tsr-tiles-20261112');
const output = assertProjectOutputTree(path.join(__dirname, 'build', folder));
const reportFile = assertProjectOutput(path.join(__dirname, 'results', folder + '-package.json'));
assert(!fs.existsSync(output) && !fs.existsSync(reportFile), 'Preserve immutable comparison packages');
const buildFile = path.join(__dirname, 'results/web-engine-full-thread-build-results.json');
const build = JSON.parse(fs.readFileSync(buildFile, 'utf8').replace(/^\uFEFF/, ''));
assert(build.pass && build.buildSucceeded && build.exitCode === 0 && build.fullLinkVerified);
for (const item of [...build.sourceFiles, ...build.products, build.log])
  assert.equal(audit(item.file).sha256, item.sha256, 'Build input or output changed: ' + item.file);
const original = JSON.parse(fs.readFileSync(path.join(source, 'asset-versions.json')));
for (const [name, item] of Object.entries(original))
  assert.equal(audit(path.join(source, name)).sha256, item.sha256, 'Source package changed: ' + name);
verifyDesktopRelease(source, {releaseReady: true, prewarm: {mode: 'recorded'}});
const report = {date: new Date().toISOString(), pass: false, source: audit(__filename),
  sourcePackage: audit(path.join(source, 'asset-versions.json')), build: audit(buildFile), output,
  boundary: 'Repackage the verified immutable villa Cook with the rebuilt runtime and small TSR default. ' +
    'Both Cook permutations remain present; no material, sampling quality or resolution changes. ' +
    'New runtime/config hashes require a matching actual pipeline capture through the normal release finalizer.'};
try {
  fs.mkdirSync(output);
  for (const name of Object.keys(original)) {
    if (['asset-versions.json', 'pipeline-prewarm.json', 'UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'].includes(name))
      continue;
    const from = path.join(source, name), to = path.join(output, name);
    if (name === 'content.bin') fs.linkSync(from, to);
    else fs.copyFileSync(from, to);
  }
  for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm']) {
    const product = build.products.find(item => path.basename(item.file) === name); assert(product);
    fs.copyFileSync(product.file, path.join(output, name));
  }
  const page = readPage(output);
  for (const name of ['UEWebEngineThreads.js', 'UEWebEngineThreads.wasm'])
    page.assets.versions[name] = audit(path.join(output, name)).sha256;
  page.assets.wasm = metadata(path.join(output, 'UEWebEngineThreads.wasm'), 'UEWebEngineThreads.wasm');
  delete page.assets.pipelinePrewarm;
  writePage(output, page);
  report.profile = applyAcceptedDefaults(output);
  report.release = finalizeDesktopRelease(output);
  assert(report.release.releaseReady);
  report.products = fs.readdirSync(output).filter(name => name !== 'asset-versions.json')
    .map(name => audit(path.join(output, name)));
  report.products.push(writeVersions(output, report.products));
  for (const name of ['content.bin', 'content-files.json'])
    assert.equal(audit(path.join(output, name)).sha256, original[name].sha256);
  assert.equal(audit(path.join(source, 'asset-versions.json')).sha256, report.sourcePackage.sha256);
  report.pass = true;
} catch (error) {report.error = error.stack; console.error(error); process.exitCode = 1;}
finally {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, releaseReady: report.release?.releaseReady, reportFile}));
}
