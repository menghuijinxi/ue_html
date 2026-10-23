const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {metadata} = require('./content-file-metadata.cjs');
const directory = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build/ue-default-template');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, output,
  map: '/Engine/Maps/Templates/Template_Default', architecture: 'wasm64',
  fullNormalUBTBuildVerified: false, completeUEScene: false,
  sourceFiles: [__filename, path.join(__dirname, 'web-default-template.html'),
    ...['content-file-metadata.cjs', 'web-content-io.js', 'web-content-worker.js'].map(name => path.join(__dirname, name))].map(audit)};
try {
  const buildFile = path.join(directory, 'web-engine-full-build-results.json');
  const build = read(buildFile);
  assert(build.pass && build.buildSucceeded && build.exitCode === 0 && build.fullLinkAttempted,
    'A successful normal UBT build is required');
  assert(build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.log));
  const stageFile = path.join(directory, 'web-engine-webgpu-es31-default-stage-results.json');
  const stage = read(stageFile);
  assert(stage.pass && stage.map === report.map && stage.sourceFiles.every(valid) &&
    [stage.cookReport, stage.pack, stage.manifest, stage.configBundle].every(valid));
  const cook = read(stage.cookReport.file);
  assert(cook.pass && cook.sourceFiles.every(valid) && cook.products.every(valid) &&
    cook.hostProducts.every(valid));
  report.buildReport = audit(buildFile);
  report.stageReport = audit(stageFile);
  fs.mkdirSync(output, {recursive: true});
  const copies = [
    [stage.pack.file, 'content.bin'],
    [stage.manifest.file, 'content-files.json'],
    [stage.configBundle.file, 'config-files.json']
  ];
  for (const name of ['web-content-io.js', 'web-content-worker.js']) copies.push([path.join(__dirname, name), name]);
  for (const name of ['UEWebEngine.js', 'UEWebEngine.wasm']) {
    const product = build.products.find(item => path.basename(item.file) === name);
    assert(product && valid(product), `Missing runtime: ${name}`);
    copies.push([product.file, name]);
  }
  let html = fs.readFileSync(path.join(__dirname, 'web-default-template.html'), 'utf8');
  const versions = Object.fromEntries(['UEWebEngine.js', 'web-content-io.js', 'web-content-worker.js'].map(name =>
    [name, audit(copies.find(([, target]) => target === name)[0]).sha256]));
  html = html.replace('const localRuntimeAssets = {};', 'const localRuntimeAssets = ' +
    JSON.stringify({versions, wasm: metadata(copies.find(([, target]) => target === 'UEWebEngine.wasm')[0],
      'UEWebEngine.wasm')}) + ';');
  fs.writeFileSync(path.join(output, 'index.html'), html);
  report.products = [audit(path.join(output, 'index.html')), ...copies.map(([source, name]) => {
    const destination = path.join(output, name);
    fs.copyFileSync(source, destination);
    assert.equal(audit(source).sha256, audit(destination).sha256);
    return audit(destination);
  })];
  report.totalBytes = report.products.reduce((total, item) => total + fs.statSync(item.file).size, 0);
  report.fullNormalUBTBuildVerified = true;
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, 'web-default-template-package-results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, files: report.products?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
