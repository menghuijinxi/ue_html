const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {metadata} = require('./content-file-metadata.cjs');
const {writeVersions} = require('./asset-versions.cjs');
const {validateCook} = require('./cached-cook-validation.cjs');
const directory = path.join(__dirname, 'results');
const desktop = process.argv.includes('--desktop');
const threads = process.argv.includes('--threads');
const distanceFields = process.argv.includes('--distance-fields');
assert(!distanceFields || desktop, 'Distance fields require the desktop renderer');
assert(!threads || desktop, 'Threaded engine requires the desktop renderer');
const runtime = threads ? 'UEWebEngineThreads' : 'UEWebEngine';
const suffix = (distanceFields ? '-distance-fields' : '') + (threads ? '-threads' : desktop ? '-desktop' : '');
const output = path.join(__dirname, 'build/ue-default-template' + suffix);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const report = {date: new Date().toISOString(), pass: false, output,
  renderer: desktop ? 'desktop-deferred' : 'mobile-forward', threads, distanceFields,
  map: '/Engine/Maps/Templates/Template_Default', architecture: 'wasm64',
  fullNormalUBTBuildVerified: false, completeUEScene: false,
  sourceFiles: [__filename, path.join(__dirname, 'web-default-template.html'),
    ...['content-file-metadata.cjs', 'asset-versions.cjs', 'cached-cook-validation.cjs', 'web-content-io.js', 'web-content-worker.js',
      ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name => path.join(__dirname, name))].map(audit)};
try {
  const buildFile = path.join(directory, `web-engine-full${threads ? '-thread' : ''}-build-results.json`);
  const build = read(buildFile);
  assert(build.pass && build.buildSucceeded && build.exitCode === 0 &&
    (build.fullLinkAttempted || threads && build.fullLinkVerified),
    'A successful normal UBT build is required');
  assert(build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.log));
  if (threads) {
    assert(build.threads && build.objects.length > 300 && valid(build.linkResponse));
    assert(build.objects.every(item => [item.object, item.response, item.definitions, item.source].every(valid)));
    assert(build.platformCopies.every(item => valid(item.source) && valid(item.copied) &&
      item.source.sha256 === item.copied.sha256));
  }
  const stageFile = path.join(directory, desktop ?
    'web-engine-webgpu-sm5-default-stage-results.json' : 'web-engine-webgpu-es31-default-stage-results.json');
  const stage = read(stageFile);
  assert(stage.pass && stage.map === report.map && stage.sourceFiles.every(valid) &&
    [stage.cookReport, stage.pack, stage.manifest, stage.configBundle].every(valid));
  const cook = read(stage.cookReport.file);
  assert.equal(cook.distanceFields === true, distanceFields, 'Select the matching distance-field candidate');
  validateCook(cook, process.argv.includes('--reuse-cook'), report);
  report.buildReport = audit(buildFile);
  report.stageReport = audit(stageFile);
  fs.mkdirSync(output, {recursive: true});
  const copies = [
    [stage.pack.file, 'content.bin'],
    [stage.manifest.file, 'content-files.json'],
    [stage.configBundle.file, 'config-files.json']
  ];
  for (const name of ['web-content-io.js', 'web-content-worker.js']) copies.push([path.join(__dirname, name), name]);
  if (threads) for (const name of ['web-engine-host.js', 'web-engine-worker.js'])
    copies.push([path.join(__dirname, name), name]);
  for (const name of [runtime + '.js', runtime + '.wasm']) {
    const product = build.products.find(item => path.basename(item.file) === name);
    assert(product && valid(product), `Missing runtime: ${name}`);
    copies.push([product.file, name]);
  }
  let html = fs.readFileSync(path.join(__dirname, 'web-default-template.html'), 'utf8');
  const versions = Object.fromEntries([runtime + '.js', runtime + '.wasm', 'web-content-io.js', 'web-content-worker.js',
    ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name =>
    [name, audit(copies.find(([, target]) => target === name)[0]).sha256]));
  html = html.replace('const localRuntimeAssets = {};', 'const localRuntimeAssets = ' +
    JSON.stringify({versions, renderer: desktop ? 'desktop' : 'mobile', threads, distanceFields, runtime: runtime + '.js',
      wasm: metadata(copies.find(([, target]) => target === runtime + '.wasm')[0],
      runtime + '.wasm')}) + ';');
  fs.writeFileSync(path.join(output, 'index.html'), html);
  report.products = [audit(path.join(output, 'index.html')), ...copies.map(([source, name]) => {
    const destination = path.join(output, name);
    fs.copyFileSync(source, destination);
    assert.equal(audit(source).sha256, audit(destination).sha256);
    return audit(destination);
  })];
  report.products.push(writeVersions(output, report.products));
  report.totalBytes = report.products.reduce((total, item) => total + fs.statSync(item.file).size, 0);
  report.fullNormalUBTBuildVerified = true;
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, `web-default-template${suffix}-package-results.json`),
    JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, files: report.products?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
