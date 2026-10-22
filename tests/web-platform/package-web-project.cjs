const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const id = process.argv.find(value => value.startsWith('--project='))?.slice(10);
assert(id && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
const directory = path.join(__dirname, 'results');
const output = path.join(__dirname, 'build', id);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const audit = file => ({file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const valid = item => item?.file && fs.existsSync(item.file) && audit(item.file).sha256 === item.sha256;
const template = path.join(__dirname, 'web-default-template.html');
const report = {date: new Date().toISOString(), pass: false, id, output, architecture: 'wasm64',
  sourceFiles: [__filename, template].map(audit), fullNormalUBTBuildVerified: false,
  completeUEScene: false};
try {
  const buildFile = path.join(directory, 'web-engine-full-build-results.json');
  const stageFile = path.join(directory, `web-project-${id}-stage-results.json`);
  const prepareFile = path.join(directory, `web-project-${id}-prepare-results.json`);
  const build = read(buildFile), stage = read(stageFile), prepared = read(prepareFile);
  assert(build.pass && build.buildSucceeded && build.fullLinkAttempted &&
    build.sourceFiles.every(valid) && build.products.every(valid) && valid(build.log));
  assert(stage.pass && stage.scene === 'Project' && stage.projectId === id &&
    stage.sourceFiles.every(valid) && [stage.cookReport, stage.pack, stage.manifest, stage.configBundle].every(valid));
  const cook = read(stage.cookReport.file);
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
  const original = "arguments: ['-webgpu', '-WebDefaultTemplate'],";
  assert(html.includes(original) && /^\/Game\/[a-zA-Z0-9_/]+$/.test(stage.map));
  html = html.replace(original, `arguments: ['-webgpu', '-WebProjectMap=${stage.map}'],`)
    .replaceAll('UE 默认关卡', stage.projectName);
  if (report.textureCompression === 'BC') {
    const marker = 'const requiredTextureFeatures = [];';
    assert(html.includes(marker));
    html = html.replace(marker, "const requiredTextureFeatures = ['texture-compression-bc'];");
  }
  fs.writeFileSync(path.join(output, 'index.html'), html);
  const copies = [[stage.pack.file, 'content.bin'], [stage.manifest.file, 'content-files.json'],
    [stage.configBundle.file, 'config-files.json']];
  for (const name of ['UEWebEngine.js', 'UEWebEngine.wasm']) {
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
  fs.writeFileSync(path.join(directory, `web-project-${id}-package-results.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({pass: report.pass, output, files: report.products?.length,
    bytes: report.totalBytes, failure: report.failure}, null, 2));
}
