const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {metadata, audit} = require('./content-file-metadata.cjs');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
const desktop = process.argv.includes('--desktop');
const threads = process.argv.includes('--threads');
assert(!threads || desktop, 'Threaded engine requires the desktop renderer');
const runtime = threads ? 'UEWebEngineThreads' : 'UEWebEngine';
const suffix = threads ? '-threads' : desktop ? '-desktop' : '';
const prefix = `web-project-${id}${suffix}`;
const stagePrefix = `web-project-${id}${desktop ? '-desktop' : ''}`;
const directory = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build', id + suffix);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const template = path.join(__dirname, 'web-default-template.html');
const report = {date: new Date().toISOString(), pass: false, id, output, architecture: 'wasm64',
  renderer: desktop ? 'desktop-deferred' : 'mobile-forward', threads,
  sourceFiles: [__filename, template, path.join(__dirname, 'content-file-metadata.cjs'),
    ...['web-content-io.js', 'web-content-worker.js',
      ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name =>
      path.join(__dirname, name))].map(audit), fullNormalUBTBuildVerified: false,
  completeUEScene: false};
try {
  const buildFile = path.join(directory, `web-engine-full${threads ? '-thread' : ''}-build-results.json`);
  const stageFile = path.join(directory, `${stagePrefix}-stage-results.json`);
  const prepareFile = path.join(directory, `web-project-${id}-prepare-results.json`);
  const build = read(buildFile), stage = read(stageFile), prepared = read(prepareFile);
  assert(build.pass && build.buildSucceeded && build.exitCode === 0 &&
    (build.fullLinkAttempted || threads && build.fullLinkVerified) &&
    build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.log));
  if (threads) {
    assert(build.threads && build.objects.length > 300 && valid(build.linkResponse));
    assert(build.objects.every(item => [item.object, item.response, item.definitions, item.source].every(valid)));
    assert(build.platformCopies.every(item => valid(item.source) && valid(item.copied) &&
      item.source.sha256 === item.copied.sha256));
  }
  assert(stage.pass && stage.scene === 'Project' && stage.projectId === id &&
    stage.sourceFiles.every(valid) && [stage.cookReport, stage.pack, stage.manifest, stage.configBundle].every(valid));
  const cook = read(stage.cookReport.file);
  assert.equal(cook.mode, desktop ? 'WebGPU-SM5' : 'WebGPU-ES31');
  assert.equal(stage.mode, cook.mode);
  assert(cook.pass && cook.sourceFiles.every(valid) && cook.products.every(valid) && cook.hostProducts.every(valid));
  assert(prepared.pass && prepared.originalProjectUnmodified && prepared.sourceFiles.every(valid));
  report.buildReport = audit(buildFile);
  report.stageReport = audit(stageFile);
  report.preparationReport = audit(prepareFile);
  report.map = stage.map;
  report.project = stage.projectName;
  report.textureCompression = cook.textureCompression || 'Uncompressed';
  assert.equal(stage.textureCompression, report.textureCompression);
  fs.mkdirSync(output, {recursive: true});
  let html = fs.readFileSync(template, 'utf8');
  const wasm = build.products.find(item => path.basename(item.file) === runtime + '.wasm');
  const versions = Object.fromEntries([runtime + '.js', runtime + '.wasm', 'web-content-io.js', 'web-content-worker.js',
    ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name => {
    const file = name.startsWith(runtime + '.') ? build.products.find(item => path.basename(item.file) === name).file :
      path.join(__dirname, name);
    return [name, audit(file).sha256];
  }));
  html = html.replace('const localRuntimeAssets = {};', 'const localRuntimeAssets = ' +
    JSON.stringify({versions, renderer: desktop ? 'desktop' : 'mobile', threads, runtime: runtime + '.js',
      wasm: metadata(wasm.file, runtime + '.wasm')}) + ';');
  const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
  assert(html.includes(original) && /^\/Game\/[a-zA-Z0-9_/]+$/.test(stage.map));
  html = html.replace(original, `arguments: ['-webgpu', '-WebProjectMap=${stage.map}'],`)
    .replaceAll('UE 默认关卡', stage.projectName);
  if (report.textureCompression === 'BC') {
    const marker = 'const requiredTextureFeatures = desktopRenderer ?';
    assert(html.includes(marker));
    const end = "['texture-formats-tier1', 'texture-formats-tier2', 'rg11b10ufloat-renderable', 'float32-filterable'] : [];";
    assert(html.includes(end));
    html = html.replace(end,
      "['texture-compression-bc', 'texture-formats-tier1', 'texture-formats-tier2', 'rg11b10ufloat-renderable', 'float32-filterable'] : ['texture-compression-bc'];");
  }
  fs.writeFileSync(path.join(output, 'index.html'), html);
  const copies = [[stage.pack.file, 'content.bin'], [stage.manifest.file, 'content-files.json'],
    [stage.configBundle.file, 'config-files.json'],
    ...['web-content-io.js', 'web-content-worker.js',
      ...(threads ? ['web-engine-host.js', 'web-engine-worker.js'] : [])].map(name =>
      [path.join(__dirname, name), name])];
  for (const name of [runtime + '.js', runtime + '.wasm']) {
    const product = build.products.find(item => path.basename(item.file) === name);
    assert(product && valid(product));
    copies.push([product.file, name]);
  }
  for (const [source, name] of copies) {
    const destination = path.join(output, name);
    fs.copyFileSync(source, destination);
    assert.equal(audit(source).sha256, audit(destination).sha256);
  }
  report.products = ['index.html', ...copies.map(([, name]) => name)].map(name => audit(path.join(output, name)));
  report.totalBytes = report.products.reduce((total, item) => total + fs.statSync(item.file).size, 0);
  report.fullNormalUBTBuildVerified = true;
  report.disabledSkyLight = cook.disabledSkyLight;
  report.compressHDRCubemaps = cook.compressHDRCubemaps || false;
  report.boundary = 'Project map and gameplay with the explicitly recorded Web renderer profile. ' +
    'Packaging success does not prove browser compatibility, visual parity, performance or phone support.';
  report.pass = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(directory, `${prefix}-package-results.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, files: report.products?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
